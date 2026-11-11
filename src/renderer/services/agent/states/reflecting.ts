/**
 * REFLECTING 状态：工具循环继续/终止、记忆提取。
 */

import { state, KEYS } from '../../../state/state.js';
import type { OllamaAPI } from '../../../api/ollama.js';
import type { ChatSession, LoopContext } from '../../../types.js';
import { logInfo, logWarn } from '../../log-service.js';
import { executeHooks } from '../../hooks.js';
import { isAborted, pendingMemoryTimers } from '../runtime.js';
import { S, transition } from '../state.js';
import { makeStats } from '../stats.js';
import type { AgentCallbacks } from '../types.js';

export async function handleReflecting(
  ctx: LoopContext,
  callbacks: AgentCallbacks,
  _currentSession: ChatSession | null,
): Promise<void> {
  if (isAborted()) return;

  if (ctx.loopCount >= ctx.maxLoops) {
    logWarn('ReAct Agent Loop 达到最大迭代次数限制');
    callbacks.onDone(ctx.content || '（达到最大工具调用次数限制）', ctx.allToolRecords, makeStats(ctx));
    transition(ctx, S.TERMINATED);
    return;
  }

  if (ctx.toolCalls.length > 0) {
    transition(ctx, S.THINKING);
    return;
  }

  try {
    const hookResult = await executeHooks('pre_completion', ctx);
    if (!hookResult.allPassed) {
      const reasons = hookResult.results
        .filter((r) => !r.passed)
        .map((r) => r.message)
        .join('; ');
      logWarn(`pre_completion Hook 提示: ${reasons}`);
    }
  } catch {
    /* Hook 异常不影响主流程 */
  }

  logInfo('模型停止工具调用 → ReAct Agent Loop 结束');

  const memorySignal = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal;
  if (!memorySignal?.aborted) {
    const api = state.get<OllamaAPI>(KEYS.API);
    const model = state.get<string>('_defaultModel', '');
    const session = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
    const msgsForMemory = (session?.messages || ctx.messages)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content || '' }));
    const memTimer = setTimeout(() => {
      if (memorySignal?.aborted) return;
      import('../../memory-service.js')
        .then(({ extractAndSaveMemories }) => {
          extractAndSaveMemories(msgsForMemory, api, model, memorySignal).catch(() => {});
        })
        .catch(() => {});
    }, 500);
    pendingMemoryTimers.push(memTimer);
  }

  callbacks.onDone(
    ctx.content || '（模型未返回内容）',
    ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined,
    makeStats(ctx),
  );
  transition(ctx, S.TERMINATED);
}
