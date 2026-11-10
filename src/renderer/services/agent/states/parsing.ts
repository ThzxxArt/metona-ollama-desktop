/**
 * PARSING 状态：保存 assistant 消息、文本工具调用兜底。
 */

import type { LoopContext, OllamaMessage } from '../../../types.js';
import { logModelResponse } from '../../log-service.js';
import { getEnabledToolDefinitions } from '../../tool-registry.js';
import { parseToolCallsFromText } from '../../tool-parsing.js';
import { S, transition } from '../state.js';

export async function handleParsing(ctx: LoopContext): Promise<void> {
  const hasThinking = !!ctx.thinking && ctx.thinking.trim().length > 0;
  const hasContent = !!ctx.content && ctx.content.trim().length > 0;
  const fallbackContent = !hasContent && hasThinking ? `[推理过程] ${ctx.thinking!.trim()}` : ctx.content;

  const assistantMsg: OllamaMessage = {
    role: 'assistant',
    content: fallbackContent,
    ...(hasThinking && { thinking: ctx.thinking }),
  };
  if (ctx.toolCalls.length > 0) assistantMsg.tool_calls = ctx.toolCalls;
  ctx.messages.push(assistantMsg);

  logModelResponse(ctx.content.length, ctx.toolCalls.length);

  if (ctx.toolCalls.length === 0 && getEnabledToolDefinitions().length > 0) {
    const parsedCalls = parseToolCallsFromText(ctx.content);
    if (parsedCalls.length > 0) ctx.toolCalls.push(...parsedCalls);
  }

  if (ctx.toolCalls.length > 0) transition(ctx, S.EXECUTING);
  else transition(ctx, S.REFLECTING);
}
