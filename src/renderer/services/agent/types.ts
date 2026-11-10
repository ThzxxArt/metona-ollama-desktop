/** Agent 公共回调与统计类型。 */

import type { ToolCall, ToolResult, ToolCallRecord } from '../../types.js';

export interface AgentCallbacks {
  onThinking: (text: string) => void;
  onContent: (text: string) => void;
  onToolCallPrepare?: (call: ToolCall) => void;
  onToolCallStart: (call: ToolCall) => void;
  onToolCallResult: (name: string, result: ToolResult, call: ToolCall) => void;
  onToolCallError: (name: string, error: string, call: ToolCall) => void;
  onDone: (
    finalContent: string,
    toolRecords?: ToolCallRecord[],
    stats?: {
      eval_count?: number;
      prompt_eval_count?: number;
      prompt_eval_cached_count?: number;
      done_reason?: string;
      total_duration?: number;
      ctx_tokens?: number;
    },
  ) => void;
  onConfirmTool: (call: ToolCall) => Promise<boolean>;
  onNewIteration?: (
    toolCalls?: ToolCall[],
    stats?: { eval_count?: number; prompt_eval_count?: number; total_duration?: number },
  ) => void;
  onThinkingStart?: () => void;
}

export interface AgentStats {
  eval_count?: number;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  done_reason?: string;
  total_duration?: number;
  ctx_tokens?: number;
}
