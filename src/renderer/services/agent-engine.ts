/**
 * Agent Engine - ReAct Agent Loop 核心引擎 (v4.0)
 * ReAct 模式: Thought → Action → Observation → Reflection
 * 支持任务复杂度评估、自动规划、错误重试、执行轨迹记录
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
import { logInfo, logWarn, logError, logToolStart, logToolResult, logThink, logAgentLoop, logModelResponse } from './log-service.js';
import { getWorkspaceDirPath } from '../components/workspace-panel.js';
import { generateId } from '../utils/utils.js';
import type {
  OllamaMessage,
  OllamaStreamChunk,
  ToolCall,
  ToolResult,
  ToolCallRecord,
  TraceEntry
} from '../types.js';

const MAX_LOOPS = 15;
const MAX_LOOP_TIME = 600000;       // 10 分钟总超时
const TOOL_EXEC_TIMEOUT = 30000;    // 工具执行超时 30 秒
const STREAM_TIMEOUT = 120000;      // 单次流式调用超时 2 分钟
const MAX_RETRIES = 2;              // 工具错误自动重试次数

const REACT_SYSTEM_PROMPT = `你是一个具备 ReAct（Reasoning + Acting）能力的 AI 助手。你必须严格按照以下格式与用户交互：

## ReAct 输出格式

每次响应时，你必须按照以下结构思考和行动：

**Thought:** [你对当前任务的分析和推理。思考用户需要什么、当前有哪些信息、下一步应该做什么。]

**Action:** [如果需要使用工具，选择一个工具并说明原因。如果不需要工具，直接给出最终答案。]

**Action Input:** [工具的参数，必须是合法 JSON 格式]

然后等待 Observation（工具返回的结果）。

收到 Observation 后：

**Thought:** [基于工具结果的进一步推理。结果是否满足需求？是否需要更多步骤？]

**Action:** [下一步行动，或者 "Final Answer" 如果任务已完成]

**Action Input:** [下一步工具参数，或者最终答案]

## 任务复杂度评估

在开始时评估任务：
- **简单**：直接回答（1 步），不需要工具或仅需 1 个工具调用
- **中等**：需要 2-4 步，可能需要多个工具协作
- **复杂**：需要 5+ 步，需要规划和分解

对于复杂任务，先输出一个简短的执行计划，再开始 ReAct 循环。

## 错误处理

- 如果工具返回错误，分析原因并尝试不同方法
- 最多重试 2 次，如果仍然失败，向用户说明情况
- 不要反复调用相同参数的相同工具

## 最终答案

当任务完成时，输出 **Final Answer:** 后面跟你的最终回答。回答应该：
- 汇总所有执行步骤和结果
- 直接回答用户的问题
- 如果有重要发现，明确指出`;

const TOOL_USAGE_GUIDE = `【工具使用规则】
1. 路径上下文：当用户说"修改这个文件"、"删除它"、"查看里面"等未指定路径时，必须从本次对话中最近的工具调用结果中提取路径。
2. 工具调用结果中的 path 字段是权威的文件路径，优先使用它。
3. 如果对话中从未出现过相关路径，应先用 search_files 或 list_directory 定位，不要凭空猜测路径。
4. 对同一文件的连续操作（读取→修改、读取→删除），路径必须一致。
5. 当用户要求执行命令时，使用 run_command 工具执行。
6. 联网搜索联动：当用户询问需要最新信息的问题时，先用 web_search 搜索，然后必须从搜索结果中选择最相关的 1-3 个 URL，用 web_fetch 抓取页面详细内容。
7. 主动使用工具：当你不确定答案、信息可能已过时、或需要查阅实时数据时，主动调用工具而不是凭记忆猜测。
8. 严禁重复调用：如果本次对话中已经成功调用过某个工具并获得了结果，不要再次调用相同工具和相同参数。
9. 记忆工具：你可以使用 memory_search 搜索过去的记忆，使用 memory_add 添加新的重要记忆。
10. 会话工具：你可以使用 session_list 列出历史会话，使用 session_read 读取历史会话内容。`;

/** 工具调用缓存：key = toolName + JSON(args)，用于避免重复调用 */
const toolResultCache = new Map<string, ToolResult>();

