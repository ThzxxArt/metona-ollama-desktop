/**
 * THINKING 状态：Ollama 流式调用、超时、重试、token 统计。
 */

import type { OllamaStreamChunk, LoopContext } from '../../types.js';
import type { OllamaAPI } from '../../api/ollama.js';
import { state } from '../../state/state.js';
import { getEffectiveNumCtx } from '../../components/model-bar.js';
import {
  logInfo,
  logWarn,
  logSuccess,
  logError,
  logAgentLoop,
  logStreamProgress,
  resetStreamProgress,
} from '../log-service.js';
import { compressWithLLM, estimateTokens, recordActualTokens, recordBudgetUsage } from '../context-manager.js';
import { registerAbortController } from './runtime.js';
import { S, transition, API_MAX_RETRIES, getFilteredTools } from './state.js';
import { makeStats } from './stats.js';
import { getThinkLevel } from './prompt.js';
import type { AgentCallbacks } from './types.js';

export async function handleThinking(
  ctx: LoopContext,
  api: OllamaAPI,
  model: string,
  callbacks: AgentCallbacks,
): Promise<void> {
  ctx.loopCount++;
  logAgentLoop(ctx.loopCount, ctx.maxLoops);
  ctx.compressedThisCycle = false;
  ctx.content = '';
  ctx.thinking = '';
  ctx.toolCalls.length = 0;
  // 每轮必须重置上一轮遗留的统计字段，否则某轮没有返回 cached_count / done_reason 时
  // 会把上一轮的值当作本轮值展示给 Token 仪表盘。
  ctx.loopCachedCount = 0;
  ctx.doneReason = '';

  const abortController = registerAbortController();

  const baseTimeout = state.get<number>('streamTimeout', 0);
  const numCtxForTimeout = getEffectiveNumCtx();
  let STREAM_TIMEOUT_MS: number;
  if (baseTimeout === 0) STREAM_TIMEOUT_MS = 0;
  else if (baseTimeout > 0) STREAM_TIMEOUT_MS = Math.min(baseTimeout, 600_000);
  else {
    const dynamicTimeout = Math.max(120_000, 120_000 + Math.floor(numCtxForTimeout / 1000) * 500);
    STREAM_TIMEOUT_MS = Math.min(dynamicTimeout, 600_000);
  }

  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (STREAM_TIMEOUT_MS > 0) {
    totalTimer = setTimeout(() => {
      timedOut = true;
      logWarn(`流式总超时 (${STREAM_TIMEOUT_MS / 1000}s)，中止本轮`);
      abortController.abort();
    }, STREAM_TIMEOUT_MS);
  }

  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let apiRetrySuccess = false;
  let apiLastErr: Error | null = null;
  let bestPartialContent = '';
  let bestPartialThinking = '';

  for (let apiAttempt = 0; apiAttempt <= API_MAX_RETRIES; apiAttempt++) {
    if (apiAttempt > 0) {
      if (ctx.content.length > bestPartialContent.length) {
        bestPartialContent = ctx.content;
        bestPartialThinking = ctx.thinking;
      }
      ctx.content = '';
      ctx.thinking = '';
      ctx.toolCalls.length = 0;
      ctx.loopCachedCount = 0;
      ctx.doneReason = '';
      const retryDelay = 1000 * Math.pow(2, apiAttempt - 1);
      logWarn(`API 重试 ${apiAttempt}/${API_MAX_RETRIES}: 等待 ${retryDelay}ms 后重试`, apiLastErr?.message || '');
      await new Promise((r) => setTimeout(r, retryDelay));
    }

    const retryAC = apiAttempt > 0 ? registerAbortController() : abortController;

    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
    if (STREAM_TIMEOUT_MS > 0) {
      timedOut = false;
      totalTimer = setTimeout(() => {
        timedOut = true;
        logWarn(`流式总超时 (${STREAM_TIMEOUT_MS / 1000}s)，中止本轮`);
        retryAC.abort();
      }, STREAM_TIMEOUT_MS);
    }

    try {
      const streamStartTime = Date.now();
      let lastLoggedLen = 0;
      let lastContentTime = streamStartTime;

      resetStreamProgress();
      callbacks.onThinkingStart?.();

      if (progressTimer) clearInterval(progressTimer as unknown as number);
      progressTimer = setInterval(() => {
        const elapsed = Date.now() - streamStartTime;
        const grew = ctx.content.length - lastLoggedLen;
        const sec = Math.round(elapsed / 1000);
        if (grew > 0) {
          lastLoggedLen = ctx.content.length;
          lastContentTime = Date.now();
          logStreamProgress(
            `流式输出中… ${ctx.content.length} 字 / ${sec}s${ctx.toolCalls.length > 0 ? ` [${ctx.toolCalls.length} 个工具调用]` : ''}`,
          );
        } else if (ctx.content.length > 0) {
          const idleSec = Math.round((Date.now() - lastContentTime) / 1000);
          if (idleSec >= 10) logStreamProgress(`⚠️ ${idleSec}s 无新内容，当前 ${ctx.content.length} 字`);
        } else {
          logStreamProgress(`⏳ 等待模型响应… ${sec}s`);
        }
      }, 15000);

      const filteredTools = getFilteredTools();
      await api.chatStream(
        {
          model,
          messages: ctx.messages,
          sessionId: ctx.sessionId,
          stream: true,
          think: getThinkLevel(),
          options: { num_ctx: getEffectiveNumCtx() },
          ...(filteredTools.length > 0 && { tools: filteredTools }),
        },
        (chunk: OllamaStreamChunk) => {
          if (chunk.message?.thinking) {
            ctx.thinking += chunk.message.thinking;
            callbacks.onThinking(ctx.thinking);
          }
          if (chunk.message?.content) {
            ctx.content += chunk.message.content;
            callbacks.onContent(ctx.content);
          }
          if (chunk.eval_count) ctx.loopEvalCount = chunk.eval_count;
          if (chunk.prompt_eval_count) ctx.loopPromptEvalCount = chunk.prompt_eval_count;
          if (chunk.prompt_eval_cached_count) ctx.loopCachedCount = chunk.prompt_eval_cached_count;
          if (chunk.done_reason) ctx.doneReason = chunk.done_reason;
          if (chunk.total_duration) ctx.loopInferenceNs = chunk.total_duration;
          if (chunk.message?.tool_calls?.length) {
            for (const tc of chunk.message.tool_calls) {
              if (tc.function?.name) {
                let parsedArgs: Record<string, unknown> = {};
                if (tc.function.arguments) {
                  if (typeof tc.function.arguments === 'string') {
                    try {
                      parsedArgs = JSON.parse(tc.function.arguments);
                    } catch {
                      parsedArgs = {};
                    }
                  } else if (typeof tc.function.arguments === 'object') {
                    parsedArgs = tc.function.arguments as Record<string, unknown>;
                  }
                }
                const isNewTool = !ctx.toolCalls.some((existing) => existing.function.name === tc.function.name);
                if (isNewTool && callbacks.onToolCallPrepare) {
                  callbacks.onToolCallPrepare({
                    type: 'function',
                    function: { name: tc.function.name, arguments: parsedArgs },
                  });
                }
                ctx.toolCalls.push({
                  type: 'function',
                  function: { name: tc.function.name, arguments: parsedArgs },
                });
              } else if (ctx.toolCalls.length > 0) {
                const last = ctx.toolCalls[ctx.toolCalls.length - 1];
                if (tc.function?.arguments) {
                  let chunkArgs: Record<string, unknown> | null = null;
                  if (typeof tc.function.arguments === 'string') {
                    try {
                      chunkArgs = JSON.parse(tc.function.arguments);
                    } catch {
                      /* ignore */
                    }
                  } else if (typeof tc.function.arguments === 'object') {
                    chunkArgs = tc.function.arguments as Record<string, unknown>;
                  }
                  if (chunkArgs) Object.assign(last.function.arguments, chunkArgs);
                }
              }
            }
          }
        },
        retryAC,
      );

      apiRetrySuccess = true;
      break;
    } catch (err) {
      if (totalTimer) {
        clearTimeout(totalTimer);
        totalTimer = null;
      }
      if (progressTimer) clearInterval(progressTimer as unknown as number);

      const isAbort = retryAC.signal.aborted;

      // 只有计时器真正触发才算超时；配置了 streamTimeout 时用户主动停止
      // 不能被误判为超时并进入 1s/2s 重试。
      if (isAbort && !timedOut) {
        logInfo('流式调用已中止（用户操作）');
        if (ctx.allToolRecords.length > 0) state.set('_abortToolRecords', ctx.allToolRecords);
        throw err;
      }

      apiLastErr = err as Error;
      const MAX_EMERGENCY_COMPRESS = 2;
      const errMsg = apiLastErr.message || '';
      const isContextOverflow =
        /context.*length|prompt.*too.*long|context.*window|maximum.*context|num_ctx|上下文.*超/i.test(errMsg);
      if (isContextOverflow && ctx.messages.length > 10 && ctx.emergencyCompressCount < MAX_EMERGENCY_COMPRESS) {
        ctx.emergencyCompressCount++;
        logWarn(
          `R8: 检测到上下文溢出错误，触发紧急压缩 (${ctx.emergencyCompressCount}/${MAX_EMERGENCY_COMPRESS})`,
          errMsg.slice(0, 100),
        );
        try {
          const compressAC = new AbortController();
          const compressed = await compressWithLLM(ctx.messages, api, model, { abortController: compressAC });
          const beforeTokens = estimateTokens(ctx.messages.map((m) => m.content || '').join(''));
          const afterTokens = estimateTokens(compressed.map((m) => m.content || '').join(''));
          if (compressed.length < ctx.messages.length && afterTokens < beforeTokens) {
            ctx.messages.length = 0;
            ctx.messages.push(...compressed);
            logSuccess(`R8: 紧急压缩完成，剩余 ${ctx.messages.length} 条消息`);
            apiAttempt--;
            continue;
          }
        } catch (compressErr) {
          logWarn('R8: 紧急压缩失败', (compressErr as Error).message);
        }
      } else if (isContextOverflow && ctx.emergencyCompressCount >= MAX_EMERGENCY_COMPRESS) {
        logWarn(`R8: 紧急压缩已达上限 (${MAX_EMERGENCY_COMPRESS})，不再重试`);
      }

      if (apiAttempt < API_MAX_RETRIES) {
        logWarn(`流式调用异常 (尝试 ${apiAttempt + 1}/${API_MAX_RETRIES + 1})`, apiLastErr.message);
        continue;
      }
    }
  }

  if (totalTimer) {
    clearTimeout(totalTimer);
    totalTimer = null;
  }
  if (progressTimer) clearInterval(progressTimer as unknown as number);

  if (!apiRetrySuccess) {
    logError('流式调用异常（已达最大重试）', apiLastErr?.message || '未知错误');
    if (!ctx.content && bestPartialContent) {
      ctx.content = bestPartialContent;
      ctx.thinking = bestPartialThinking || ctx.thinking;
      logInfo(`R4: 使用最佳部分内容 (${bestPartialContent.length} 字) 作为回退`);
    }
    if (ctx.content || ctx.thinking) {
      ctx.messages.push({
        role: 'assistant',
        content: ctx.content || '（模型响应异常）',
        ...(ctx.thinking && { thinking: ctx.thinking }),
      });
    }
    callbacks.onDone(
      ctx.content || '（模型响应异常，已自动中断）',
      ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined,
      makeStats(ctx),
    );
    transition(ctx, S.TERMINATED);
    return;
  }

  ctx.lastLoopStats = {
    eval_count: ctx.loopEvalCount || undefined,
    prompt_eval_count: ctx.loopPromptEvalCount || undefined,
    total_duration: ctx.loopInferenceNs || undefined,
  };

  ctx.totalEvalCount += ctx.loopEvalCount;
  ctx.totalPromptEvalCount += ctx.loopPromptEvalCount;
  ctx.totalInferenceNs += ctx.loopInferenceNs;
  state.set('_currentEvalCount', ctx.totalEvalCount);

  try {
    if (ctx.loopEvalCount > 0 || ctx.loopPromptEvalCount > 0) {
      const estimatedThisLoop = estimateTokens(ctx.messages.map((m) => m.content || '').join(''));
      if (estimatedThisLoop > 0) {
        recordActualTokens(ctx.loopPromptEvalCount, ctx.loopEvalCount, estimatedThisLoop, model);
      }
      recordBudgetUsage(ctx.loopCount, ctx.loopPromptEvalCount, ctx.loopEvalCount, estimatedThisLoop);
    }
  } catch {
    /* ignore */
  }

  ctx.loopEvalCount = 0;
  ctx.loopPromptEvalCount = 0;
  ctx.loopInferenceNs = 0;

  transition(ctx, S.PARSING);
}
