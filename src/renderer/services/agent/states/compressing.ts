/**
 * COMPRESSING 状态：自适应压缩策略（fast / medium / llm）。
 */

import type { OllamaAPI } from '../../../api/ollama.js';
import type { LoopContext } from '../../../types.js';
import { state, KEYS } from '../../../state/state.js';
import { getEffectiveNumCtx } from '../../../components/model-bar.js';
import { logInfo, logWarn, logSuccess } from '../../log-service.js';
import { compactOldToolResult } from '../../agent-safety.js';
import {
  compressWithLLM,
  estimateTokens,
  getContextPressureLevel,
  chooseCompressionStrategy,
  mergeConsecutiveMessages,
} from '../../context-manager.js';
import { isAborted } from '../runtime.js';
import { S, transition } from '../state.js';

export async function handleCompressing(ctx: LoopContext, api: OllamaAPI, model: string): Promise<void> {
  const numCtx = getEffectiveNumCtx();
  if (isAborted()) {
    transition(ctx, S.REFLECTING);
    return;
  }

  const pressureInfo = getContextPressureLevel(ctx.messages, numCtx);
  const decision = chooseCompressionStrategy(ctx.messages, numCtx, pressureInfo.level);
  logInfo(`COMPRESSING: 上下文压缩触发 — 策略=${decision.strategy}, 原因=${decision.reason}`);

  if (decision.strategy === 'skip') {
    logInfo('COMPRESSING: 跳过压缩（上下文压力低）');
  } else if (decision.strategy === 'fast' || decision.strategy === 'medium') {
    const beforeLen = ctx.messages.length;
    const beforeTokens = estimateTokens(ctx.messages.map((m) => m.content || '').join(''));
    if (decision.strategy === 'fast') {
      ctx.messages = ctx.messages.map((m) => compactOldToolResult(m));
    }
    ctx.messages = mergeConsecutiveMessages(ctx.messages);
    const afterLen = ctx.messages.length;
    const afterTokens = estimateTokens(ctx.messages.map((m) => m.content || '').join(''));
    if (afterLen < beforeLen || afterTokens < beforeTokens) {
      logSuccess(
        `COMPRESSING: ${decision.strategy}压缩完成 — ${beforeLen}→${afterLen} 条, ${beforeTokens}→${afterTokens} tokens`,
      );
    } else {
      logInfo('COMPRESSING: 快速压缩未产生效果，保留原消息');
    }
  } else {
    const compressAC = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER) || new AbortController();
    try {
      const compressed = await compressWithLLM(ctx.messages, api, model, { abortController: compressAC });
      const beforeTokens = estimateTokens(ctx.messages.map((m) => m.content || '').join(''));
      const afterTokens = estimateTokens(compressed.map((m) => m.content || '').join(''));
      if (compressed.length < ctx.messages.length && afterTokens < beforeTokens) {
        ctx.messages.length = 0;
        ctx.messages.push(...compressed);
        logSuccess('COMPRESSING: LLM 压缩完成');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      logWarn('COMPRESSING: LLM 压缩失败，回退到快速压缩', (err as Error).message);
      ctx.messages = mergeConsecutiveMessages(ctx.messages);
    }
  }

  if (ctx.toolCalls.length === 0 && !ctx.content.trim()) {
    transition(ctx, S.THINKING);
  } else {
    transition(ctx, S.REFLECTING);
  }
}
