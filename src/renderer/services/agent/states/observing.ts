/**
 * OBSERVING 状态：工具结果裁剪、归档、诊断、检查点与压缩触发。
 */

import { state } from '../../../state/state.js';
import type { ChatSession, LoopContext, OllamaMessage } from '../../../types.js';
import { logInfo, logWarn } from '../../log-service.js';
import { getEffectiveNumCtx } from '../../../components/model-bar.js';
import {
  calculateContextStats,
  recordTokenUsage,
  mergeConsecutiveMessages,
  generateTokenReport,
  formatTokenReport,
  createCheckpoint,
} from '../../context-manager.js';
import {
  compactOldToolResult,
  collectDiagnostics,
  formatDiagnosticsReport,
  smartTruncateByToolType,
} from '../../agent-safety.js';
import { recordIteration } from '../../agent-metrics.js';
import { executeHooks } from '../../hooks.js';
import { isAborted } from '../runtime.js';
import { S, transition } from '../state.js';

export async function handleObserving(ctx: LoopContext, _currentSession: ChatSession | null): Promise<void> {
  if (isAborted()) return;
  const numCtx = getEffectiveNumCtx();
  let ctxStats = calculateContextStats(ctx.messages, numCtx);
  const pressureInfo = ctxStats.pressureInfo;

  {
    const maxToolMsgs =
      pressureInfo.level === 'critical' ? 30 : pressureInfo.level === 'high' ? 40 : pressureInfo.level === 'medium' ? 60 : 80;
    const toolIndices: number[] = [];
    for (let i = 0; i < ctx.messages.length; i++) {
      if (ctx.messages[i].role === 'tool') toolIndices.push(i);
    }
    if (toolIndices.length > maxToolMsgs) {
      const toRemoveToolIndices = new Set(toolIndices.slice(0, toolIndices.length - maxToolMsgs));
      const toRemove = new Set<number>(toRemoveToolIndices);
      const toStripToolCalls = new Set<number>();

      for (let i = 0; i < ctx.messages.length; i++) {
        const msg = ctx.messages[i];
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
          const followingToolIndices: number[] = [];
          for (let j = i + 1; j < ctx.messages.length && ctx.messages[j].role === 'tool'; j++) {
            followingToolIndices.push(j);
          }
          if (followingToolIndices.length === 0) continue;
          const removedCount = followingToolIndices.filter((idx) => toRemoveToolIndices.has(idx)).length;
          const allRemoved = removedCount === followingToolIndices.length;
          const someRemoved = removedCount > 0 && !allRemoved;
          if (allRemoved) {
            if (msg.content && msg.content.trim()) toStripToolCalls.add(i);
            else toRemove.add(i);
          } else if (someRemoved) {
            toStripToolCalls.add(i);
          }
        }
      }

      for (const idx of toStripToolCalls) {
        const msg = ctx.messages[idx];
        const newMsg: OllamaMessage = { ...msg };
        delete newMsg.tool_calls;
        ctx.messages[idx] = newMsg;
      }

      if (toRemove.size > 0) ctx.messages = ctx.messages.filter((_, idx) => !toRemove.has(idx));

      logInfo(
        `R91: 工具消息裁剪: ${toRemoveToolIndices.size} 条旧 tool 结果已移除, ${toRemove.size - toRemoveToolIndices.size} 条空 assistant 删除, ${toStripToolCalls.size} 条 assistant 移除 tool_calls (压力:${pressureInfo.level}, 保留上限 ${maxToolMsgs} 条)`,
      );
    }
  }

  ctx.prevToolCalls = [...ctx.toolCalls];

  ctxStats = calculateContextStats(ctx.messages, numCtx);
  recordTokenUsage(ctxStats.contentTokens, numCtx);

  if (ctxStats.compressDecision.shouldCompress && ctxStats.compressDecision.urgency === 'high') {
    logWarn(`R53: 主动压缩触发 — ${ctxStats.compressDecision.reason}`);
    transition(ctx, S.COMPRESSING);
    return;
  }

  if (ctx.loopCount > 5 && ctx.loopCount % 3 === 0) {
    const compactBefore = ctx.messages.length - 10;
    let compactedCount = 0;
    for (let i = 0; i < ctx.messages.length && i < compactBefore; i++) {
      const m = ctx.messages[i];
      if (m.role === 'tool' && m.content && m.content.length > 1500 && !m.content.startsWith('[工具结果已归档]')) {
        ctx.messages[i] = compactOldToolResult(m);
        compactedCount++;
      }
    }
    if (compactedCount > 0) logInfo(`R51: 工具结果归档: ${compactedCount} 条旧结果已精简为引用`);
  }

  if (ctx.loopCount > 0 && ctx.loopCount % 15 === 0) {
    try {
      const diag = collectDiagnostics();
      logInfo('R112: 诊断报告\n' + formatDiagnosticsReport(diag));
      const tokenReport = generateTokenReport(getEffectiveNumCtx());
      logInfo('R100: ' + formatTokenReport(tokenReport));
    } catch {
      /* 诊断失败不影响主流程 */
    }
  }

  if (ctx.loopCount > 0 && ctx.loopCount % 20 === 0) {
    try {
      const taskGoal =
        state.get<string>('_lastUserMessage', '') || ctx.messages.find((m) => m.role === 'user')?.content || '';
      createCheckpoint(ctx.loopCount, ctx.state, ctx.messages, ctx.allToolRecords.length, taskGoal.slice(0, 200));
    } catch {
      /* 检查点创建失败不影响主流程 */
    }
  }

  recordIteration(ctx);
  executeHooks('post_iteration', ctx, { iterationIndex: ctx.loopCount }).catch((err) =>
    logWarn('post_iteration hook 异常', String(err)),
  );

  if (ctx.loopCount > 10 && ctx.loopCount % 5 === 0) {
    if (pressureInfo.level === 'high' || pressureInfo.level === 'critical') {
      const maxLen = pressureInfo.level === 'critical' ? 3000 : 5000;
      const truncateBefore = ctx.messages.length - 15;
      let truncatedCount = 0;
      for (let i = 0; i < ctx.messages.length && i < truncateBefore; i++) {
        const m = ctx.messages[i];
        if (m.role === 'tool' && m.content && m.content.length > maxLen) {
          ctx.messages[i] = {
            ...m,
            content: smartTruncateByToolType(m.tool_name || 'unknown', m.content, maxLen),
          };
          truncatedCount++;
        }
      }
      if (truncatedCount > 0) {
        logInfo(`R95: 工具结果按类型截断: ${truncatedCount} 条, 压力 ${pressureInfo.level}, 阈值 ${maxLen} 字符`);
      }
    }
  }

  if (ctx.loopCount > 1 && ctx.loopCount % 10 === 0) {
    if (ctxStats.usageRatio > 0.7) {
      logInfo(`ephemeral 清理跳过: 上下文使用率 ${(ctxStats.usageRatio * 100).toFixed(0)}%, 压缩即将触发`);
    } else {
      const PRESERVE_PATTERNS = [/系统提示.*连续.*轮调用相同的工具/];
      let removed = 0;
      ctx.messages = ctx.messages.filter((m) => {
        if (m.ephemeral) {
          if (PRESERVE_PATTERNS.some((p) => p.test(m.content || ''))) return true;
          removed++;
          return false;
        }
        return true;
      });
      if (removed > 0) logInfo(`ephemeral 清理: ${removed} 条临时消息已移除`);
    }
  }

  if (pressureInfo.level === 'medium' || pressureInfo.level === 'high') {
    ctx.messages = mergeConsecutiveMessages(ctx.messages);
  }

  if (ctxStats.compressDecision.shouldCompress) {
    logWarn(`R98: 压缩触发 (${ctxStats.compressDecision.urgency}) — ${ctxStats.compressDecision.reason}`);
    transition(ctx, S.COMPRESSING);
    return;
  }

  transition(ctx, S.REFLECTING);
}
