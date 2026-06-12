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

/** 获取当前操作系统环境信息（用于系统提示词注入） */
function getOSEnvironment() {
  const isWin = navigator.platform?.toLowerCase().includes('win') || false;
  const isMac = navigator.platform?.toLowerCase().includes('mac') || false;
  const isLinux = !isWin && !isMac;
  const bridge = (window as any).metonaDesktop;
  const isDesktop = bridge?.isDesktop || false;

  // 通过 preload 暴露的真实系统信息（同步，无 IPC 开销）
  const sys = bridge?.sys;
  const realHomeDir = sys?.homeDir || '';
  const realShell = sys?.shell || '';
  const realArch = sys?.arch || (navigator.platform || 'unknown');
  const realUser = sys?.username || '';

  return {
    os: isWin ? 'Windows' : isMac ? 'macOS' : 'Linux',
    platform: isDesktop ? 'Electron Desktop' : 'Browser',
    arch: realArch,
    shell: realShell || (isWin ? 'cmd.exe / PowerShell' : 'bash'),
    homeDir: realHomeDir || (isWin ? 'C:\\Users\\<用户名>' : '/home/<用户名>'),
    username: realUser,
    lineEnding: isWin ? 'CRLF (\\r\\n)' : 'LF (\\n)',
    pathSep: isWin ? '\\ (反斜杠)' : '/ (正斜杠)',
  };
}

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

/** v4.1: 工具并行执行 — 依赖检测。只有确实依赖前序工具输出结果的才串行 */
const TOOLS_WITH_DATA_DEPS = new Set(['web_fetch']); // web_fetch 可能依赖 web_search 的结果 URL

/** 始终可并行的只读/独立工具（无数据依赖，永远可以同批执行） */
const ALWAYS_PARALLEL = new Set([
  'read_file', 'list_directory', 'search_files', 'get_file_info', 'tree',
  'web_search', 'browser_screenshot', 'browser_extract', 'browser_evaluate',
  'memory_search', 'session_list', 'session_read', 'skill_list', 'skill_view',
  'diff_files', 'git',
  'datetime', 'calculator',
  'random', 'uuid', 'json_format', 'hash',
]);

/** 工具名白名单：用于文本解析兜底时过滤非法工具名 */
const VALID_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'list_directory', 'search_files', 'create_directory',
  'delete_file', 'run_command', 'move_file', 'copy_file', 'web_fetch', 'web_search',
  'edit_file', 'get_file_info', 'tree', 'download_file', 'diff_files',
  'replace_in_files', 'read_multiple_files', 'git', 'compress',
  'memory_search', 'memory_add', 'memory_replace', 'memory_remove', 'session_list', 'session_read',
  'skill_list', 'skill_view',
  'datetime', 'calculator',
  'random', 'uuid', 'json_format', 'hash'
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

const toolResultCache = new Map<string, { result: ToolResult; timestamp: number }>();

/** 工具缓存 TTL（毫秒），按工具类型设定 */
const CACHE_TTL_MAP: Record<string, number> = {
  web_search: 5 * 60_000,     // 搜索: 5分钟
  web_fetch: 10 * 60_000,     // 网页: 10分钟
  read_file: 30 * 60_000,     // 文件: 30分钟
  list_directory: 60_000,     // 目录: 1分钟
  search_files: 60_000,       // 文件搜索: 1分钟
  browser_screenshot: 60_000, // 截图: 1分钟
  browser_extract: 5 * 60_000,// 浏览器内容: 5分钟
  // 其他工具默认无限期
  default: Infinity,
};

