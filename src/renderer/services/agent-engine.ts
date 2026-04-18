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

/** v4.1: 工具并行执行 — 依赖检测用 */
const TOOLS_WITH_DATA_DEPS = new Set(['web_fetch', 'edit_file', 'append_file', 'move_file', 'delete_file']);

const AGENT_SYSTEM_PROMPT = `你是一个具备工具调用能力的 AI 助手。你有 25 个工具可以调用，包括文件操作、联网搜索、网页抓取、命令执行、记忆管理等。

## 核心规则

1. 直接调用工具，不要写"我来帮你搜索"然后结束。有工具就调用，调用完根据结果继续下一步。
2. 多步任务必须逐步完成：搜到结果 → 抓取详情 → 给出答案。不要在中间步骤停下。
3. 需要最新信息（版本号、新闻、日期等）时，必须先用工具获取，不要凭记忆猜测。
4. 工具出错时分析原因并换方法重试，最多重试 2 次。
5. 不要重复调用相同参数的同一工具。

## 多工具协同

你可以在一轮回复中调用多个工具（并行调用），也可以在一个工具的结果基础上继续调用下一个工具（链式调用）。这是正常且鼓励的工作方式。

常见链式调用模式：
- web_search → web_fetch（搜索 → 抓取详情）
- list_directory → read_file（列出目录 → 读取文件）
- search_files → edit_file（搜索 → 修改）
- run_command → read_file（执行命令 → 读取输出文件）

## 重要

永远不要只输出"我将执行xxx"或"让我来搜索"然后结束。如果说了要做什么，就必须真正调用对应的工具。调用 run_command 时命令可能需要很长时间，请耐心等待。`;

const TOOL_USAGE_GUIDE = `【工具链规则（强制执行）】

1. 搜索后必须抓取：web_search 搜到结果后，必须选择最相关的 1-3 个 URL，用 web_fetch 抓取详细内容。只看搜索摘要就回答是不够的。这是强制规则。
2. 先搜索再回答：需要最新信息时，先 search → 再 fetch → 再回答。不要凭记忆猜测版本号、日期、价格等实时数据。
3. 文件路径上下文：用户说"修改这个文件"等模糊指代时，从最近的工具调用结果中提取实际路径。不要猜测。
4. 不要重复调用：已经成功调用过的工具+参数组合不要再调用。
5. 记忆工具：可以用 memory_search 搜索过去记忆，用 memory_add 添加重要信息。
6. 会话工具：可以用 session_list 列出历史会话，用 session_read 读取会话内容。
7. 并行调用：当多个工具调用互相独立时，可以在同一次回复中同时调用它们。`;

/** 工具名白名单：用于文本解析兜底时过滤非法工具名 */
const VALID_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'list_directory', 'search_files', 'create_directory',
  'delete_file', 'run_command', 'move_file', 'copy_file', 'web_fetch', 'web_search',
  'append_file', 'edit_file', 'get_file_info', 'tree', 'download_file', 'diff_files',
  'replace_in_files', 'read_multiple_files', 'git', 'compress',
  'memory_search', 'memory_add', 'session_list', 'session_read'
]);

/**
 * 文本解析兜底：当模型没有通过 tool_calls 字段返回工具调用，
 * 而是在文本中写了 "Action: xxx" / "Action Input: {...}" 时，
 * 从文本中提取工具调用。
 */
function parseToolCallsFromText(content: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // 匹配：Action: tool_name（可选加粗标记）
  // 然后紧跟 Action Input: {json}
  // 支持格式：
  //   Action: write_file          Action: write_file
  //   Action Input: {...}         **Action Input:** {...}
  // 也支持写在同一段落的情况
  const actionRegex = /\*{0,2}Action:?\*{0,2}\s*(\w+)\s+[\r\n\s]*\*{0,2}Action\s*Input:?\*{0,2}\s*(\{[\s\S]*?\})/gi;

  let match;
  while ((match = actionRegex.exec(content)) !== null) {
    const toolName = match[1].trim();
    const argsStr = match[2].trim();

    if (!VALID_TOOL_NAMES.has(toolName)) continue;

    try {
      // 清理 JSON：去除可能的 markdown 代码块包裹
      let cleaned = argsStr.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
      const args = JSON.parse(cleaned);
      calls.push({
        type: 'function',
        function: { name: toolName, arguments: args }
      });
    } catch {
      // JSON 解析失败，尝试修复常见问题
      try {
        let fixed = argsStr
          .replace(/'/g, '"')
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']')
          .replace(/```json?\s*/g, '')
          .replace(/```/g, '')
          .trim();
        const args = JSON.parse(fixed);
        calls.push({
          type: 'function',
          function: { name: toolName, arguments: args }
        });
      } catch {
        logWarn(`文本解析兜底: 工具 ${toolName} 的参数 JSON 解析失败`, argsStr.slice(0, 100));
      }
    }
  }

  if (calls.length > 0) {
    logInfo(`文本解析兜底: 从回复中提取到 ${calls.length} 个工具调用`, calls.map(c => c.function.name).join(', '));
  }

  return calls;
}

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

