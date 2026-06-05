/**
 * Agent Engine - ReAct Agent Loop 核心引擎 (v4.0)
 * ReAct 模式: Thought → Action → Observation → Reflection
 * 支持任务复杂度评估、自动规划、错误重试、执行轨迹记录
 */

import { OllamaAPI } from '../api/ollama.js';
import { ChatDB } from '../db/chat-db.js';
import { state, KEYS } from '../state/state.js';
import {
  executeTool,
  getEnabledToolDefinitions,
  needsConfirmation
} from './tool-registry.js';
import { searchMemories, buildMemoryContext, markMemoryUsed, isMemoryEnabled } from './memory-manager.js';
import { extractSkillsFromToolRecords, matchSkills, buildSkillContext } from './skill-manager.js';
import { showToast } from '../components/toast.js';
import { logInfo, logWarn, logSuccess, logError, logToolStart, logToolResult, logAgentLoop, logModelResponse } from './log-service.js';
import { getWorkspaceDirPath } from '../components/workspace-panel.js';
import { generateId } from '../utils/utils.js';
import { buildContext, estimateTokens, shouldAutoCompress, compressWithLLM, AUTO_COMPRESS_THRESHOLD, recordActualTokens } from './context-manager.js';
import type {
  OllamaMessage,
  OllamaStreamChunk,
  ToolCall,
  ToolResult,
  ToolCallRecord,
  TraceEntry,
  ChatSession
} from '../types.js';

const MAX_RETRIES = 2;              // 工具错误自动重试次数

/** 每个工具返回给模型的最大字符数 */
const TOOL_MAX_RESULT_SIZE: Record<string, number> = {
  web_fetch: 20000,       // 网页内容通常较长
  web_search: 3000,       // 搜索结果已精简
  read_file: 15000,       // 文件内容
  read_multiple_files: 10000,
  list_directory: 5000,
  search_files: 5000,
  run_command: 10000,     // 命令输出
  git: 5000,
  session_read: 15000,
  browser_extract: 10000,
  browser_evaluate: 8000,
};

/** v4.1: 工具并行执行 — 依赖检测用 */
const TOOLS_WITH_DATA_DEPS = new Set(['web_fetch', 'edit_file', 'append_file', 'move_file', 'delete_file']);

/** 工具名白名单：用于文本解析兜底时过滤非法工具名 */
const VALID_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'list_directory', 'search_files', 'create_directory',
  'delete_file', 'run_command', 'move_file', 'copy_file', 'web_fetch', 'web_search',
  'append_file', 'edit_file', 'get_file_info', 'tree', 'download_file', 'diff_files',
  'replace_in_files', 'read_multiple_files', 'git', 'compress',
  'memory_search', 'memory_add', 'memory_replace', 'memory_remove', 'session_list', 'session_read',
  'skill_list', 'skill_view'
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

    const TICK = String.fromCharCode(96);
    const tickJson = TICK + TICK + TICK + 'json';
    const tick3 = TICK + TICK + TICK;

    try {
      // 清理 JSON：去除可能的 markdown 代码块包裹
      let cleaned = argsStr
        .split(tickJson).join('')
        .split(tick3).join('')
        .trim();
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
          .split(tickJson).join('')
          .split(tick3).join('')
          .trim();
        const args = JSON.parse(fixed);
        calls.push({
          type: 'function',
          function: { name: toolName, arguments: args }
        });
      } catch {
        logWarn("文本解析兜底: 工具 " + toolName + " 的参数 JSON 解析失败", argsStr.slice(0, 100));
      }
    }
  }

  if (calls.length > 0) {
      logInfo("文本解析兜底: 从回复中提取到 " + calls.length + " 个工具调用", calls.map(c => c.function.name).join(', '));
  }

  return calls;
}

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
      const webFetchMax = TOOL_MAX_RESULT_SIZE['web_fetch'] || 20000;
      if (content.length > webFetchMax) content = content.slice(0, webFetchMax) + '\n... (已截断)';
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
        results: result.results
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
      let json = JSON.stringify(clean);
      // 按工具配置截断
      const maxLen = TOOL_MAX_RESULT_SIZE[toolName] || 15000;
      if (json.length > maxLen) json = json.slice(0, maxLen) + '\n... (已截断)';
      return json;
    }
  }
}

