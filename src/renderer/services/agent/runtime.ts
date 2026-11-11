/**
 * Agent 运行时：AbortController 生命周期与 LoopContext 快照。
 */

import { state, KEYS } from '../../state/state.js';
import type { LoopContext } from '../../types.js';

export function registerAbortController(): AbortController {
  const old = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER);
  if (old) {
    try {
      old.abort();
    } catch {
      /* ignore */
    }
  }
  const ac = new AbortController();
  state.set(KEYS.ABORT_CONTROLLER, ac);
  return ac;
}

export function isAborted(): boolean {
  return state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted === true;
}

export function cleanupAbortController(): void {
  const ac = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER);
  if (ac) {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
    state.set(KEYS.ABORT_CONTROLLER, null);
  }
}

export const pendingMemoryTimers: ReturnType<typeof setTimeout>[] = [];
const pendingMemoryControllers: AbortController[] = [];

/**
 * 安排一次延迟记忆提取。
 *
 * 不能直接复用主 Agent 的 AbortController：主循环结束时 cleanupAbortController()
 * 会中止它，导致正常完成后的记忆提取永远被取消。这里使用独立 controller，
 * 在新一轮 runAgentLoop 开始时由 clearPendingMemoryTimers() 统一中止，避免旧会话
 * 的提取污染新会话。
 */
export function scheduleMemoryExtraction(callback: (signal: AbortSignal) => void, delayMs = 500): void {
  const controller = new AbortController();
  pendingMemoryControllers.push(controller);
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    callback(controller.signal);
  }, delayMs);
  pendingMemoryTimers.push(timer);
}

export function clearPendingMemoryTimers(): void {
  while (pendingMemoryTimers.length > 0) {
    const timer = pendingMemoryTimers.pop();
    if (timer) clearTimeout(timer);
  }
  while (pendingMemoryControllers.length > 0) {
    pendingMemoryControllers.pop()?.abort();
  }
}

export function snapshotLoopContext(ctx: LoopContext): void {
  const snapshotState = isAborted() ? 'TERMINATED' : ctx.state;
  state.set('_loopContext', {
    sessionId: ctx.sessionId,
    loopCount: ctx.loopCount,
    maxLoops: ctx.maxLoops,
    totalEvalCount: ctx.totalEvalCount,
    totalPromptEvalCount: ctx.totalPromptEvalCount,
    allToolRecords: ctx.allToolRecords,
    startTime: ctx.startTime,
    state: snapshotState,
    emergencyCompressCount: ctx.emergencyCompressCount,
    compressedThisCycle: ctx.compressedThisCycle,
    messageCount: ctx.messages.length,
  });
}