/**
 * 格式化工具结果，生成模型友好的简洁表示
 * 原始 ToolResult 对象可能包含大量冗余字段（results数组、formatted字符串等），
 * 直接 JSON.stringify 会生成臃肿的 JSON，干扰模型理解和后续工具调用。
 */
function formatToolResultForModel(toolName: string, result: ToolResult): string {
  if (!result.success) {
    return JSON.stringify({ success: false, error: result.error || '工具执行失败' });
  }

  switch (toolName) {
    case 'web_search': {
      const raw = result.results as Array<{ title: string; url: string; snippet: string }> | undefined;
      if (!raw?.length) return JSON.stringify({ success: true, message: '未找到结果' });
      // 只保留 top 5，简洁格式
      const top = raw.slice(0, 5).map((r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`
      ).join('\n\n');
      return JSON.stringify({ success: true, query: result.query, total: result.total, results: top });
    }

    case 'web_fetch': {
      let content = (result.content as string) || '';
      // 截断过长内容，避免撑爆上下文
      if (content.length > 15000) content = content.slice(0, 15000) + '\n... (已截断)';
      return JSON.stringify({ success: true, url: result.url, content });
    }

    case 'read_file': {
      return JSON.stringify({
        success: true,
        path: result.path,
        content: result.content,
        lines: result.lines,
        truncated: result.truncated,
        line_range: result.line_range
      });
    }

    case 'read_multiple_files': {
      return JSON.stringify({
        success: true,
        files: result.files,
        total: result.total
      });
    }

    case 'list_directory': {
      return JSON.stringify({
        success: true,
        path: result.path,
        entries: result.entries,
        total: result.total,
        truncated: result.truncated
      });
    }

    case 'write_file': {
      return JSON.stringify({
        success: true,
        path: result.path,
        bytesWritten: result.bytesWritten,
        created: result.created
      });
    }

    case 'run_command': {
      return JSON.stringify({
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: result.duration
      });
    }

    case 'git': {
      return JSON.stringify({
        success: true,
        action: result.action,
        output: result.output,
        branch: result.branch,
        files: result.files,
        commits: result.commits
      });
    }

    case 'search_files': {
      return JSON.stringify({
        success: true,
        query: result.query,
        total_matches: result.total_matches,
        total_files: result.total_files,
        matches: result.matches
      });
    }

    default: {
      // 通用清理：移除内部元数据字段
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result)) {
        if (k === 'success' || k === 'formatted' || k === 'content_type' ||
            k === 'status' || k === 'length' || k === 'isDirectory') continue;
        clean[k] = v;
      }
      return JSON.stringify(clean);
    }
  }
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
    ? systemPromptParts.join('\n\n') + '\n\n' + AGENT_SYSTEM_PROMPT + '\n\n' + TOOL_USAGE_GUIDE
    : AGENT_SYSTEM_PROMPT + '\n\n' + TOOL_USAGE_GUIDE;

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

    // 文本解析兜底：模型没通过 tool_calls 返回但文本中写了 Action
    if (toolCalls.length === 0 && useTools) {
      const parsedCalls = parseToolCallsFromText(content);
      if (parsedCalls.length > 0) {
        toolCalls.push(...parsedCalls);
      }
    }

    // 检查是否是 Final Answer（没有工具调用且包含 Final Answer）
    const isFinalAnswer = content.includes('Final Answer:') || content.includes('最终答案：');

    // 处理空响应：如果之前有工具调用但模型返回空内容，不立即结束
    if (toolCalls.length === 0 && !content.trim() && loopCount > 1 && allToolRecords.length > 0) {
      logWarn('模型返回空内容（有未处理的工具结果），继续循环');
      // 移除空的 assistant 消息，避免 Ollama 解析问题
      messages.pop();
      // 添加一个提示性的 user 消息引导模型继续
      messages.push({
        role: 'user',
        content: '请根据上面的工具调用结果继续回答。如果需要更多信息，可以继续调用工具。如果已有足够信息，请给出最终回答。'
      });
      continue;
    }

    if (toolCalls.length === 0) {
      // 真正的最终回答（有内容或首次循环就无工具）
      logInfo('无工具调用，ReAct Agent Loop 结束');

      // 自动提取记忆（仅在对话结束后）
      if (isMemoryEnabled() && messages.length >= 4) {
        try {
          const { extractMemoriesFromConversation } = await import('./memory-manager.js');
          await extractMemoriesFromConversation(
            messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
            currentSession?.title
          );
        } catch { /* 不阻塞 */ }
      }

      callbacks.onDone(content || '（模型未返回内容）', allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
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

    // ── v4.1 工具并行执行：将独立工具分批并行调用 ──
    // 将工具调用分成批次：同一批次内的工具互相独立，可并行执行
    // 跨批次的工具有依赖关系（如 web_fetch 依赖前面的 web_search）
    const batches: ToolCall[][] = [];
    let currentBatch: ToolCall[] = [];
    const batchDeps = new Map<ToolCall, string>(); // 记录每个工具依赖的前序工具名

    for (const call of toolCalls) {
      if (currentBatch.length === 0) {
        currentBatch.push(call);
      } else {
        // 检查当前工具是否依赖当前批次中任何工具的结果
        const needsPrevResult = currentBatch.some(prev =>
          TOOLS_WITH_DATA_DEPS.has(call.function.name) && prev.function.name !== call.function.name
        );
        if (needsPrevResult) {
          // 有依赖，当前批次结束，开启新批次
          batches.push(currentBatch);
          batchDeps.set(call, currentBatch[currentBatch.length - 1].function.name);
          currentBatch = [call];
        } else {
          currentBatch.push(call);
        }
      }
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    if (batches.length > 1) {
      logInfo(`工具并行执行: ${toolCalls.length} 个工具 → ${batches.length} 批次（首批 ${batches[0].length} 个并行）`);
    }

    /** 执行单个工具（含重试），返回 [ToolCallRecord, 缓存key|null] */
    const executeSingleTool = async (call: ToolCall): Promise<[ToolCallRecord, string | null]> => {
      const cacheKey = getToolCacheKey(call.function.name, call.function.arguments);

      // 重复调用检测
      if (isDuplicateCall(call, toolCalls)) {
        logWarn(`跳过重复工具调用: ${call.function.name}`);
        const cached = toolResultCache.get(cacheKey);
        if (cached) {
          return [{
            name: call.function.name, arguments: call.function.arguments,
            result: cached, status: 'success' as const, timestamp: Date.now()
          }, null];
        }
      }

      // 跨轮次缓存命中
      const cachedResult = toolResultCache.get(cacheKey);
      if (cachedResult) {
        logInfo(`工具缓存命中: ${call.function.name}`);
        return [{
          name: call.function.name, arguments: call.function.arguments,
          result: cachedResult, status: 'success' as const, timestamp: Date.now()
        }, null];
      }

      callbacks.onToolCallStart(call);
      logToolStart(call.function.name, JSON.stringify(call.function.arguments));

      // 需要确认的工具（目前只有 run_command 在 confirm 模式下）
      if (needsConfirmation(call.function.name)) {
        const confirmed = await callbacks.onConfirmTool(call);
        if (!confirmed) {
          logWarn(`工具取消: ${call.function.name}`);
          const cancelResult = { success: false, error: '用户取消了操作' };
          return [{
            name: call.function.name, arguments: call.function.arguments,
            result: cancelResult, status: 'cancelled' as const, timestamp: Date.now()
          }, null];
        }
      }

      // 执行 + 自动重试
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
          logToolResult(call.function.name, result.success, result.success ? undefined : result.error);
          return [{
            name: call.function.name, arguments: call.function.arguments,
            result, status: result.success ? 'success' as const : 'error' as const, timestamp: Date.now()
          }, result.success && call.function.name !== 'run_command' ? cacheKey : null];
        } catch (err) {
          lastError = (err as Error).message;
          if (retry < MAX_RETRIES) {
            logWarn(`工具重试 ${retry + 1}/${MAX_RETRIES}: ${call.function.name}`, lastError);
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          logError(`工具执行失败: ${call.function.name}`, lastError);
          return [{
            name: call.function.name, arguments: call.function.arguments,
            result: { success: false, error: lastError },
            status: 'error' as const, timestamp: Date.now()
          }, null];
        }
      }
      // unreachable
      return [{
        name: call.function.name, arguments: call.function.arguments,
        result: { success: false, error: lastError }, status: 'error' as const, timestamp: Date.now()
      }, null];
    };

    // 按批次执行：批次内并行，批次间串行
    for (const batch of batches) {
      if (abortController.signal.aborted) {
        callbacks.onDone(content, allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
        return;
      }

      const results = await Promise.all(batch.map(call => executeSingleTool(call)));

      for (const [record, cacheKey] of results) {
        allToolRecords.push(record);
        messages.push({
          role: 'tool', tool_name: record.name,
          content: formatToolResultForModel(record.name, record.result!)
        });
        if (cacheKey) toolResultCache.set(cacheKey, record.result!);
        if (record.status === 'success') {
          callbacks.onToolCallResult(record.name, record.result!, batch.find(c => c.function.name === record.name)!);
        } else if (record.status === 'cancelled') {
          callbacks.onToolCallError(record.name, '用户取消', batch.find(c => c.function.name === record.name)!);
        } else {
          callbacks.onToolCallError(record.name, record.result?.error || '执行失败', batch.find(c => c.function.name === record.name)!);
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
