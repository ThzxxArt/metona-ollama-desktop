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

export function clearPendingMemoryTimers(): void {
  while (pendingMemoryTimers.length > 0) {
    const timer = pendingMemoryTimers.pop();
    if (timer) clearTimeout(timer);
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
