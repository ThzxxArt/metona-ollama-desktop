/**
 * Agent 状态机常量、转换与共享运行时状态。
 */

import { state } from '../../state/state.js';
import { logWarn } from '../log-service.js';
import type { LoopState, LoopContext, ToolDefinition } from '../../types.js';

export const MAX_RETRIES = 2;
export const MAX_MESSAGES = 300;
export const API_MAX_RETRIES = 2;
export const MAX_PARALLEL_TOOLS = 5;

export const S = {
  INIT: 'INIT' as LoopState,
  THINKING: 'THINKING' as LoopState,
  PARSING: 'PARSING' as LoopState,
  EXECUTING: 'EXECUTING' as LoopState,
  OBSERVING: 'OBSERVING' as LoopState,
  REFLECTING: 'REFLECTING' as LoopState,
  COMPRESSING: 'COMPRESSING' as LoopState,
  TERMINATED: 'TERMINATED' as LoopState,
} as const;

export function getValidTransitions(current: LoopState): LoopState[] {
  switch (current) {
    case 'INIT':
      return ['THINKING', 'TERMINATED'];
    case 'THINKING':
      return ['PARSING', 'COMPRESSING', 'TERMINATED'];
    case 'PARSING':
      return ['EXECUTING', 'REFLECTING', 'THINKING', 'COMPRESSING', 'TERMINATED'];
    case 'EXECUTING':
      return ['OBSERVING', 'THINKING', 'COMPRESSING', 'TERMINATED'];
    case 'OBSERVING':
      return ['COMPRESSING', 'REFLECTING', 'THINKING', 'TERMINATED'];
    case 'REFLECTING':
      return ['THINKING', 'COMPRESSING', 'TERMINATED'];
    case 'COMPRESSING':
      return ['THINKING', 'REFLECTING', 'TERMINATED'];
    case 'TERMINATED':
      return [];
    default:
      return ['THINKING', 'TERMINATED'];
  }
}

export function transition(ctx: LoopContext, newState: LoopState): void {
  const allowed = getValidTransitions(ctx.state);
  if (!allowed.includes(newState)) {
    logWarn(`非法的状态转换: ${ctx.state} → ${newState}（允许: ${allowed.join(', ')}）`);
    if (newState === S.TERMINATED) {
      ctx.state = S.TERMINATED;
      state.set('_loopState', ctx.state);
    }
    return;
  }
  ctx.state = newState;
  state.set('_loopState', ctx.state);
}

let _filteredTools: ToolDefinition[] = [];

export function getFilteredTools(): ToolDefinition[] {
  return _filteredTools;
}

export function setFilteredTools(tools: ToolDefinition[]): void {
  _filteredTools = tools;
}