/** 生成工具调用缓存 key */
function getToolCacheKey(name: string, args: Record<string, unknown>): string {
  try {
    return name + '::' + JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return name + '::' + String(args);
  }
}

/** 检测当前轮次是否存在重复工具调用 */
function isDuplicateCall(call: ToolCall, allCalls: ToolCall[]): boolean {
  const callKey = getToolCacheKey(call.function.name, call.function.arguments);
  return allCalls.some((prev, idx) => {
    if (idx === allCalls.length - 1) return false;
    return getToolCacheKey(prev.function.name, prev.function.arguments) === callKey;
  });
}

export interface AgentCallbacks {
  onThinking: (text: string) => void;
  onContent: (text: string) => void;
  onToolCallStart: (call: ToolCall) => void;
  onToolCallResult: (name: string, result: ToolResult, call: ToolCall) => void;
  onToolCallError: (name: string, error: string, call: ToolCall) => void;
  onDone: (finalContent: string, toolRecords?: ToolCallRecord[], stats?: { eval_count?: number; total_duration?: number }) => void;
  onConfirmTool: (call: ToolCall) => Promise<boolean>;
}

/** 保存执行轨迹到 SQLite */
async function saveTrace(trace: Omit<TraceEntry, 'id' | 'createdAt'>): Promise<void> {
  try {
    const bridge = (window as any).metonaDesktop;
    if (!bridge?.db) return;
    const entry = {
      id: `trace_${generateId()}`,
      session_id: trace.sessionId,
      step_index: trace.stepIndex,
      thought: trace.thought,
      action: trace.action,
      action_input: trace.actionInput,
      observation: trace.observation,
      loop_count: trace.loopCount,
      created_at: trace.createdAt
    };
    await bridge.db.saveTrace(entry);
  } catch { /* 不阻塞主流程 */ }
}

