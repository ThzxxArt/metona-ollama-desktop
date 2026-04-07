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
import { logInfo, logWarn, logError, logToolStart, logToolResult, logThink, logStream, logAgentLoop, logModelResponse } from './log-service.js';
import type {
  OllamaMessage,
  OllamaStreamChunk,
  ToolCall,
  ToolResult,
  ToolCallRecord
} from '../types.js';

const MAX_LOOPS = 10;
const MAX_LOOP_TIME = 300000;        // 5 分钟总超时
const TOOL_EXEC_TIMEOUT = 30000;     // 工具执行超时 30 秒
const STREAM_TIMEOUT = 120000;       // 单次流式调用超时 2 分钟

const TOOL_USAGE_GUIDE = `【工具使用规则】
1. 路径上下文：当用户说"修改这个文件"、"删除它"、"查看里面"等未指定路径时，必须从本次对话中最近的工具调用结果中提取路径。例如用户之前让你读取了 /home/user/project/config.json，后续说"修改配置"就应继续使用该路径，而不是推测新路径。
2. 工具调用结果中的 path 字段是权威的文件路径，优先使用它。
3. 如果对话中从未出现过相关路径，应先用 search_files 或 list_directory 定位，不要凭空猜测路径。
4. 对同一文件的连续操作（读取→修改、读取→删除），路径必须一致。
5. 当用户要求执行命令时，使用 run_command 工具执行。执行完成后，将 stdout/stderr 的结果告知用户。对于需要实时查看进度的长时间运行命令（如 npm install、ollama pull），建议用户在工作空间面板中手动执行。`;

export interface AgentCallbacks {
  onThinking: (text: string) => void;
  onContent: (text: string) => void;
  onToolCallStart: (call: ToolCall) => void;
  onToolCallResult: (name: string, result: ToolResult, call: ToolCall) => void;
  onToolCallError: (name: string, error: string, call: ToolCall) => void;
  onDone: (finalContent: string, toolRecords?: ToolCallRecord[], stats?: { eval_count?: number; total_duration?: number }) => void;
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

  // 检查模型是否支持 Tool Calling
  const modelSupportsTools = state.get<boolean>('modelSupportsTools', false);
  if (!modelSupportsTools) {
    logWarn(`模型 ${model} 不支持 Tool Calling`, 'Agent Loop 可能不稳定');
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
    messages.push({ role: 'system', content: systemPromptParts.join('\n\n') + '\n\n' + TOOL_USAGE_GUIDE });
  } else {
    messages.push({ role: 'system', content: TOOL_USAGE_GUIDE });
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

  logInfo(`Agent Loop 启动: ${model}`, `工具: ${useTools ? '开启' : '关闭'}, 记忆: ${isMemoryEnabled() ? '开启' : '关闭'}`);

  let loopCount = 0;
  const allToolRecords: ToolCallRecord[] = [];
  const loopStartTime = Date.now();
  let content = '';
  let totalEvalCount = 0;

  const makeStats = () => {
    const totalDuration = (Date.now() - loopStartTime) * 1e6; // 转为纳秒
    return { eval_count: totalEvalCount || undefined, total_duration: totalDuration };
  };

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    // 全局超时检查
    if (Date.now() - loopStartTime > MAX_LOOP_TIME) {
      logWarn('Agent Loop 达到最大运行时间（5分钟），自动停止');
      callbacks.onDone(content || '（达到最大运行时间限制）', allToolRecords, makeStats());
      return;
    }

    // 检查是否已中止
    if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) {
      logInfo('Agent Loop 已中止');
      callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
      return;
    }

    logAgentLoop(loopCount, MAX_LOOPS);

    let thinking = '';
    content = '';
    const toolCalls: ToolCall[] = [];

    const abortController = new AbortController();
    state.set(KEYS.ABORT_CONTROLLER, abortController);

    try {
      // 带超时保护的流式调用
      await Promise.race([
        api.chatStream(
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
              // 每收到 200 字符记录一次思考日志
              if (thinking.length % 200 < 10) {
                logThink(thinking);
              }
            }
            if (chunk.message?.content) {
              content += chunk.message.content;
              callbacks.onContent(content);
            }
            if (chunk.eval_count) totalEvalCount = chunk.eval_count;
            if (chunk.message?.tool_calls?.length) {
              for (const tc of chunk.message.tool_calls) {
                if (tc.function?.name) {
                  // 新的工具调用
                  toolCalls.push({
                    type: 'function',
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments || {}
                    }
                  });
                } else if (toolCalls.length > 0) {
                  // 增量 arguments 追加到当前最后一个 tool_call
                  const last = toolCalls[toolCalls.length - 1];
                  if (tc.function?.arguments && typeof tc.function.arguments === 'object') {
                    Object.assign(last.function.arguments, tc.function.arguments);
                  }
                }
              }
            }
          },
          abortController
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('模型响应超时（2分钟无数据）')), STREAM_TIMEOUT)
        )
      ]);
    } catch (err) {
      if (abortController.signal.aborted) {
        logInfo('流式调用已中止');
        if (content || thinking) {
          messages.push({
            role: 'assistant',
            content,
            ...(thinking && { thinking })
          });
        }
        callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
        return;
      }
      // 超时错误 — 保留已生成的内容
      if ((err as Error).message.includes('超时')) {
        logError('流式调用超时（2分钟无数据）', (err as Error).message);
        if (content || thinking) {
          messages.push({
            role: 'assistant',
            content: content || '（模型响应超时）',
            ...(thinking && { thinking })
          });
        }
        callbacks.onDone(content || '（模型响应超时，已自动中断）', allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
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
      // 官方示例要求：tool_calls 时同时保留 content 和 thinking
      // 确保 content 不为空（模型可能在调用工具前说了话）
    }
    messages.push(assistantMsg);

    logModelResponse(content.length, toolCalls.length);

    if (toolCalls.length === 0) {
      logInfo('无工具调用，Agent Loop 结束');
      callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
      return;
    }

    for (const call of toolCalls) {
      // 检查是否已中止
      if (abortController.signal.aborted) {
        callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
        return;
      }

      callbacks.onToolCallStart(call);
      logToolStart(call.function.name, JSON.stringify(call.function.arguments));

      if (needsConfirmation(call.function.name)) {
        const confirmed = await callbacks.onConfirmTool(call);
        // 确认后再次检查是否已中止
        if (abortController.signal.aborted) {
          callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
          return;
        }
        if (!confirmed) {
          logWarn(`工具取消: ${call.function.name}`, '用户取消了操作');
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
        // 工具执行超时保护
        logInfo(`执行工具: ${call.function.name}`, JSON.stringify(call.function.arguments));
        const result = await Promise.race([
          executeTool(call.function.name, call.function.arguments).catch(err =>
            ({ success: false, error: err?.message || String(err) }) as ToolResult
          ),
          new Promise<ToolResult>((_, reject) =>
            setTimeout(() => reject(new Error('工具执行超时（30秒）')), TOOL_EXEC_TIMEOUT)
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
        logToolResult(call.function.name, result.success, result.success ? undefined : result.error);
      } catch (err) {
        const errorMsg = (err as Error).message;
        logError(`工具执行失败: ${call.function.name}`, errorMsg);
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

  logWarn('Agent Loop 达到最大工具调用次数限制');
  callbacks.onDone(content || '（达到最大工具调用次数限制）', allToolRecords, makeStats());
}
