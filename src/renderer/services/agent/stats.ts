/**
 * Agent 统计快照。
 */

import { estimateTokens } from '../context-manager.js';
import type { LoopContext } from '../../types.js';

export function makeStats(ctx: LoopContext) {
  let ctxTokens: number;
  if (ctx.loopPromptEvalCount > 0) {
    ctxTokens = ctx.loopPromptEvalCount;
  } else {
    ctxTokens = ctx.messages.reduce((sum, m) => {
      let t = estimateTokens(m.content || '');
      if (m.tool_calls?.length) t += m.tool_calls.length * 50;
      if (m.images?.length) t += m.images.length * 100;
      return sum + t;
    }, 0);
  }
  return {
    eval_count: ctx.lastLoopStats?.eval_count || undefined,
    prompt_eval_count: ctx.lastLoopStats?.prompt_eval_count || undefined,
    prompt_eval_cached_count: ctx.loopCachedCount || undefined,
    done_reason: ctx.doneReason || undefined,
    total_duration: ctx.lastLoopStats?.total_duration || undefined,
    ctx_tokens: ctxTokens,
  };
}