export async function runAgentLoop(
  userContent: string,
  images: string[],
  historyMessages: Array<{ role: string; content: string; images?: string[] }>,
  callbacks: AgentCallbacks
): Promise<void> {
  const api = state.get<OllamaAPI>(KEYS.API);
  const model = state.get<string>('_defaultModel', '');
  const currentSession = state.get(KEYS.CURRENT_SESSION);
  const sessionId = currentSession?.id || 'unknown';

  if (!api || !model) {
    showToast('请先选择模型', 'error');
    return;
  }

  // 新一轮对话，清空工具缓存
  toolResultCache.clear();

  // 检查模型是否支持 Tool Calling
  const modelSupportsTools = state.get<boolean>('modelSupportsTools', false);

  const messages: OllamaMessage[] = [];
  let systemPromptParts: string[] = [];

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

  // 注入工作空间上下文
  const workspaceDir = getWorkspaceDirPath();
  if (workspaceDir) {
    systemPromptParts.push(`【工作空间】
当前工作空间目录: ${workspaceDir}
你可以使用 run_command 工具在此目录下执行命令，所有命令通过工作空间进程管理执行，无超时限制。
文件操作工具（read_file、write_file 等）的相对路径基于此目录解析。`);
  }

  // 组合 system prompt
  const fullSystemPrompt = systemPromptParts.length > 0
    ? systemPromptParts.join('\n\n') + '\n\n' + REACT_SYSTEM_PROMPT + '\n\n' + TOOL_USAGE_GUIDE
    : REACT_SYSTEM_PROMPT + '\n\n' + TOOL_USAGE_GUIDE;

  messages.push({ role: 'system', content: fullSystemPrompt });

  // 添加历史消息（使用 context-manager 构建）
  for (const msg of historyMessages) {
    messages.push({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
      ...(msg.images?.length && { images: msg.images })
    });
  }

  // 用户消息
  const userMsg: OllamaMessage = {
    role: 'user',
    content: userContent || (images?.length ? (images.length > 1 ? `请分析这 ${images.length} 张图片` : '请分析这张图片') : ''),
    ...(images?.length && { images })
  };
  messages.push(userMsg);

  const tools = getEnabledToolDefinitions();
  const useTools = tools.length > 0;

  logInfo(`ReAct Agent Loop 启动: ${model}`, `工具: ${useTools ? '开启' : '关闭'}, 记忆: ${isMemoryEnabled() ? '开启' : '关闭'}`);

  let loopCount = 0;
  const allToolRecords: ToolCallRecord[] = [];
  const loopStartTime = Date.now();
  let content = '';
  let totalEvalCount = 0;
  let prevLoopToolKeys: string[] = [];
  /** 每轮工具调用计数（用于去重） */
  let allCallsThisLoop: ToolCall[] = [];

  const makeStats = () => {
    const totalDuration = (Date.now() - loopStartTime) * 1e6;
    return { eval_count: totalEvalCount || undefined, total_duration: totalDuration };
  };

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    // 全局超时检查
    if (Date.now() - loopStartTime > MAX_LOOP_TIME) {
      logWarn('ReAct Agent Loop 达到最大运行时间（10分钟），自动停止');
      callbacks.onDone(content || '（达到最大运行时间限制）', allToolRecords, makeStats());
      return;
    }

    // 检查是否已中止
    if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) {
      logInfo('ReAct Agent Loop 已中止');
      callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
      return;
    }

    logAgentLoop(loopCount, MAX_LOOPS);

    let thinking = '';
    content = '';
    const toolCalls: ToolCall[] = [];
    allCallsThisLoop = [];

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
            }
            if (chunk.message?.content) {
              content += chunk.message.content;
              callbacks.onContent(content);
            }
            if (chunk.eval_count) totalEvalCount = chunk.eval_count;
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
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('模型响应超时（2分钟无数据）')), STREAM_TIMEOUT)
        )
      ]);
    } catch (err) {
      if (abortController.signal.aborted) {
        logInfo('流式调用已中止');
        if (content || thinking) {
          messages.push({ role: 'assistant', content, ...(thinking && { thinking }) });
        }
        callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
        return;
      }
      if ((err as Error).message.includes('超时')) {
        logError('流式调用超时', (err as Error).message);
        if (content || thinking) {
          messages.push({ role: 'assistant', content: content || '（模型响应超时）', ...(thinking && { thinking }) });
        }
        callbacks.onDone(content || '（模型响应超时，已自动中断）', allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
        return;
      }
      throw err;
    }

    // 提取 ReAct 思考过程
    const thoughtMatch = content.match(/\*\*Thought:\*\*\s*([\s\S]*?)(?=\*\*Action:\*\*|\*\*Final Answer:\*\*|$)/i);
    const thought = thoughtMatch ? thoughtMatch[1].trim() : '';

    // 保存 assistant 消息
    const assistantMsg: OllamaMessage = {
      role: 'assistant',
      content,
      ...(thinking && { thinking })
    };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls;
    }
    messages.push(assistantMsg);

    logModelResponse(content.length, toolCalls.length);

    // 检查是否是 Final Answer（没有工具调用且包含 Final Answer）
    const isFinalAnswer = content.includes('Final Answer:') || content.includes('最终答案：');
    if (toolCalls.length === 0) {
      logInfo('无工具调用，ReAct Agent Loop 结束');

      // 自动提取记忆
      if (isMemoryEnabled() && messages.length >= 4) {
        try {
          const { extractMemoriesFromConversation } = await import('./memory-manager.js');
          await extractMemoriesFromConversation(
            messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
            currentSession?.title
          );
        } catch { /* 不阻塞 */ }
      }

      callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
      return;
    }

    // 跨轮次完整重复检测
    const currentLoopKeys = toolCalls.map(c => getToolCacheKey(c.function.name, c.function.arguments)).sort();
    const currentKeysStr = JSON.stringify(currentLoopKeys);
    const prevKeysStr = JSON.stringify([...prevLoopToolKeys].sort());
    if (currentKeysStr === prevKeysStr && currentLoopKeys.length > 0) {
      logWarn('检测到连续两轮工具调用完全相同，终止 ReAct Loop', currentKeysStr.slice(0, 200));
      callbacks.onDone(content || '（检测到重复工具调用，已自动停止）', allToolRecords, makeStats());
      return;
    }
    prevLoopToolKeys = currentLoopKeys;

    // 记录 ReAct 轨迹
    const traceStep = {
      sessionId,
      stepIndex: loopCount,
      thought: thought || content.slice(0, 200),
      action: toolCalls.map(t => t.function.name).join(', '),
      actionInput: JSON.stringify(toolCalls.map(t => t.function.arguments)),
      observation: '',
      loopCount,
      createdAt: Date.now()
    };

    for (const call of toolCalls) {
      // 检查是否已中止
      if (abortController.signal.aborted) {
        callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
        return;
      }

      // 同一轮内重复调用检测
      if (isDuplicateCall(call, toolCalls)) {
        logWarn(`跳过重复工具调用: ${call.function.name}`);
        const cachedKey = getToolCacheKey(call.function.name, call.function.arguments);
        const cached = toolResultCache.get(cachedKey);
        if (cached) {
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(cached) });
          callbacks.onToolCallResult(call.function.name, cached, call);
        }
        continue;
      }

      // 跨轮次缓存命中
      const cacheKey = getToolCacheKey(call.function.name, call.function.arguments);
      const cachedResult = toolResultCache.get(cacheKey);
      if (cachedResult) {
        logInfo(`工具缓存命中: ${call.function.name}`);
        messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(cachedResult) });
        callbacks.onToolCallResult(call.function.name, cachedResult, call);
        continue;
      }

      callbacks.onToolCallStart(call);
      logToolStart(call.function.name, JSON.stringify(call.function.arguments));

      if (needsConfirmation(call.function.name)) {
        const confirmed = await callbacks.onConfirmTool(call);
        if (abortController.signal.aborted) {
          callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
          return;
        }
        if (!confirmed) {
          logWarn(`工具取消: ${call.function.name}`);
          const record: ToolCallRecord = {
            name: call.function.name,
            arguments: call.function.arguments,
            result: { success: false, error: '用户取消了操作' },
            status: 'cancelled',
            timestamp: Date.now()
          };
          allToolRecords.push(record);
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify({ success: false, error: '用户取消了操作' }) });
          callbacks.onToolCallError(call.function.name, '用户取消', call);
          continue;
        }
      }

      // 工具执行 + 自动重试
      let lastError = '';
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          let result: ToolResult;
          if (call.function.name === 'run_command') {
            result = await executeTool(call.function.name, call.function.arguments);
          } else {
            result = await Promise.race([
              executeTool(call.function.name, call.function.arguments).catch(err =>
                ({ success: false, error: err?.message || String(err) }) as ToolResult
              ),
              new Promise<ToolResult>((_, reject) =>
                setTimeout(() => reject(new Error('工具执行超时（30秒）')), TOOL_EXEC_TIMEOUT)
              )
            ]);
          }

          // 成功
          const record: ToolCallRecord = {
            name: call.function.name,
            arguments: call.function.arguments,
            result,
            status: result.success ? 'success' : 'error',
            timestamp: Date.now()
          };
          allToolRecords.push(record);
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(result) });
          if (result.success && call.function.name !== 'run_command') {
            toolResultCache.set(cacheKey, result);
          }
          callbacks.onToolCallResult(call.function.name, result, call);
          logToolResult(call.function.name, result.success, result.success ? undefined : result.error);
          break; // 成功，退出重试循环
        } catch (err) {
          lastError = (err as Error).message;
          if (retry < MAX_RETRIES) {
            logWarn(`工具重试 ${retry + 1}/${MAX_RETRIES}: ${call.function.name}`, lastError);
            await new Promise(r => setTimeout(r, 500)); // 短暂延迟后重试
            continue;
          }
          // 最终失败
          logError(`工具执行失败: ${call.function.name}`, lastError);
          const record: ToolCallRecord = {
            name: call.function.name,
            arguments: call.function.arguments,
            result: { success: false, error: lastError },
            status: 'error',
            timestamp: Date.now()
          };
          allToolRecords.push(record);
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify({ success: false, error: lastError }) });
          callbacks.onToolCallError(call.function.name, lastError, call);
        }
      }
    }

    // 保存本轮轨迹
    traceStep.observation = allToolRecords.slice(-toolCalls.length).map(r =>
      `${r.name}: ${r.result?.success ? 'success' : 'error'}`
    ).join('; ');
    saveTrace(traceStep);
  }

  logWarn('ReAct Agent Loop 达到最大工具调用次数限制');
  callbacks.onDone(content || '（达到最大工具调用次数限制）', allToolRecords, makeStats());
}