/** 检查缓存是否过期 */
function isCacheValid(toolName: string, timestamp: number): boolean {
  const ttl = CACHE_TTL_MAP[toolName] ?? CACHE_TTL_MAP.default;
  if (!isFinite(ttl)) return true;
  return Date.now() - timestamp < ttl;
}

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
      const visible = Math.min(10, raw.length);
      const top = raw.slice(0, visible).map((r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`
      ).join('\n\n');
      const fetched = (result as any)._fetched as Array<{ url: string; title: string; content: string }> | undefined;
      const body = JSON.stringify({
        success: true, query: result.query, total: result.total, shown: visible, results: top,
      });
      if (fetched && fetched.length > 0) {
        return body + '\n\n' + fetched.map((f, i) =>
          `\n=== 📄 已抓取 ${i + 1}/${fetched.length}: ${f.title} ===\n${f.content}\n`
        ).join('\n---\n');
      }
      return body;
    }

    case 'web_fetch': {
      let content = (result.content as string) || '';
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

  // ── 注入操作系统环境信息（不可压缩，确保 AI 使用正确命令）──
  const osInfo = getOSEnvironment();
  systemPromptParts.push(`[环境] 运行环境信息
操作系统: ${osInfo.os}
平台: ${osInfo.platform}
架构: ${osInfo.arch}
Shell: ${osInfo.shell}
用户目录: ${osInfo.homeDir}
换行符: ${osInfo.lineEnding}
路径分隔符: ${osInfo.pathSep}

⚠️ 重要：必须使用与上述操作系统匹配的命令语法。
- 如果是 Windows，使用 CMD/PowerShell 命令（如 dir、type、findstr，路径用 \\）
- 如果是 Linux/macOS，使用 Bash 命令（如 ls、cat、grep，路径用 /）
- 严禁在 Windows 上执行 Linux 命令，严禁在 Linux 上执行 Windows 命令。`);

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

  // 组合 system prompt

  // 实时注入当前日期（来自系统时钟，非模型知识库）
  const _now = new Date();
  const realDate = `${_now.getFullYear()}年${_now.getMonth() + 1}月${_now.getDate()}日`;

  const fullSystemPrompt = [
    ...systemPromptParts,
    `[日期] ${realDate}（此日期来自系统时钟，绝对可信。你的训练数据可能已过时，请以此日期为准构造所有搜索查询和时效性回答。绝对不要基于训练数据推断日期。）`
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

  // P2-1: 自动子任务拆解 — 检测用户消息中的并行任务关键词
  const PARALLEL_PATTERNS = /同时|分别|以及|另外|此外|并且|也|also|and\s+also|separately|in\s+addition|meanwhile/i;
  const SUBTASK_SEPARATORS = /(?:^|\n)\s*(?:[1-9][.、)]|[-*•]\s+)/;
  const userText = userContent || '';
  const hasParallel = PARALLEL_PATTERNS.test(userText) && userText.length > 100;

  if (hasParallel && useTools) {
    // 尝试按数字列表拆分子任务
    const parts = userText.split(SUBTASK_SEPARATORS).filter(p => p.trim().length > 20);
    if (parts.length >= 3) {
      logInfo(`自动子任务拆解: 检测到 ${parts.length} 个并行子任务`);
      const subtaskResults: string[] = [];
      const { executeSubAgent } = await import('./sub-agent.js');
      const subTasks = parts.slice(0, Math.min(parts.length, 3)); // 最多3个
      // 并行 spawn
      const subResults = await Promise.allSettled(
        subTasks.map((subTask, idx) =>
          executeSubAgent(subTask.trim(), `这是父任务的第 ${idx + 1}/${subTasks.length} 个子任务`, {
            maxLoops: 8,
            timeout: 120_000,
          })
        )
      );
      for (let i = 0; i < subResults.length; i++) {
        const r = subResults[i];
        if (r.status === 'fulfilled' && r.value.success) {
          const content = (r.value as any).content || JSON.stringify(r.value);
          subtaskResults.push(`[子任务 ${i + 1}] ${subTasks[i].trim().slice(0, 80)}...\n结果: ${content.slice(0, 1000)}`);
        }
      }
      if (subtaskResults.length > 0) {
        messages.push({
          role: 'system',
          content: `以下是通过并行子代理预先完成的子任务结果，你可以直接引用这些结果来加速回答：\n\n${subtaskResults.join('\n\n')}`,
          ephemeral: true,
        });
        logInfo(`子任务拆解完成: ${subtaskResults.length}/${subTasks.length} 个成功`);
      }
    }
  }

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

  // 迭代预算：从 state 读取，默认 85（后续可能被 Token 感知策略动态缩减）
  let maxLoops = state.get<number>('maxTurns', 85);

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

    // P1-4: Token 感知的动态迭代预算 — context window 使用率 > 80% 时强制缩减剩余轮次
    const usageRatio = estimateTokens(messages.map(m => m.content || '').join('')) / numCtx;
    if (usageRatio > 0.8 && (maxLoops - loopCount) > 3) {
      const newMax = loopCount + 3;
      logWarn(`上下文使用率 ${(usageRatio * 100).toFixed(0)}%, 限制剩余迭代为 ${newMax - loopCount} 轮（原 ${maxLoops - loopCount} 轮）`);
      maxLoops = newMax;
    }

    // 非首轮迭代：通知 UI 创建新的消息气泡（防止每轮内容互相覆盖）
    if (loopCount > 1 && callbacks.onNewIteration) {
      callbacks.onNewIteration(prevToolCalls.length > 0 ? prevToolCalls : undefined);
    }

    logAgentLoop(loopCount, maxLoops);

    let thinking = '';
    content = '';
    const toolCalls: ToolCall[] = [];

    // v5.1.2 预算警告：接近迭代上限时注入临时提示（ephemeral 标记，上下文裁剪时优先丢弃）
    const remaining = maxLoops - loopCount + 1;
    if (remaining <= 5 && remaining > 0) {
      const warning = remaining <= 2
        ? `\n⚠️ CRITICAL: You have only ${remaining} iteration(s) left. Stop using tools and provide your final answer NOW.`
        : `\n⚠️ WARNING: You have approximately ${remaining} iterations remaining. Start wrapping up and prepare your final answer.`;
      messages.push({ role: 'system', content: warning, ephemeral: true });
    }

    const abortController = new AbortController();
    state.set(KEYS.ABORT_CONTROLLER, abortController);

    // 流式调用超时保护（可配置，0 = 禁用超时）
    const STREAM_TIMEOUT_MS = state.get<number>('streamTimeout', 300_000); // 默认 300s（可在设置中配置，0=禁用）
    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    if (STREAM_TIMEOUT_MS > 0) {
      streamTimer = setTimeout(() => {
        logWarn(`流式调用超时 (${STREAM_TIMEOUT_MS / 1000}s)，中止本轮`);
        abortController.abort();
      }, STREAM_TIMEOUT_MS);
    }

    try {
      // 流式调用
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

    // 流式调用成功完成，清除超时定时器
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }

    } catch (err) {
      // 清除超时定时器
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
      if (abortController.signal.aborted) {
        logInfo('流式调用已中止');
        // 保存工具记录到 state，供消费方的 catch 处理中止消息
        if (allToolRecords.length > 0) {
          state.set('_abortToolRecords', allToolRecords);
        }
        throw err; // 抛出 AbortError，由消费方统一处理
      }
      logError('流式调用异常', (err as Error).message);
      if (content || thinking) {
        messages.push({ role: 'assistant', content: content || '（模型响应异常）', ...(thinking && { thinking }) });
      }
      callbacks.onDone(content || '（模型响应异常，已自动中断）', allToolRecords.length > 0 ? allToolRecords : undefined, makeStats());
      return;
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

    // 检查是否是 Final Answer（多模式匹配 + 内容长度验证）
    // 只有当无工具调用且有实际内容时才可能是最终回答
    const FINAL_PATTERNS: RegExp[] = [
      /Final\s*Answer\s*:/i,
      /最终答案[：:]/,
      /最终回答[：:]/,
      /总结[：:]/,
      /任务完成[！!]?/,
      /以上(是|为)[我对]?/,
      /以上就是/,
    ];
    // 有工具历史 + 回复较长(>300字)且无工具调用 → 大概率是最终回答
    const isFinalAnswer = toolCalls.length === 0 && content.length > 50 && (
      FINAL_PATTERNS.some(p => p.test(content)) ||
      (allToolRecords.length > 0 && content.length > 300)
    );

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
      // ── 反过早结束：如果之前有工具调用，但模型返回的内容不像最终回答，引导继续 ──
      if (allToolRecords.length > 0 && !isFinalAnswer && loopCount < maxLoops - 1) {
        const contentLower = content.toLowerCase();
        // "还在思考中"的典型信号：短内容 + 思考动词
        const isThinking = contentLower.includes('让我') || contentLower.includes('看看') ||
          contentLower.includes('观察') || (contentLower.includes('分析') && !contentLower.includes('分析结果'));
        const isMidSentence = contentLower.endsWith('...') || contentLower.endsWith('等等') ||
          contentLower.includes('让我再');
        const isContinuation = content.length < 300 && isThinking &&
          (isMidSentence || contentLower.includes('接下来') || contentLower.includes('继续'));

        if (isContinuation) {
          logWarn('模型可能过早停止，注入继续提示', `${content.length}字`);
          messages.pop();
          messages.push({
            role: 'user',
            content: '请继续完成任务。你可以调用工具获取更多信息，或者根据已有结果给出完整的最终回答。如果任务已完成，请明确说出"任务完成"或"最终回答"。'
          });
          continue;
        }
      }

      // 真正的最终回答
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

    // 跨轮次重复检测：连续两轮调用完全相同且全部成功 → 注入警告而不强制终止
    const currentLoopKeys = toolCalls.map(c => getToolCacheKey(c.function.name, c.function.arguments)).sort();
    const currentKeysStr = JSON.stringify(currentLoopKeys);
    const prevKeysStr = JSON.stringify([...prevLoopSuccessKeys].sort());
    if (currentKeysStr === prevKeysStr && currentLoopKeys.length > 0) {
      const hasFailedInPrev = allToolRecords
        .filter(r => prevLoopSuccessKeys.includes(getToolCacheKey(r.name, r.arguments)))
        .some(r => r.status !== 'success');
      if (!hasFailedInPrev) {
        logWarn('检测到连续两轮工具调用完全相同且全部成功，注入提醒而非终止');
        messages.push({
          role: 'user',
          content: '⚠️ 检测到你连续调用了与上一轮完全相同的工具。请基于已有结果给出最终回答，或者调用不同的工具获取新信息。如果任务已完成，请给出最终回答。'
        });
        continue;
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
      } else if (ALWAYS_PARALLEL.has(call.function.name)) {
        // 只读/独立工具 → 永远可以并行
        currentBatch.push(call);
      } else {
        // 检查当前工具是否依赖当前批次中任何工具的结果
        const needsPrevResult = currentBatch.some(prev =>
          TOOLS_WITH_DATA_DEPS.has(call.function.name) && prev.function.name !== call.function.name
        );
        if (needsPrevResult) {
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
            result: cached.result, status: 'success' as const, timestamp: Date.now()
          }, null];
        }
      }

      // 跨轮次缓存命中（含 TTL 过期检查）
      const cachedEntry = toolResultCache.get(cacheKey);
      if (cachedEntry && isCacheValid(call.function.name, cachedEntry.timestamp)) {
        logInfo(`工具缓存命中: ${call.function.name}`);
        return [{
          name: call.function.name, arguments: call.function.arguments,
          result: cachedEntry.result, status: 'success' as const, timestamp: Date.now()
        }, null];
      }
      if (cachedEntry) {
        // 过期缓存，删除
        toolResultCache.delete(cacheKey);
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
        if (cacheKey) toolResultCache.set(cacheKey, { result: record.result!, timestamp: Date.now() });
        if (record.status === 'success') {
          callbacks.onToolCallResult(record.name, record.result!, batch.find(c => c.function.name === record.name)!);
        } else if (record.status === 'cancelled') {
          callbacks.onToolCallError(record.name, '用户取消', batch.find(c => c.function.name === record.name)!);
        } else {
          callbacks.onToolCallError(record.name, record.result?.error || '执行失败', batch.find(c => c.function.name === record.name)!);
        }
      }
    }

    // P0-1: 硬限制工具消息数量 — 保留最近 40 条，删除旧的防止上下文无限膨胀
    {
      const toolIndices: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'tool') toolIndices.push(i);
      }
      if (toolIndices.length > 40) {
        const toRemove = toolIndices.slice(0, toolIndices.length - 40);
        // 从后往前删，避免索引偏移
        for (let i = toRemove.length - 1; i >= 0; i--) {
          messages.splice(toRemove[i], 1);
        }
        logInfo(`工具消息裁剪: ${toRemove.length} 条旧结果已移除 (保留最近 40 条)`);
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

    // P2-2: 增量记忆提取 — 每 20 轮 fire-and-forget，不阻塞主循环
    if (isMemoryEnabled() && loopCount > 1 && loopCount % 20 === 0 && messages.length >= 10) {
      import('./memory-manager.js').then(({ extractMemoriesFromConversation }) => {
        const recentMsgs = messages.slice(-30).filter(m => m.role === 'user' || m.role === 'assistant');
        extractMemoriesFromConversation(
          recentMsgs.map(m => ({ role: m.role, content: m.content })),
          currentSession?.title
        ).then(() => logInfo('增量记忆提取完成', `第 ${loopCount} 轮`))
         .catch(() => {});
      }).catch(() => {});
    }

    // 保存本轮工具调用，供下一轮 onNewIteration 使用
    prevToolCalls = toolCalls;

    // P1-3: 增量工具结果截断 — 超过 10 轮的旧工具结果每 3 轮截断到 500 字符
    if (loopCount > 10 && loopCount % 3 === 0) {
      const truncateBefore = messages.length - 15;
      for (let i = 0; i < messages.length && i < truncateBefore; i++) {
        const m = messages[i];
        if (m.role === 'tool' && m.content && m.content.length > 500) {
          messages[i] = { ...m, content: m.content.slice(0, 500) + '\n... (已截断旧工具结果)' };
        }
      }
    }
  }

  logWarn('ReAct Agent Loop 达到最大工具调用次数限制');
  callbacks.onDone(content || '（达到最大工具调用次数限制）', allToolRecords, makeStats());
}