export interface AgentCallbacks {
  onThinking: (text: string) => void;
  onContent: (text: string) => void;
  onToolCallStart: (call: ToolCall) => void;
  onToolCallResult: (name: string, result: ToolResult, call: ToolCall) => void;
  onToolCallError: (name: string, error: string, call: ToolCall) => void;
  onDone: (finalContent: string, toolRecords?: ToolCallRecord[], stats?: { eval_count?: number; prompt_eval_count?: number; total_duration?: number }) => void;
  onConfirmTool: (call: ToolCall) => Promise<boolean>;
  /** Agent Loop 新迭代开始（前一轮工具执行完毕，下一轮流式输出即将开始） */
  onNewIteration?: (toolCalls?: ToolCall[]) => void;
}

/** 保存执行轨迹到 SQLite */
async function saveTrace(trace: Record<string, any>): Promise<void> {
  try {
    const bridge = window.metonaDesktop;
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
  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  const sessionId = currentSession?.id || 'unknown';

  if (!api || !model) {
    showToast('请先选择模型', 'error');
    return;
  }

  // 新一轮对话，清空工具缓存
  toolResultCache.clear();

  // 检查模型是否支持 Tool Calling
  const modelSupportsTools = state.get<boolean>('modelSupportsTools', false);

  // 提前获取工具列表，供后续系统 prompt 构建使用
  const tools = getEnabledToolDefinitions();
  const useTools = tools.length > 0;

  const messages: OllamaMessage[] = [];
  let systemPromptParts: string[] = [];

  // ── 扫描工作空间 SOUL.md ──
  let soulMdContent = '';
  const workspaceDir = getWorkspaceDirPath();
  if (workspaceDir) {
    try {
      const soulResult = await window.metonaDesktop?.workspace.readFile(
        workspaceDir.replace(/\/+$/, '') + '/SOUL.md'
      );
      if (soulResult?.success && soulResult.content) {
        soulMdContent = soulResult.content;
        logInfo('SOUL.md 已从工作空间加载', `${soulResult.lines || 0} 行`);
      }
    } catch { /* 工作空间 SOUL.md 不存在 */ }
  }

  // fallback：读取内置 SOUL.md（随应用发布，Vite publicDir 自动复制）
  if (!soulMdContent) {
    try {
      const resp = await fetch('./SOUL.md');
      if (resp.ok) {
        soulMdContent = await resp.text();
        logInfo('SOUL.md 已从内置加载', `${soulMdContent.length} 字符`);
      }
    } catch { /* 内置 SOUL.md 也不可用 */ }
  }

  if (soulMdContent) {
    // SOUL.md 注入为独立 system 消息，标记为不可压缩
    messages.push({
      role: 'system',
      content: `[SOUL.md] ${soulMdContent}`,
    });
  }

  // ── 扫描工作空间 AGENT.md ──
  let agentMdContent = '';
  if (workspaceDir) {
    try {
      const agentResult = await window.metonaDesktop?.workspace.readFile(
        workspaceDir.replace(/\/+$/, '') + '/AGENT.md'
      );
      if (agentResult?.success && agentResult.content) {
        agentMdContent = agentResult.content;
        logInfo('AGENT.md 已从工作空间加载', `${agentResult.lines || 0} 行`);
      }
    } catch { /* 工作空间 AGENT.md 不存在 */ }
  }

  // fallback：读取内置 AGENT.md（随应用发布，Vite publicDir 自动复制）
  if (!agentMdContent) {
    try {
      const resp = await fetch('./AGENT.md');
      if (resp.ok) {
        agentMdContent = await resp.text();
        logInfo('AGENT.md 已从内置加载', `${agentMdContent.length} 字符`);
      }
    } catch { /* 内置 AGENT.md 也不可用 */ }
  }

  if (agentMdContent) {
    // AGENT.md 注入到 systemPromptParts，排在 SOUL.md 之后、其他系统提示词之前
    systemPromptParts.push(`[AGENT.md] ${agentMdContent}`);
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

  // 注入工作空间上下文
  if (workspaceDir) {
    systemPromptParts.push(`【工作空间】
当前工作空间目录: ${workspaceDir}
你可以使用 run_command 工具在此目录下执行命令，所有命令通过工作空间进程管理执行，无超时限制。
文件操作工具（read_file、write_file 等）的相对路径基于此目录解析。`);
  }

  // v4.2 注入匹配的技能上下文
  if (useTools && userContent) {
    const matchedSkills = await matchSkills(userContent, 3);
    if (matchedSkills.length > 0) {
      const skillContext = buildSkillContext(matchedSkills);
      if (skillContext) {
        systemPromptParts.push(skillContext);
        logInfo(`技能匹配: ${matchedSkills.length} 个技能已注入`, matchedSkills.map(s => s.name).join(', '));
      }
    }
  }

  // ── 扫描工作空间 USER.md ──
  let userMdContent = '';
  if (workspaceDir) {
    try {
      const userResult = await window.metonaDesktop?.workspace.readFile(
        workspaceDir.replace(/\/+$/, '') + '/USER.md'
      );
      if (userResult?.success && userResult.content) {
        userMdContent = userResult.content;
        logInfo('USER.md 已从工作空间加载', `${userResult.lines || 0} 行`);
      }
    } catch { /* 工作空间 USER.md 不存在 */ }
  }

  // fallback：读取内置 USER.md
  if (!userMdContent) {
    try {
      const resp = await fetch('./USER.md');
      if (resp.ok) {
        userMdContent = await resp.text();
        logInfo('USER.md 已从内置加载', `${userMdContent.length} 字符`);
      }
    } catch { /* 内置 USER.md 也不可用 */ }
  }

  if (userMdContent) {
    systemPromptParts.push(`[USER.md] ${userMdContent}`);
  }

  // 组合 system prompt

  // 实时注入当前日期（来自系统时钟，非模型知识库）
  const _now = new Date();
  const realDate = `${_now.getFullYear()}年${_now.getMonth() + 1}月${_now.getDate()}日`;

  const fullSystemPrompt = [
    ...systemPromptParts,
    `【当前日期】${realDate}（此日期来自系统时钟，绝对可信。你的训练数据可能已过时，请以此日期为准构造所有搜索查询和时效性回答。绝对不要基于训练数据推断日期。）`
  ].join('\n\n');

  messages.push({ role: 'system', content: fullSystemPrompt });

  // 将完整系统提示词存入 state（包含 SOUL.md + fullSystemPrompt）
  const allSystemContent = messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n\n');
  state.set('_lastSystemPrompt', allSystemContent || fullSystemPrompt);

  // 添加历史消息
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

  // 上下文窗口管理：滑动窗口 + 摘要压缩 + token 裁剪
  const numCtx = state.get<number>(KEYS.NUM_CTX, 24576);
  const contextResult = buildContext(messages, { maxTokens: numCtx, windowSize: 20 });
  messages.length = 0;
  messages.push(...contextResult);

  // 自动压缩：当上下文 token 超过 context window 的 50% 时，调用 LLM 摘要压缩
  if (shouldAutoCompress(messages, numCtx)) {
    logInfo(`自动上下文压缩触发: tokens≈${estimateTokens(messages.map(m => m.content || '').join(''))} > ${Math.floor(numCtx * AUTO_COMPRESS_THRESHOLD)} (50% of ${numCtx})`);
    const compressAC = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER) || new AbortController();
    try {
      const compressed = await compressWithLLM(messages, api as any, model, { abortController: compressAC });
      if (compressed.length < messages.length || estimateTokens(compressed.map(m => m.content || '').join('')) < estimateTokens(messages.map(m => m.content || '').join(''))) {
        messages.length = 0;
        messages.push(...compressed);
        logSuccess(`自动上下文压缩完成: 剩余 ${messages.length} 条消息`);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      logWarn('自动上下文压缩失败，继续使用当前上下文', (err as Error).message);
    }
  }

  logInfo(`ReAct Agent Loop 启动: ${model}`, `工具: ${useTools ? '开启' : '关闭'}, 记忆: ${isMemoryEnabled() ? '开启' : '关闭'}, tokens≈${estimateTokens(messages.map(m => m.content || '').join(''))}`);

  // 迭代预算：从 state 读取，默认 85
  const maxLoops = state.get<number>('maxTurns', 85);

  let loopCount = 0;
  const allToolRecords: ToolCallRecord[] = [];
  const loopStartTime = Date.now();
  let content = '';
  /** 每轮累计 token 统计 */
  let totalEvalCount = 0;
  let totalPromptEvalCount = 0;
  let totalInferenceNs = 0;
  /** 当前轮的 Ollama 统计（流式最后一个 chunk 赋值） */
  let loopEvalCount = 0;
  let loopPromptEvalCount = 0;
  let loopInferenceNs = 0;
  /** 跨轮去重：仅跟踪成功的工具调用（失败的允许重试） */
  let prevLoopSuccessKeys: string[] = [];
  /** 保存上一轮的工具调用，供 onNewIteration 使用 */
  let prevToolCalls: ToolCall[] = [];

  const makeStats = () => ({
    eval_count: totalEvalCount || undefined,
    prompt_eval_count: totalPromptEvalCount || undefined,
    total_duration: totalInferenceNs || undefined,
  });

  while (loopCount < maxLoops) {
    loopCount++;

    // 检查是否已中止
    if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) {
      logInfo('ReAct Agent Loop 已中止');
      if (allToolRecords.length > 0) {
        state.set('_abortToolRecords', allToolRecords);
      }
      throw new DOMException('Aborted', 'AbortError');
    }

    // 非首轮迭代：通知 UI 创建新的消息气泡（防止每轮内容互相覆盖）
    if (loopCount > 1 && callbacks.onNewIteration) {
      callbacks.onNewIteration(prevToolCalls.length > 0 ? prevToolCalls : undefined);
    }

    logAgentLoop(loopCount, maxLoops);

    let thinking = '';
    content = '';
    const toolCalls: ToolCall[] = [];

    // v5.1.2 预算警告：接近迭代上限时注入临时提示
    let budgetWarningIdx = -1;
    const remaining = maxLoops - loopCount + 1;
    if (remaining <= 5 && remaining > 0) {
      const warning = remaining <= 2
        ? `\n⚠️ CRITICAL: You have only ${remaining} iteration(s) left. Stop using tools and provide your final answer NOW.`
        : `\n⚠️ WARNING: You have approximately ${remaining} iterations remaining. Start wrapping up and prepare your final answer.`;
      messages.push({ role: 'system', content: warning });
      budgetWarningIdx = messages.length - 1;
    }

    const abortController = new AbortController();
    state.set(KEYS.ABORT_CONTROLLER, abortController);

    try {
      // 流式调用（无超时限制）
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
            if (chunk.eval_count) { loopEvalCount = chunk.eval_count; }
            if (chunk.prompt_eval_count) { loopPromptEvalCount = chunk.prompt_eval_count; }
            if (chunk.total_duration) { loopInferenceNs = chunk.total_duration; }
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

    // 本轮流式结束，累加 token 统计
    totalEvalCount += loopEvalCount;
    totalPromptEvalCount += loopPromptEvalCount;
    totalInferenceNs += loopInferenceNs;
    state.set('_currentEvalCount', totalEvalCount);

    // Token 校准：用 Ollama 返回的实际计数修正估算器（在重置前保存本轮值）
    const thisLoopEval = loopEvalCount;
    const thisLoopPrompt = loopPromptEvalCount;
    // 重置本轮计数器（下一轮重新从 chunk 收集）
    loopEvalCount = 0;
    loopPromptEvalCount = 0;
    loopInferenceNs = 0;

    // Token 校准：用 Ollama 返回的实际计数自动修正估算器
    try {
      if (thisLoopEval > 0 || thisLoopPrompt > 0) {
        const estimatedThisLoop = estimateTokens(messages.map(m => m.content || '').join(''));
        if (estimatedThisLoop > 0) {
          recordActualTokens(thisLoopPrompt, thisLoopEval, estimatedThisLoop);
        }
      }
    } catch { /* 校准失败不阻塞主流程 */ }

    } catch (err) {
      if (abortController.signal.aborted) {
        logInfo('流式调用已中止');
        // 保存工具记录到 state，供消费方的 catch 处理中止消息
        if (allToolRecords.length > 0) {
          state.set('_abortToolRecords', allToolRecords);
        }
        throw err; // 抛出 AbortError，由消费方统一处理
      }
      logError('流式调用异常', (err as Error).message);
      // 清理预算警告临时消息
      if (budgetWarningIdx >= 0) {
        messages.splice(budgetWarningIdx, 1);
      }
      if (content || thinking) {
        messages.push({ role: 'assistant', content: content || '（模型响应异常）', ...(thinking && { thinking }) });
      }
      callbacks.onDone(content || '（模型响应异常，已自动中断）', allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
      return;
    }

    // 清理预算警告临时消息
    if (budgetWarningIdx >= 0) {
      messages.splice(budgetWarningIdx, 1);
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
      if (isMemoryEnabled() && messages.length >= 10) {
        try {
          const { extractMemoriesFromConversation } = await import('./memory-manager.js');
          await extractMemoriesFromConversation(
            messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
            currentSession?.title
          );
        } catch { /* 不阻塞 */ }
      }

      // v4.2 自动提取技能
      if (allToolRecords.length >= 2) {
        try {
          await extractSkillsFromToolRecords(allToolRecords, userContent, (currentSession as ChatSession)?.title || '');
        } catch { /* 不阻塞 */ }
      }

      callbacks.onDone(content || '（模型未返回内容）', allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
      return;
    }

    // 跨轮次重复检测：仅当连续两轮调用完全相同且全部成功时才终止（失败的允许重试）
    const currentLoopKeys = toolCalls.map(c => getToolCacheKey(c.function.name, c.function.arguments)).sort();
    const currentKeysStr = JSON.stringify(currentLoopKeys);
    const prevKeysStr = JSON.stringify([...prevLoopSuccessKeys].sort());
    if (currentKeysStr === prevKeysStr && currentLoopKeys.length > 0) {
      // 检查是否有上一轮失败的工具——如果有，不终止，允许重试
      const hasFailedInPrev = allToolRecords
        .filter(r => prevLoopSuccessKeys.includes(getToolCacheKey(r.name, r.arguments)))
        .some(r => r.status !== 'success');
      if (!hasFailedInPrev) {
        logWarn('检测到连续两轮工具调用完全相同且全部成功，终止 ReAct Loop', currentKeysStr.slice(0, 200));
        callbacks.onDone(content || '（检测到重复工具调用，已自动停止）', allToolRecords, makeStats());
        return;
      }
      logInfo('检测到重复调用但上一轮有失败，允许重试');
    }

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
          const result = await executeTool(call.function.name, call.function.arguments)
            .catch(err => ({ success: false, error: err?.message || String(err) }) as ToolResult);
          logToolResult(call.function.name, result.success, result.success ? undefined : result.error);
          return [{
            name: call.function.name, arguments: call.function.arguments,
            result, status: result.success ? 'success' as const : 'error' as const, timestamp: Date.now()
          }, result.success ? cacheKey : null];
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

    // 更新跨轮去重：仅跟踪本轮成功的工具调用
    prevLoopSuccessKeys = allToolRecords
      .filter(r => r.status === 'success')
      .map(r => getToolCacheKey(r.name, r.arguments));

    // 保存本轮轨迹
    traceStep.observation = allToolRecords.slice(-toolCalls.length).map(r =>
      `${r.name}: ${r.result?.success ? 'success' : 'error'}`
    ).join('; ');
    saveTrace(traceStep);

    // 保存本轮工具调用，供下一轮 onNewIteration 使用
    prevToolCalls = toolCalls;
  }

  logWarn('ReAct Agent Loop 达到最大工具调用次数限制');
  callbacks.onDone(content || '（达到最大工具调用次数限制）', allToolRecords, makeStats());
}
