/**
 * Agent Engine - Agent Loop 核心引擎
 * 管理带工具调用的流式对话循环
 */

import { OllamaAPI } from '../api/ollama.js';
import { state, KEYS } from '../state/state.js';
import {
  executeTool,
  getEnabledToolDefinitions,
  needsConfirmation
} from './tool-registry.js';
import { searchMemories, buildMemoryContext, markMemoryUsed, isMemoryEnabled } from './memory-manager.js';
import { showToast } from '../components/toast.js';
import type {
  OllamaMessage,
  OllamaStreamChunk,
  ToolCall,
  ToolResult,
  ToolCallRecord
} from '../types.js';

export interface AgentCallbacks {
  onThinking: (text: string) => void;
  onContent: (text: string) => void;
  onToolCallStart: (call: ToolCall) => void;
  onToolCallResult: (name: string, result: ToolResult, call: ToolCall) => void;
  onToolCallError: (name: string, error: string, call: ToolCall) => void;
  onDone: (finalContent: string, toolRecords?: ToolCallRecord[]) => void;
  onConfirmTool: (call: ToolCall) => Promise<boolean>;
}

export async function runAgentLoop(
  userContent: string,
  images: string[],
  historyMessages: Array<{ role: string; content: string; images?: string[] }>,
  callbacks: AgentCallbacks
): Promise<void> {
  const api = state.get<OllamaAPI>(KEYS.API);
  const model = state.get<string>('_defaultModel', '');

  if (!api || !model) {
    showToast('请先选择模型', 'error');
    return;
  }

  const messages: OllamaMessage[] = [];

  let systemPromptParts: string[] = [];

  if (state.get<boolean>(KEYS.SYSTEM_PROMPT_ENABLED)) {
    const systemPrompt = state.get<string>(KEYS.SYSTEM_PROMPT, '');
    if (systemPrompt) systemPromptParts.push(systemPrompt);
  }

  // 注入记忆上下文
  if (isMemoryEnabled() && userContent) {
    const relevantMemories = searchMemories(userContent, 6);
    if (relevantMemories.length > 0) {
      systemPromptParts.push(buildMemoryContext(relevantMemories));
      for (const m of relevantMemories) {
        await markMemoryUsed(m.id);
      }
    }
  }

  if (systemPromptParts.length > 0) {
    messages.push({ role: 'system', content: systemPromptParts.join('\n\n') });
  }

  for (const msg of historyMessages) {
    messages.push({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
      ...(msg.images?.length && { images: msg.images })
    });
  }

  const userMsg: OllamaMessage = { role: 'user', content: userContent };
  if (images?.length) userMsg.images = images;
  messages.push(userMsg);

  const tools = getEnabledToolDefinitions();
  const useTools = tools.length > 0;

  let loopCount = 0;
  const maxLoops = 10;
  const allToolRecords: ToolCallRecord[] = [];
  const loopStartTime = Date.now();
  const MAX_LOOP_TIME = 300000; // 5分钟总超时

  while (loopCount < maxLoops) {
    loopCount++;

    // 全局超时检查
    if (Date.now() - loopStartTime > MAX_LOOP_TIME) {
      console.warn('[AgentEngine] 达到最大运行时间（5分钟），自动停止');
      callbacks.onDone(content || '（达到最大运行时间限制）', allToolRecords);
      return;
    }

    // 检查是否已中止
    if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) {
      callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined);
      return;
    }

    let thinking = '';
    let content = '';
    const toolCalls: ToolCall[] = [];

    const abortController = new AbortController();
    state.set(KEYS.ABORT_CONTROLLER, abortController);

    try {
      await api.chatStream(
        {
          model,
          messages,
          stream: true,
          think: state.get<boolean>('thinkEnabled', false),
          options: {
            num_ctx: state.get<number>(KEYS.NUM_CTX, 24576),
            temperature: state.get<number>('temperature', 0.7)
          },
          ...(useTools && { tools })
        },
        (chunk: OllamaStreamChunk) => {
          if (chunk.message?.thinking) {
            thinking += chunk.message.thinking;
            callbacks.onThinking(thinking);
          }
          if (chunk.message?.content) {
            content += chunk.message.content;
            callbacks.onContent(content);
          }
          if (chunk.message?.tool_calls?.length) {
            for (const tc of chunk.message.tool_calls) {
              if (tc.function?.name) {
                toolCalls.push({
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || {}
                  }
                });
              } else if (toolCalls.length > 0) {
                const last = toolCalls[toolCalls.length - 1];
                if (tc.function?.arguments && typeof tc.function.arguments === 'object') {
                  Object.assign(last.function.arguments, tc.function.arguments);
                }
              }
            }
          }
        },
        abortController
      );
    } catch (err) {
      if (abortController.signal.aborted) {
        if (content || thinking) {
          messages.push({
            role: 'assistant',
            content,
            ...(thinking && { thinking })
          });
        }
        callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined);
        return;
      }
      throw err;
    }

    const assistantMsg: OllamaMessage = {
      role: 'assistant',
      content,
      ...(thinking && { thinking })
    };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls;
    }
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
      callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined);
      return;
    }

    for (const call of toolCalls) {
      // 检查是否已中止
      if (abortController.signal.aborted) {
        callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined);
        return;
      }

      callbacks.onToolCallStart(call);

      if (needsConfirmation(call.function.name)) {
        const confirmed = await callbacks.onConfirmTool(call);
        // 确认后再次检查是否已中止
        if (abortController.signal.aborted) {
          callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined);
          return;
        }
        if (!confirmed) {
          const record: ToolCallRecord = {
            name: call.function.name,
            arguments: call.function.arguments,
            result: { success: false, error: '用户取消了操作' },
            status: 'cancelled',
            timestamp: Date.now()
          };
          allToolRecords.push(record);

          messages.push({
            role: 'tool',
            tool_name: call.function.name,
            content: JSON.stringify({ success: false, error: '用户取消了操作' })
          });
          callbacks.onToolCallError(call.function.name, '用户取消', call);
          continue;
        }
      }

      try {
        // 工具执行超时保护（30秒）
        const TOOL_TIMEOUT = 30000;
        const result = await Promise.race([
          executeTool(call.function.name, call.function.arguments),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('工具执行超时（30秒）')), TOOL_TIMEOUT)
          )
        ]);
        const record: ToolCallRecord = {
          name: call.function.name,
          arguments: call.function.arguments,
          result,
          status: result.success ? 'success' : 'error',
          timestamp: Date.now()
        };
        allToolRecords.push(record);

        messages.push({
          role: 'tool',
          tool_name: call.function.name,
          content: JSON.stringify(result)
        });
        callbacks.onToolCallResult(call.function.name, result, call);
      } catch (err) {
        const errorMsg = (err as Error).message;
        console.error(`[AgentEngine] 工具执行失败 (${call.function.name}):`, errorMsg);
        const record: ToolCallRecord = {
          name: call.function.name,
          arguments: call.function.arguments,
          result: { success: false, error: errorMsg },
          status: 'error',
          timestamp: Date.now()
        };
        allToolRecords.push(record);

        messages.push({
          role: 'tool',
          tool_name: call.function.name,
          content: JSON.stringify({ success: false, error: errorMsg })
        });
        callbacks.onToolCallError(call.function.name, errorMsg, call);
      }
    }
  }

  callbacks.onDone(content || '（达到最大工具调用次数限制）', allToolRecords);
}
