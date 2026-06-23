/**
 * Agent Engine - ReAct Agent Loop 核心引擎 (v0.12.0 Harness Edition)
 * ReAct 模式: Thought → Action → Observation → Reflection
 * v0.12.0: 状态机化架构 + Hook 系统 + Completion Gate + Plan Mode
 */

import { OllamaAPI } from '../api/ollama.js';
import { state, KEYS } from '../state/state.js';
import {
  executeTool,
  getEnabledToolDefinitions,
  needsConfirmation,
  initPlanTracker,
  getPlanTracker,
  formatPlanStatus,
  clearPlanTracker,
} from './tool-registry.js';
import { searchMemories, buildMemoryContext, markMemoryUsed, isMemoryEnabled } from './memory-manager.js';
import { showToast } from '../components/toast.js';
import { logInfo, logWarn, logSuccess, logError, logToolStart, logToolResult, logAgentLoop, logModelResponse, logStreamProgress, resetStreamProgress } from './log-service.js';
import { getWorkspaceDirPath } from '../components/workspace-panel.js';
import { generateId } from '../utils/utils.js';
import { buildContext, estimateTokens, shouldAutoCompress, compressWithLLM, AUTO_COMPRESS_THRESHOLD, recordActualTokens } from './context-manager.js';
import { runCompletionGate } from './completion-gate.js';
import { executeHooks } from './hooks.js';
import { recordIteration, recordToolCall, recordCompletionGate, startSessionMetrics, endSessionMetrics } from './agent-metrics.js';
import { buildProjectIndex, buildIndexContext } from './context-indexer.js';
import type {
  OllamaMessage,
  OllamaStreamChunk,
  ToolCall,
  ToolResult,
  ToolCallRecord,
  ChatSession,
  LoopState,
  LoopContext,
  AgentMode,
} from '../types.js';

const MAX_RETRIES = 2;              // 工具错误自动重试次数
const MAX_MESSAGES = 500;           // v0.12.1: 上下文硬上限，超过则强制压缩

/** ── LoopState 常量 ── */
const S = {
  INIT: 'INIT' as LoopState,
  THINKING: 'THINKING' as LoopState,
  PARSING: 'PARSING' as LoopState,
  EXECUTING: 'EXECUTING' as LoopState,
  OBSERVING: 'OBSERVING' as LoopState,
  REFLECTING: 'REFLECTING' as LoopState,
  COMPRESSING: 'COMPRESSING' as LoopState,
  TERMINATED: 'TERMINATED' as LoopState,
} as const;

/** ── 状态转换表 ── */
function getValidTransitions(state: LoopState): LoopState[] {
  switch (state) {
    case 'INIT':        return ['THINKING', 'TERMINATED'];
    case 'THINKING':    return ['PARSING', 'TERMINATED'];
    case 'PARSING':     return ['EXECUTING', 'REFLECTING', 'THINKING', 'TERMINATED'];
    case 'EXECUTING':   return ['OBSERVING', 'THINKING', 'TERMINATED'];
    case 'OBSERVING':   return ['COMPRESSING', 'REFLECTING', 'THINKING', 'TERMINATED'];
    case 'REFLECTING':  return ['THINKING', 'COMPRESSING', 'TERMINATED'];
    case 'COMPRESSING': return ['THINKING', 'REFLECTING', 'TERMINATED'];
    case 'TERMINATED':  return [];
  }
}

/** 获取当前操作系统环境信息（用于系统提示词注入） */
function getOSEnvironment() {
  const isWin = navigator.platform?.toLowerCase().includes('win') || false;
  const isMac = navigator.platform?.toLowerCase().includes('mac') || false;
  const isLinux = !isWin && !isMac;
  const bridge = (window as any).metonaDesktop;
  const isDesktop = bridge?.isDesktop || false;

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
  web_fetch: 20000,
  web_search: 3000,
  read_file: 15000,
  read_multiple_files: 10000,
  list_directory: 5000,
  search_files: 5000,
  run_command: 10000,
  git: 5000,
  session_read: 15000,
  browser_extract: 10000,
  browser_evaluate: 8000,
};

/** v4.1: 工具并行执行 — 依赖检测。只有确实依赖前序工具输出结果的才串行 */
const TOOLS_WITH_DATA_DEPS = new Set(['web_fetch']);

/** 始终可并行的只读/独立工具 */
const ALWAYS_PARALLEL = new Set([
  'read_file', 'list_directory', 'search_files', 'get_file_info', 'tree',
  'web_search', 'browser_screenshot', 'browser_extract', 'browser_evaluate',
  'memory_search', 'session_list', 'session_read',
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
  web_search: 5 * 60_000,
  web_fetch: 10 * 60_000,
  read_file: 30 * 60_000,
  list_directory: 60_000,
  search_files: 60_000,
  browser_screenshot: 60_000,
  browser_extract: 5 * 60_000,
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
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result)) {
        if (k === 'success' || k === 'formatted' || k === 'content_type' ||
            k === 'status' || k === 'length' || k === 'isDirectory') continue;
        clean[k] = v;
      }
      let json = JSON.stringify(clean);
      const maxLen = TOOL_MAX_RESULT_SIZE[toolName] || 15000;
      if (json.length > maxLen) json = json.slice(0, maxLen) + '\n... (已截断)';
      return json;
    }
  }
}

export interface AgentCallbacks {
  onThinking: (text: string) => void;
  onContent: (text: string) => void;
  onToolCallPrepare?: (call: ToolCall) => void;
  onToolCallStart: (call: ToolCall) => void;
  onToolCallResult: (name: string, result: ToolResult, call: ToolCall) => void;
  onToolCallError: (name: string, error: string, call: ToolCall) => void;
  onDone: (finalContent: string, toolRecords?: ToolCallRecord[], stats?: { eval_count?: number; prompt_eval_count?: number; total_duration?: number }) => void;
  onConfirmTool: (call: ToolCall) => Promise<boolean>;
  onNewIteration?: (toolCalls?: ToolCall[]) => void;
  /** Plan Mode: 计划已生成，等待用户确认 */
  onPlanReady?: (plan: string, steps: string[]) => Promise<boolean>;
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
      error_pattern: trace.errorPattern || null,
      created_at: trace.createdAt
    };
    await bridge.db.saveTrace(entry);
  } catch { /* 不阻塞主流程 */ }
}

// ═══════════════════════════════════════════════════════════════
// Harness: 状态转换函数
// ═══════════════════════════════════════════════════════════════

function transition(ctx: LoopContext, newState: LoopState): void {
  const allowed = getValidTransitions(ctx.state);
  if (!allowed.includes(newState)) {
    logWarn(`非法的状态转换: ${ctx.state} → ${newState}（允许: ${allowed.join(', ')}）`);
    // 容错：允许紧急终止
    if (newState === S.TERMINATED) {
      ctx.state = S.TERMINATED;
      state.set('_loopState', ctx.state);
      return;
    }
    return;
  }
  ctx.state = newState;
  state.set('_loopState', ctx.state);
}

/** 持久化 LoopContext 到 state（用于暂停/恢复） */
function persistLoopContext(ctx: LoopContext): void {
  state.set('_loopContext', {
    sessionId: ctx.sessionId,
    loopCount: ctx.loopCount,
    maxLoops: ctx.maxLoops,
    totalEvalCount: ctx.totalEvalCount,
    totalPromptEvalCount: ctx.totalPromptEvalCount,
    allToolRecords: ctx.allToolRecords,
    startTime: ctx.startTime,
  });
}

/** 从 state 恢复 LoopContext（暂未实现完整恢复，预留接口） */
function restoreLoopContext(_sessionId: string): Partial<LoopContext> | null {
  return state.get<Partial<LoopContext> | null>('_loopContext', null);
}

// ═══════════════════════════════════════════════════════════════
// Harness: 状态处理器
// ═══════════════════════════════════════════════════════════════

/**
 * INIT 状态：构建系统提示词、准备上下文、压缩检测
 */
async function handleInit(
  ctx: LoopContext,
  api: OllamaAPI,
  model: string,
  callbacks: AgentCallbacks,
  userContent: string,
  images: string[],
  historyMessages: Array<{ role: string; content: string; images?: string[] }>,
  currentSession: ChatSession | null,
): Promise<void> {
  // 新一轮对话，清空工具缓存
  toolResultCache.clear();

  const modelSupportsTools = state.get<boolean>('modelSupportsTools', false);
  const tools = getEnabledToolDefinitions();
  const useTools = tools.length > 0;

  ctx.messages.length = 0;
  const systemPromptParts: string[] = [];

  // ── 扫描工作空间 SOUL.md（静态区，不可压缩）──
  let soulMdContent = '';
  const workspaceDir = getWorkspaceDirPath();
  if (workspaceDir) {
    try {
      const soulResult = await window.metonaDesktop?.workspace.readFile(
        workspaceDir.replace(/[\\/]+$/, '') + '/SOUL.md'
      );
      if (soulResult?.success && soulResult.content) {
        soulMdContent = soulResult.content;
        logInfo('SOUL.md 已从工作空间加载', `${soulResult.lines || 0} 行`);
      }
    } catch { /* ignore */ }
  }
  if (!soulMdContent) {
    try {
      const resp = await fetch('./SOUL.md');
      if (resp.ok) { soulMdContent = await resp.text(); logInfo('SOUL.md 已从内置加载', `${soulMdContent.length} 字符`); }
    } catch { /* ignore */ }
  }
  if (soulMdContent) {
    ctx.messages.push({ role: 'system', content: `[SOUL.md] ${soulMdContent}` });
  }

  // ── 扫描工作空间 AGENT.md ──
  let agentMdContent = '';
  if (workspaceDir) {
    try {
      const agentResult = await window.metonaDesktop?.workspace.readFile(
        workspaceDir.replace(/[\\/]+$/, '') + '/AGENT.md'
      );
      if (agentResult?.success && agentResult.content) {
        agentMdContent = agentResult.content;
        logInfo('AGENT.md 已从工作空间加载', `${agentResult.lines || 0} 行`);
      }
    } catch { /* ignore */ }
  }
  if (!agentMdContent) {
    try {
      const resp = await fetch('./AGENT.md');
      if (resp.ok) { agentMdContent = await resp.text(); logInfo('AGENT.md 已从内置加载', `${agentMdContent.length} 字符`); }
    } catch { /* ignore */ }
  }
  if (agentMdContent) {
    // v0.12.0: Token 预算截断（限制 2000 tokens）
    const truncated = truncateByTokenBudget(agentMdContent, 2000);
    systemPromptParts.push(`[AGENT.md] ${truncated}`);
  }

  // ── 扫描工作空间 USER.md ──
  let userMdContent = '';
  if (workspaceDir) {
    try {
      const userResult = await window.metonaDesktop?.workspace.readFile(
        workspaceDir.replace(/[\\/]+$/, '') + '/USER.md'
      );
      if (userResult?.success && userResult.content) {
        userMdContent = userResult.content;
        logInfo('USER.md 已从工作空间加载', `${userResult.lines || 0} 行`);
      }
    } catch { /* ignore */ }
  }
  if (!userMdContent) {
    try {
      const resp = await fetch('./USER.md');
      if (resp.ok) { userMdContent = await resp.text(); logInfo('USER.md 已从内置加载', `${userMdContent.length} 字符`); }
    } catch { /* ignore */ }
  }
  if (userMdContent) {
    systemPromptParts.push(`[USER.md] ${userMdContent}`);
  }

  // 注入记忆上下文
  if (isMemoryEnabled() && userContent) {
    const relevantMemories = searchMemories(userContent, 6);
    if (relevantMemories.length > 0) {
      systemPromptParts.push(buildMemoryContext(relevantMemories));
      for (const m of relevantMemories) { await markMemoryUsed(m.id); }
    }
  }

  // 注入工作空间上下文
  if (workspaceDir) {
    systemPromptParts.push(`【工作空间】
当前工作空间目录: ${workspaceDir}
你可以使用 run_command 工具在此目录下执行命令，所有命令通过工作空间进程管理执行，无超时限制。
文件操作工具（read_file、write_file 等）的相对路径基于此目录解析。`);

  // ── Plan Mode 系统提示词 — 告知 AI plan_track 工具和追踪规则 ──
  if (ctx.mode === 'plan') {
    systemPromptParts.push(`[Plan Mode 执行规则]
你当前处于 Plan Mode（先规划后执行）。重要规则：
1. 第一轮回复必须是执行计划，不要直接调用工具。列出步骤、涉及工具和预期结果后，等待用户批准。
2. 计划批准后，每一次完成一个步骤，必须调用 plan_track(action='mark_done', step_index=N) 标记该步骤已完成。
3. 每轮思考前系统会自动注入当前执行进度。请对照进度确保所有步骤最终都被标记为完成。
4. 所有步骤完成后调用 plan_track(action='mark_all_done') 或直接给出最终回答。`);
  }

  // ── v0.12.0: 渐进式披露 — 项目索引（始终保留在上下文中）──
  if (workspaceDir) {
    try {
      const projectIndex = await buildProjectIndex(workspaceDir);
      const indexContext = buildIndexContext(projectIndex);
      if (indexContext) {
        systemPromptParts.push(indexContext);
        logInfo('项目索引已注入系统提示词', `${projectIndex.tokenCount} tokens`);
      }
    } catch { /* 索引构建失败不影响主流程 */ }
  }
  }

  // ── 注入操作系统环境信息（静态区）──
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

  // ── v0.12.1: 反幻觉铁律（注入最高优先级）──
  systemPromptParts.push(`[反幻觉铁律 — 最高优先级，不可违反]

⚠️ 以下规则高于一切其他指令，违反将导致任务失败：

1. **禁止编造工具结果**：绝对不能在未调用工具的情况下声称"已搜索"、"已获取"、"已写入"、"已执行"。如果你没有调用过某个工具，就不能说使用了它。
2. **文件操作必须实际执行**：说"已写入文件"之前，必须先调用 write_file 并收到成功返回。说"已读取文件"之前，必须先调用 read_file。
3. **搜索必须实际执行**：说"搜索结果显示"、"根据搜索结果"之前，必须先调用 web_search。搜索结果的 snippet 不可信，必须用 web_fetch 获取完整内容后才能引用。
4. **信息不足时如实报告**：如果工具调用失败或返回了意外的结果，必须如实报告，不能编造替代信息。
5. **完成标志**：当所有必需的工具调用已经实际执行完毕，且获得了足够的信息后，才能给出最终回答。最终回答中不要编造"文件已生成"等声明——除非你真的调用了对应工具。

违反以上任何一条都是不可接受的错误。请逐条对照检查你的每一次回复。`);

  // ── 实时日期（动态区）──
  const _now = new Date();
  const realDate = `${_now.getFullYear()}年${_now.getMonth() + 1}月${_now.getDate()}日`;

  const fullSystemPrompt = [
    ...systemPromptParts,
    `[日期] ${realDate}（此日期来自系统时钟，绝对可信。你的训练数据可能已过时，请以此日期为准构造所有搜索查询和时效性回答。绝对不要基于训练数据推断日期。）`
  ].join('\n\n');

  ctx.messages.push({ role: 'system', content: fullSystemPrompt });

  // 保存完整系统提示词
  const allSystemContent = ctx.messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n\n');
  state.set('_lastSystemPrompt', allSystemContent || fullSystemPrompt);

  // 添加历史消息
  for (const msg of historyMessages) {
    ctx.messages.push({
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
  ctx.messages.push(userMsg);

  // 上下文窗口管理：滑动窗口 + 摘要压缩 + token 裁剪
  const numCtx = state.get<number>(KEYS.NUM_CTX, 24576);
  const contextResult = buildContext(ctx.messages, { maxTokens: numCtx, windowSize: 20 });
  ctx.messages.length = 0;
  ctx.messages.push(...contextResult);

  // 自动压缩检测
  if (shouldAutoCompress(ctx.messages, numCtx)) {
    logInfo(`自动上下文压缩触发: tokens≈${estimateTokens(ctx.messages.map(m => m.content || '').join(''))} > ${Math.floor(numCtx * AUTO_COMPRESS_THRESHOLD)} (50% of ${numCtx})`);
    const compressAC = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER) || new AbortController();
    try {
      const compressed = await compressWithLLM(ctx.messages, api as any, model, { abortController: compressAC });
      if (compressed.length < ctx.messages.length || estimateTokens(compressed.map(m => m.content || '').join('')) < estimateTokens(ctx.messages.map(m => m.content || '').join(''))) {
        ctx.messages.length = 0;
        ctx.messages.push(...compressed);
        logSuccess(`自动上下文压缩完成: 剩余 ${ctx.messages.length} 条消息`);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      logWarn('自动上下文压缩失败，继续使用当前上下文', (err as Error).message);
    }
  }

  logInfo(`ReAct Agent Loop 启动: ${model}`, `工具: ${useTools ? '开启' : '关闭'}, 记忆: ${isMemoryEnabled() ? '开启' : '关闭'}, 模式: ${ctx.mode}, tokens≈${estimateTokens(ctx.messages.map(m => m.content || '').join(''))}`);

  // ── v0.12.0 Plan Mode: 如果是 plan 模式，先注入计划提示 ──
  if (ctx.mode === 'plan' && ctx.loopCount === 0) {
    ctx.messages.push({
      role: 'user' as const,
      content: `[Plan Mode] 请先分析任务，列出执行计划（包括需要的工具、步骤和预期结果），然后等待我的确认。不要直接执行工具调用。`,
      ephemeral: true,
    });
  }

  return;
}

/** 按 token 预算截断文本（约 1.5 中文字/token, 4 英文字符/token） */
function truncateByTokenBudget(text: string, maxTokens: number): string {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;
  // 按比例截取
  const ratio = maxTokens / estimated;
  const cutAt = Math.floor(text.length * ratio * 0.9); // 保守一点
  return text.slice(0, cutAt) + '\n\n... (已截断以控制 Token 预算)';
}

/** 从 Plan Mode 输出中提取步骤列表 */
function extractPlanSteps(content: string): string[] {
  const steps: string[] = [];
  const stepRegex = /(?:^|\n)\s*(?:\d+[\.\)、]\s*|[-*]\s+)(.+)/g;
  let match;
  while ((match = stepRegex.exec(content)) !== null) {
    const step = match[1].trim();
    if (step.length > 5 && step.length < 200) {
      steps.push(step);
    }
  }
  return steps.length > 0 ? steps.slice(0, 10) : ['执行任务计划（详见上方描述）'];
}

/**
 * v0.12.1: 中途幻觉检测 — 轻量级检查
 * 仅检查最关键的几类幻觉（文件写入、搜索、命令执行）
 * 完整检查在 Completion Gate 中
 */
function detectMidTaskHallucination(
  content: string,
  allToolRecords: Array<{ name: string }>,
): string | null {
  const called = new Set(allToolRecords.map(r => r.name));

  // 多维度幻觉检测（按置信度排序）
  const rules: Array<{ re: RegExp; tools: string[]; msg: string }> = [
    // 文件操作类
    { re: /已(写入|创建|生成).*文件/, tools: ['write_file'], msg: '声称已写入/创建文件' },
    { re: /已成功(写入|创建|保存)/, tools: ['write_file'], msg: '声称文件操作成功' },
    { re: /已(编辑|修改|更新)了?(文件|代码)/, tools: ['edit_file', 'replace_in_files'], msg: '声称编辑了文件' },
    { re: /已(删除|移除)了?.*(文件|目录)/, tools: ['delete_file'], msg: '声称删除了文件' },
    { re: /已(移动|重命名|复制)了?.*(文件|目录)/, tools: ['move_file', 'copy_file'], msg: '声称移动/复制了文件' },
    { re: /已创建了?(目录|文件夹)/, tools: ['create_directory'], msg: '声称创建了目录' },
    { re: /已(下载|获取)了?.*文件/, tools: ['download_file', 'web_fetch'], msg: '声称下载了文件' },
    // 搜索类
    { re: /搜索(结果|到|显示).*(条|个)/, tools: ['web_search', 'web_fetch'], msg: '声称获得了搜索结果' },
    { re: /记忆.*(搜索到|找到|显示)/, tools: ['memory_search'], msg: '声称搜索了记忆' },
    // 命令执行类
    { re: /运行(了|的)?(命令|脚本).*(成功|输出|结果)/, tools: ['run_command'], msg: '声称执行了命令' },
    { re: /(git|提交|推送|合并).*(成功|完成)/, tools: ['git'], msg: '声称执行了 Git 操作' },
    // 浏览器类
    { re: /(打开|浏览)了?.*(网页|页面|浏览器)/, tools: ['browser_open', 'browser_screenshot', 'browser_extract'], msg: '声称使用了浏览器' },
    { re: /截图了?(页面|屏幕|网页)/, tools: ['browser_screenshot'], msg: '声称截取了页面' },
    // 压缩类
    { re: /(压缩|解压|打包).*(成功|完成)/, tools: ['compress'], msg: '声称执行了压缩/解压操作' },
    // 记忆类
    { re: /(已记住|保存了|存储了|添加到记忆)/, tools: ['memory_add', 'memory_replace'], msg: '声称保存了记忆' },
  ];

  for (const rule of rules) {
    if (rule.re.test(content) && !rule.tools.some(t => called.has(t))) {
      return `${rule.msg}但对应工具从未被实际调用。`;
    }
  }
  return null;
}

/**
 * 多步骤任务待办检测 — 解析用户请求中的动作动词，对比已完成的工具调用
 * 返回尚未完成的任务描述列表
 */
function detectPendingActions(
  userText: string,
  allToolRecords: Array<{ name: string }>,
): string[] {
  const called = new Set(allToolRecords.map(r => r.name));
  const pending: string[] = [];
  const txt = userText.toLowerCase();

  // 动作 → 必需工具映射
  const ACTION_MAP: Array<{ keywords: string[]; tools: string[]; label: string }> = [
    { keywords: ['搜索', '查找', '查一下', '搜一下', 'search', '检索', '查询'], tools: ['web_search'], label: '搜索/查找信息' },
    { keywords: ['抓取', 'fetch', '获取内容', '抓取全文'], tools: ['web_fetch'], label: '抓取网页详细内容' },
    { keywords: ['生成', '写入', '创建文件', '保存', '输出.*文件', '放到.*工作空间', '写.*文件', '生成.*文件', '存入'], tools: ['write_file'], label: '创建/写入文件' },
    { keywords: ['运行', '执行', 'run', '启动', '编译'], tools: ['run_command'], label: '执行命令/脚本' },
    { keywords: ['下载', 'download'], tools: ['download_file'], label: '下载文件' },
    { keywords: ['提交', 'commit', '推送', 'push', '暂存', 'add'], tools: ['git'], label: 'Git 操作' },
    { keywords: ['删除', '移除', 'delete', 'remove'], tools: ['delete_file'], label: '删除文件' },
    { keywords: ['移动', 'move', '重命名', 'rename'], tools: ['move_file'], label: '移动/重命名文件' },
    { keywords: ['复制', 'copy'], tools: ['copy_file'], label: '复制文件' },
    { keywords: ['压缩', '解压', 'compress', 'zip', 'tar'], tools: ['compress'], label: '压缩/解压' },
    { keywords: ['打开网页', '浏览器', 'browser', '截图'], tools: ['browser_open', 'browser_screenshot', 'browser_extract'], label: '浏览器操作' },
  ];

  for (const action of ACTION_MAP) {
    const mentioned = action.keywords.some(kw => new RegExp(kw, 'i').test(txt));
    if (mentioned) {
      const completed = action.tools.some(t => called.has(t));
      if (!completed) {
        pending.push(action.label);
      }
    }
  }

  return pending;
}

/**
 * v0.12.1: 通用工具结果核验 — 对所有写类工具执行后验证
 * 读取/搜索类工具已有返回结果作为验证，此处只核验会产生副作用的操作
 */
const TOOLS_NEED_VERIFY = new Set([
  'write_file', 'edit_file', 'delete_file', 'create_directory',
  'move_file', 'copy_file', 'download_file',
]);

async function verifyToolResult(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  if (!TOOLS_NEED_VERIFY.has(toolName) || !result.success) return;

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) return;

  try {
    switch (toolName) {
      case 'write_file': {
        const path = String(args.path || '');
        const expected = String(args.content || '');
        const read = await bridge.tool.execute('read_file', { path, mode: 'text' });
        if (read.success) {
          const actual = String(read.content || '');
          if (actual.length === 0) {
            logWarn(`核验 write_file: ${path} 内容为空`);
          } else if (Math.abs(actual.length - expected.length) > expected.length * 0.5) {
            logWarn(`核验 write_file: ${path} 期望 ${expected.length}B 实际 ${actual.length}B`);
          } else {
            logInfo(`核验 write_file ✅: ${path} (${actual.length}B)`);
          }
        }
        break;
      }
      case 'edit_file': {
        const path = String(args.path || '');
        const newText = String(args.new_text || '');
        const read = await bridge.tool.execute('read_file', { path, mode: 'text' });
        if (read.success) {
          const actual = String(read.content || '');
          if (!actual.includes(newText)) {
            logWarn(`核验 edit_file: ${path} 不包含期望的新内容`);
          } else {
            logInfo(`核验 edit_file ✅: ${path}`);
          }
        }
        break;
      }
      case 'delete_file': {
        const path = String(args.path || '');
        const info = await bridge.tool.execute('get_file_info', { path });
        if (info.success) {
          logWarn(`核验 delete_file: ${path} 仍然存在，删除未生效`);
        } else {
          logInfo(`核验 delete_file ✅: ${path} 已不存在`);
        }
        break;
      }
      case 'create_directory': {
        const path = String(args.path || '');
        const info = await bridge.tool.execute('get_file_info', { path });
        if (info.success && (info as any).type === 'directory') {
          logInfo(`核验 create_directory ✅: ${path}`);
        } else {
          logWarn(`核验 create_directory: ${path} 未成功创建`);
        }
        break;
      }
      case 'move_file': {
        const src = String(args.source || '');
        const dest = String(args.destination || '');
        const [srcInfo, destInfo] = await Promise.all([
          bridge.tool.execute('get_file_info', { path: src }),
          bridge.tool.execute('get_file_info', { path: dest }),
        ]);
        if (srcInfo.success) {
          logWarn(`核验 move_file: 源文件 ${src} 仍然存在`);
        } else if (destInfo.success) {
          logInfo(`核验 move_file ✅: ${src} → ${dest}`);
        } else {
          logWarn(`核验 move_file: ${src}→${dest} 源和目标均不存在`);
        }
        break;
      }
      case 'copy_file': {
        const dest = String(args.destination || '');
        const destInfo = await bridge.tool.execute('get_file_info', { path: dest });
        if (destInfo.success) {
          logInfo(`核验 copy_file ✅: ${dest} (${(destInfo as any).size}B)`);
        } else {
          logWarn(`核验 copy_file: 目标 ${dest} 不存在`);
        }
        break;
      }
      case 'download_file': {
        const dest = String(args.destination || '');
        const info = await bridge.tool.execute('get_file_info', { path: dest });
        if (info.success && (info as any).size > 0) {
          logInfo(`核验 download_file ✅: ${dest} (${(info as any).size}B)`);
        } else {
          logWarn(`核验 download_file: ${dest} 不存在或为空`);
        }
        break;
      }
    }
  } catch { /* 核验失败不阻塞主流程 */ }
}

/**
 * THINKING 状态：调用 LLM 流式
 */
async function handleThinking(
  ctx: LoopContext,
  api: OllamaAPI,
  model: string,
  callbacks: AgentCallbacks,
): Promise<void> {
  ctx.loopCount++;
  logAgentLoop(ctx.loopCount, ctx.maxLoops);

  ctx.content = '';
  ctx.thinking = '';
  ctx.toolCalls.length = 0;

  // ── Plan Mode 执行进度注入 — 每次思考前展示当前状态 ──
  if (ctx.mode === 'plan' && ctx.loopCount >= 1) {
    const tracker = getPlanTracker();
    if (tracker.active && tracker.steps.length > 0) {
      const status = formatPlanStatus();
      if (status) {
        ctx.messages.push({ role: 'user', content: status, ephemeral: true });
      }
    }
  }

  // ── v0.12.1: 任务感知 — 检测用户请求需要工具但模型尚未行动 ──
  if (ctx.loopCount === 2 && ctx.allToolRecords.length === 0) {
    // 从用户第一条消息中检测是否需要工具
    const firstUserMsg = ctx.messages.find(m => m.role === 'user');
    const userText = (firstUserMsg?.content || '').toLowerCase();
    const actionVerbs = ['搜索', '查找', '查', '写入', '创建', '生成', '运行', '执行', '打开', '抓取',
      '获取', '下载', '提交', '推送', '克隆', '读取', '删除', '移动', '复制', '压缩',
      'search', 'find', 'write', 'create', 'run', 'execute', 'fetch', 'download', 'clone'];
    const needsTools = actionVerbs.some(v => userText.includes(v)) && userText.length > 20;
    if (needsTools) {
      ctx.messages.push({
        role: 'user',
        content: '⚠️ 你的任务需要调用工具才能完成。请不要用文字描述"你会怎么做"，而是直接调用对应的工具（web_search、write_file 等）来实际执行。如果你不确定调用哪个工具，查看可用工具列表。',
        ephemeral: true,
      });
      logInfo('任务感知: 检测到可能需要工具但尚未调用，注入提醒');
    }
  }

  // ── 多步骤任务待办追踪 — 用户一句话里有多个动作时，提醒未完成的 ──
  if (ctx.loopCount >= 2 && ctx.allToolRecords.length > 0) {
    const firstUserMsg = ctx.messages.find(m => m.role === 'user');
    const userText = firstUserMsg?.content || '';
    const pending = detectPendingActions(userText, ctx.allToolRecords);
    if (pending.length > 0) {
      ctx.messages.push({
        role: 'user',
        content: `⚠️ 你还有以下未完成的任务（来自用户原始请求）：\n${pending.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}\n\n请继续执行，完成所有任务后再给出最终回答。`,
        ephemeral: true,
      });
      logInfo('待办追踪: 注入未完成任务提醒', pending.join(', '));
    }
  }

  // Token 预算警告
  const remaining = ctx.maxLoops - ctx.loopCount + 1;
  if (remaining <= 5 && remaining > 0) {
    const warning = remaining <= 2
      ? `\n⚠️ CRITICAL: You have only ${remaining} iteration(s) left. Stop using tools and provide your final answer NOW.`
      : `\n⚠️ WARNING: You have approximately ${remaining} iterations remaining. Start wrapping up and prepare your final answer.`;
    ctx.messages.push({ role: 'system', content: warning, ephemeral: true });
  }

  const abortController = new AbortController();
  state.set(KEYS.ABORT_CONTROLLER, abortController);

  const STREAM_TIMEOUT_MS = state.get<number>('streamTimeout', 300_000);
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  if (STREAM_TIMEOUT_MS > 0) {
    streamTimer = setTimeout(() => {
      logWarn(`流式调用超时 (${STREAM_TIMEOUT_MS / 1000}s)，中止本轮`);
      abortController.abort();
    }, STREAM_TIMEOUT_MS);
  }

  let progressTimer: ReturnType<typeof setInterval> | null = null;

  try {
    const streamStartTime = Date.now();
    let lastLoggedLen = 0;
    let lastContentTime = streamStartTime;

    resetStreamProgress();

    progressTimer = setInterval(() => {
      const elapsed = Date.now() - streamStartTime;
      const grew = ctx.content.length - lastLoggedLen;
      const sec = Math.round(elapsed / 1000);
      if (grew > 0) {
        lastLoggedLen = ctx.content.length;
        lastContentTime = Date.now();
        logStreamProgress(`流式输出中… ${ctx.content.length} 字 / ${sec}s${ctx.toolCalls.length > 0 ? ` [${ctx.toolCalls.length} 个工具调用]` : ''}`);
      } else if (ctx.content.length > 0) {
        const idleSec = Math.round((Date.now() - lastContentTime) / 1000);
        if (idleSec >= 10) {
          logStreamProgress(`⚠️ ${idleSec}s 无新内容，当前 ${ctx.content.length} 字`);
        }
      } else {
        logStreamProgress(`⏳ 等待模型响应… ${sec}s`);
      }
    }, 15000);

    await api.chatStream(
      {
        model,
        messages: ctx.messages,
        stream: true,
        think: state.get<boolean>('thinkEnabled', false),
        options: {
          num_ctx: state.get<number>(KEYS.NUM_CTX, 24576),
          temperature: state.get<number>('temperature', 0.7)
        },
        ...(getEnabledToolDefinitions().length > 0 && { tools: getEnabledToolDefinitions() })
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
        if (chunk.eval_count) { ctx.loopEvalCount = chunk.eval_count; }
        if (chunk.prompt_eval_count) { ctx.loopPromptEvalCount = chunk.prompt_eval_count; }
        if (chunk.total_duration) { ctx.loopInferenceNs = chunk.total_duration; }
        if (chunk.message?.tool_calls?.length) {
          for (const tc of chunk.message.tool_calls) {
            if (tc.function?.name) {
              let parsedArgs: Record<string, unknown> = {};
              if (tc.function.arguments) {
                if (typeof tc.function.arguments === 'string') {
                  try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = {}; }
                } else if (typeof tc.function.arguments === 'object') {
                  parsedArgs = tc.function.arguments as Record<string, unknown>;
                }
              }
              const isNewTool = !ctx.toolCalls.some(existing => existing.function.name === tc.function.name);
              if (isNewTool && callbacks.onToolCallPrepare) {
                callbacks.onToolCallPrepare({
                  type: 'function',
                  function: { name: tc.function.name, arguments: parsedArgs }
                });
              }
              ctx.toolCalls.push({
                type: 'function',
                function: { name: tc.function.name, arguments: parsedArgs }
              });
            } else if (ctx.toolCalls.length > 0) {
              const last = ctx.toolCalls[ctx.toolCalls.length - 1];
              if (tc.function?.arguments) {
                let chunkArgs: Record<string, unknown> | null = null;
                if (typeof tc.function.arguments === 'string') {
                  try { chunkArgs = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
                } else if (typeof tc.function.arguments === 'object') {
                  chunkArgs = tc.function.arguments as Record<string, unknown>;
                }
                if (chunkArgs) { Object.assign(last.function.arguments, chunkArgs); }
              }
            }
          }
        }
      },
      abortController
    );

    // 累加 token 统计
    ctx.totalEvalCount += ctx.loopEvalCount;
    ctx.totalPromptEvalCount += ctx.loopPromptEvalCount;
    ctx.totalInferenceNs += ctx.loopInferenceNs;
    state.set('_currentEvalCount', ctx.totalEvalCount);

    // Token 校准
    try {
      if (ctx.loopEvalCount > 0 || ctx.loopPromptEvalCount > 0) {
        const estimatedThisLoop = estimateTokens(ctx.messages.map(m => m.content || '').join(''));
        if (estimatedThisLoop > 0) {
          recordActualTokens(ctx.loopPromptEvalCount, ctx.loopEvalCount, estimatedThisLoop);
        }
      }
    } catch { /* ignore */ }

    // 重置本轮计数器
    ctx.loopEvalCount = 0;
    ctx.loopPromptEvalCount = 0;
    ctx.loopInferenceNs = 0;

    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    if (progressTimer) clearInterval(progressTimer as unknown as number);

    transition(ctx, S.PARSING);

  } catch (err) {
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    if (progressTimer) clearInterval(progressTimer as unknown as number);
    if (abortController.signal.aborted) {
      logInfo('流式调用已中止');
      if (ctx.allToolRecords.length > 0) { state.set('_abortToolRecords', ctx.allToolRecords); }
      throw err;
    }
    logError('流式调用异常', (err as Error).message);
    if (ctx.content || ctx.thinking) {
      ctx.messages.push({ role: 'assistant', content: ctx.content || '（模型响应异常）', ...(ctx.thinking && { thinking: ctx.thinking }) });
    }
    callbacks.onDone(ctx.content || '（模型响应异常，已自动中断）', ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined, makeStats(ctx));
    transition(ctx, S.TERMINATED);
  }
}

/**
 * PARSING 状态：解析模型输出，提取工具调用和文本兜底
 */
async function handleParsing(ctx: LoopContext): Promise<void> {
  // 保存 assistant 消息
  const assistantMsg: OllamaMessage = {
    role: 'assistant',
    content: ctx.content,
    ...(ctx.thinking && { thinking: ctx.thinking })
  };
  if (ctx.toolCalls.length > 0) {
    assistantMsg.tool_calls = ctx.toolCalls;
  }
  ctx.messages.push(assistantMsg);

  logModelResponse(ctx.content.length, ctx.toolCalls.length);

  // 文本解析兜底
  if (ctx.toolCalls.length === 0 && getEnabledToolDefinitions().length > 0) {
    const parsedCalls = parseToolCallsFromText(ctx.content);
    if (parsedCalls.length > 0) {
      ctx.toolCalls.push(...parsedCalls);
    }
  }

  if (ctx.toolCalls.length > 0) {
    transition(ctx, S.EXECUTING);
  } else {
    transition(ctx, S.REFLECTING);
  }
}

/**
 * EXECUTING 状态：执行工具（按批次并行）
 */
async function handleExecuting(
  ctx: LoopContext,
  callbacks: AgentCallbacks,
): Promise<void> {
  // 跨轮次去重检测
  const currentLoopKeys = ctx.toolCalls.map(c => getToolCacheKey(c.function.name, c.function.arguments)).sort();
  const currentKeysStr = JSON.stringify(currentLoopKeys);
  const prevKeysStr = JSON.stringify([...ctx.prevLoopSuccessKeys].sort());
  if (currentKeysStr === prevKeysStr && currentLoopKeys.length > 0) {
    const hasFailedInPrev = ctx.allToolRecords
      .filter(r => ctx.prevLoopSuccessKeys.includes(getToolCacheKey(r.name, r.arguments)))
      .some(r => r.status !== 'success');
    if (!hasFailedInPrev) {
      logWarn('检测到连续两轮工具调用完全相同且全部成功，注入提醒而非终止');
      ctx.messages.push({
        role: 'user',
        content: '⚠️ 检测到你连续调用了与上一轮完全相同的工具。请基于已有结果给出最终回答，或者调用不同的工具获取新信息。如果任务已完成，请给出最终回答。'
      });
      transition(ctx, S.THINKING);
      return;
    }
    logInfo('检测到重复调用但上一轮有失败，允许重试');
  }

  // ── 工具并行执行：批次划分 ──
  const batches: ToolCall[][] = [];
  let currentBatch: ToolCall[] = [];

  for (const call of ctx.toolCalls) {
    if (currentBatch.length === 0) {
      currentBatch.push(call);
    } else if (ALWAYS_PARALLEL.has(call.function.name)) {
      currentBatch.push(call);
    } else {
      const needsPrevResult = currentBatch.some(prev =>
        TOOLS_WITH_DATA_DEPS.has(call.function.name) && prev.function.name !== call.function.name
      );
      if (needsPrevResult) {
        batches.push(currentBatch);
        currentBatch = [call];
      } else {
        currentBatch.push(call);
      }
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  if (batches.length > 1) {
    logInfo(`工具并行执行: ${ctx.toolCalls.length} 个工具 → ${batches.length} 批次（首批 ${batches[0].length} 个并行）`);
  }

  /** 执行单个工具（含重试） */
  const executeSingleTool = async (call: ToolCall): Promise<[ToolCallRecord, string | null]> => {
    const cacheKey = getToolCacheKey(call.function.name, call.function.arguments);

    if (isDuplicateCall(call, ctx.toolCalls)) {
      logWarn(`跳过重复工具调用: ${call.function.name}`);
      const cached = toolResultCache.get(cacheKey);
      if (cached) {
        return [{
          name: call.function.name, arguments: call.function.arguments,
          result: cached.result, status: 'success' as const, timestamp: Date.now()
        }, null];
      }
    }

    const cachedEntry = toolResultCache.get(cacheKey);
    if (cachedEntry && isCacheValid(call.function.name, cachedEntry.timestamp)) {
      logInfo(`工具缓存命中: ${call.function.name}`);
      return [{
        name: call.function.name, arguments: call.function.arguments,
        result: cachedEntry.result, status: 'success' as const, timestamp: Date.now()
      }, null];
    }
    if (cachedEntry) {
      toolResultCache.delete(cacheKey);
    }

    await new Promise(r => requestAnimationFrame(r));
    callbacks.onToolCallStart(call);
    logToolStart(call.function.name, JSON.stringify(call.function.arguments));

    // ── v0.12.0: pre_tool Hook ──
    await executeHooks('pre_tool', ctx, { toolName: call.function.name, toolArgs: call.function.arguments });

    await new Promise(r => requestAnimationFrame(r));

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

    let lastError = '';
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      // 重试前检查中止信号
      if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) {
        return [{
          name: call.function.name, arguments: call.function.arguments,
          result: { success: false, error: '用户中止' },
          status: 'cancelled' as const, timestamp: Date.now()
        }, null];
      }
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
    return [{
      name: call.function.name, arguments: call.function.arguments,
      result: { success: false, error: lastError }, status: 'error' as const, timestamp: Date.now()
    }, null];
  };

  // 按批次执行
  for (const batch of batches) {
    if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) {
      callbacks.onDone(ctx.content, ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined, makeStats(ctx));
      transition(ctx, S.TERMINATED);
      return;
    }

    const results = await Promise.all(batch.map(call => executeSingleTool(call)));

    for (const [record, cacheKey] of results) {
      ctx.allToolRecords.push(record);
      ctx.messages.push({
        role: 'tool', tool_name: record.name,
        content: formatToolResultForModel(record.name, record.result!)
      });
      if (cacheKey) toolResultCache.set(cacheKey, { result: record.result!, timestamp: Date.now() });
      // 记录度量
      recordToolCall(record.name, record.status, Date.now() - record.timestamp);
      // ── v0.12.1: 通用工具结果核验 — 所有写类工具执行后验证 ──
      if (record.status === 'success') {
        verifyToolResult(record.name, record.arguments, record.result!);
      }
      // ── v0.12.0: post_tool Hook ──
      executeHooks('post_tool', ctx, { toolName: record.name, toolArgs: record.arguments, toolResult: record.result! });
      if (record.status === 'success') {
        callbacks.onToolCallResult(record.name, record.result!, batch.find(c => c.function.name === record.name)!);
      } else if (record.status === 'cancelled') {
        callbacks.onToolCallError(record.name, '用户取消', batch.find(c => c.function.name === record.name)!);
      } else {
        callbacks.onToolCallError(record.name, record.result?.error || '执行失败', batch.find(c => c.function.name === record.name)!);
      }
    }
  }

  transition(ctx, S.OBSERVING);
}

/**
 * OBSERVING 状态：收集结果、裁剪旧消息、更新去重键
 */
async function handleObserving(
  ctx: LoopContext,
  currentSession: ChatSession | null,
): Promise<void> {
  // 中止检查
  if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) return;
  // 硬限制工具消息数量 — 保留最近 40 条
  {
    const toolIndices: number[] = [];
    for (let i = 0; i < ctx.messages.length; i++) {
      if (ctx.messages[i].role === 'tool') toolIndices.push(i);
    }
    if (toolIndices.length > 40) {
      const toRemove = toolIndices.slice(0, toolIndices.length - 40);
      for (let i = toRemove.length - 1; i >= 0; i--) {
        ctx.messages.splice(toRemove[i], 1);
      }
      logInfo(`工具消息裁剪: ${toRemove.length} 条旧结果已移除 (保留最近 40 条)`);
    }
  }

  // 更新跨轮去重
  ctx.prevLoopSuccessKeys = ctx.allToolRecords
    .filter(r => r.status === 'success')
    .map(r => getToolCacheKey(r.name, r.arguments));

  // 增量记忆提取 — 每 20 轮
  if (isMemoryEnabled() && ctx.loopCount > 1 && ctx.loopCount % 20 === 0 && ctx.messages.length >= 10) {
    import('./memory-manager.js').then(({ extractMemoriesFromConversation }) => {
      const recentMsgs = ctx.messages.slice(-30).filter(m => m.role === 'user' || m.role === 'assistant');
      extractMemoriesFromConversation(
        recentMsgs.map(m => ({ role: m.role, content: m.content })),
        currentSession?.title
      ).then(() => logInfo('增量记忆提取完成', `第 ${ctx.loopCount} 轮`))
       .catch(() => {});
    }).catch(() => {});
  }

  // 保存本轮工具调用
  ctx.prevToolCalls = [...ctx.toolCalls];

  // 记录本轮迭代度量
  recordIteration(ctx);

  // ── v0.12.0: post_iteration Hook ──
  executeHooks('post_iteration', ctx, { iterationIndex: ctx.loopCount });

  // 增量工具结果截断 — 超过 10 轮的旧结果每 3 轮截断到 500 字符
  if (ctx.loopCount > 10 && ctx.loopCount % 3 === 0) {
    const truncateBefore = ctx.messages.length - 15;
    for (let i = 0; i < ctx.messages.length && i < truncateBefore; i++) {
      const m = ctx.messages[i];
      if (m.role === 'tool' && m.content && m.content.length > 500) {
        ctx.messages[i] = { ...m, content: m.content.slice(0, 500) + '\n... (已截断旧工具结果)' };
      }
    }
  }

  // ── v0.12.1: 进度锚定 — 每 5 轮注入机器生成的工具调用摘要 ──
  if (ctx.loopCount > 1 && ctx.loopCount % 5 === 0 && ctx.allToolRecords.length > 0) {
    const recentRecords = ctx.allToolRecords.slice(-10);
    const summary = recentRecords.map(r => {
      const statusIcon = r.status === 'success' ? '✅' : r.status === 'error' ? '❌' : '🔄';
      const argsPreview = r.arguments ? JSON.stringify(r.arguments).slice(0, 60) : '';
      return `${statusIcon} ${r.name}(${argsPreview}${argsPreview.length >= 60 ? '…' : ''})`;
    }).join('\n');
    ctx.messages.push({
      role: 'user',
      content: `[进度锚点 #${ctx.loopCount}] 以下是你最近实际调用的工具（由系统记录，不可伪造）：\n${summary}\n\n请基于以上真实记录继续。不要声称执行过未在列表中出现的操作。`,
      ephemeral: true,
    });
      logInfo('进度锚点已注入', `第 ${ctx.loopCount} 轮, ${recentRecords.length} 条记录`);
  }

  // ── v0.12.1: 中途幻觉检测 — 每轮检查模型是否在无工具调用时声称完成了操作 ──
  const lastAssistantMsg = [...ctx.messages].reverse().find(m => m.role === 'assistant');
  if (lastAssistantMsg?.content) {
    const midHallucination = detectMidTaskHallucination(lastAssistantMsg.content, ctx.allToolRecords);
    if (midHallucination) {
      logWarn(`中途幻觉检测: ${midHallucination}`);
      ctx.messages.push({
        role: 'user',
        content: `⚠️ ${midHallucination}\n请实际调用对应工具来完成操作，不要用文字描述来替代。`,
        ephemeral: true,
      });
    }
  }

  // 每 10 轮清理累积的 ephemeral 消息
  if (ctx.loopCount > 1 && ctx.loopCount % 10 === 0) {
    let removed = 0;
    ctx.messages = ctx.messages.filter(m => {
      if (m.ephemeral) { removed++; return false; }
      return true;
    });
    if (removed > 0) logInfo(`ephemeral 清理: ${removed} 条临时消息已移除`);
  }

  transition(ctx, S.REFLECTING);
}

/**
 * REFLECTING 状态：反思
 *
 * 核心原则：模型不调工具 = 模型认为完成了。信任模型的判断。
 * 仅在明确的异常情况下介入（空响应、Plan Mode 确认、超最大轮次）。
 */
async function handleReflecting(
  ctx: LoopContext,
  callbacks: AgentCallbacks,
  currentSession: ChatSession | null,
): Promise<void> {
  // 中止检查
  if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) return;
  // ── 异常1: 空响应 + 有工具历史 → 模型可能困惑 → 注入提示 ──
  if (ctx.toolCalls.length === 0 && !ctx.content.trim() && ctx.loopCount > 1 && ctx.allToolRecords.length > 0) {
    logWarn('模型返回空内容（有未处理的工具结果），注入继续提示');
    ctx.messages.pop();
    ctx.messages.push({
      role: 'user',
      content: '请根据上面的工具调用结果继续回答。如果需要更多信息，可以继续调用工具。如果已有足够信息，请给出最终回答。'
    });
    transition(ctx, S.THINKING);
    return;
  }

  // ── Plan Mode: 第一轮回复 → 检测是否为计划 → 等待用户确认 ──
  if (ctx.mode === 'plan' && ctx.loopCount === 1 && ctx.toolCalls.length === 0 && ctx.content.length > 50) {
    const isPlanLike = /计划|步骤|step|plan|思路|方案|流程/.test(ctx.content.slice(0, 200));
    if (isPlanLike && callbacks.onPlanReady) {
      const steps = extractPlanSteps(ctx.content);
      const approved = await callbacks.onPlanReady(ctx.content, steps);
      if (!approved) {
        ctx.planRetries++;
        if (ctx.planRetries >= 3) {
          logWarn('Plan Mode: 达到最大重试次数 (3)，强制进入执行模式');
          ctx.messages.push({
            role: 'user',
            content: '已达到最大计划重试次数。请基于当前计划直接开始执行任务。',
            ephemeral: true,
          });
          ctx.loopCount = 0;
          transition(ctx, S.THINKING);
          return;
        }
        logInfo('Plan Mode: 用户拒绝计划，重新规划');
        ctx.messages.push({
          role: 'user',
          content: '请基于反馈重新规划。调整你的方案后再次输出计划。',
          ephemeral: true,
        });
        ctx.loopCount = 0;
        transition(ctx, S.THINKING);
        return;
      }
      logInfo('Plan Mode: 用户批准计划，开始执行');
      // 初始化 Plan Tracker，追踪每个步骤的完成状态
      if (steps.length > 0) {
        initPlanTracker(steps);
        logInfo('Plan Tracker 已启动', `${steps.length} 个步骤`);
      }
      // 移除 Plan Mode 的"不要执行工具"约束消息，替换为执行指令
      // 从后往前找到并移除 Plan Mode 提示（ephemeral 标记）
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        if (ctx.messages[i].ephemeral && ctx.messages[i].content?.includes('不要直接执行工具调用')) {
          ctx.messages.splice(i, 1);
          break;
        }
      }
      ctx.messages.push({
        role: 'user',
        content: '计划已批准。现在开始执行——请直接调用工具（web_search、write_file 等）来完成每一步。不要描述计划，直接行动。',
        ephemeral: true,
      });
      transition(ctx, S.THINKING);
      return;
    }
    // 非计划回复（如简单问答）→ 跳过 Plan Mode，直接完成
    if (!isPlanLike) {
      logInfo('Plan Mode: 回复非计划内容，直接完成');
    }
  }

  // ── 异常2: 超出最大轮次 → 强制终止 ──
  if (ctx.loopCount >= ctx.maxLoops) {
    logWarn('ReAct Agent Loop 达到最大迭代次数限制');
    callbacks.onDone(ctx.content || '（达到最大工具调用次数限制）', ctx.allToolRecords, makeStats(ctx));
    transition(ctx, S.TERMINATED);
    return;
  }

  // ── 本轮调用了工具 → 模型需要处理工具结果 → 继续循环 ──
  if (ctx.toolCalls.length > 0) {
    transition(ctx, S.THINKING);
    return;
  }

  // ── 正常终止: 模型停止调工具 → 模型认为任务完成 → 信任模型 ──
  // Completion Gate 分级：阻断级检查（幻觉/注入）不通过则强制重新回答
  // 咨询级检查（notThinking/contentQuality）仅记录日志
  try {
    const gateResult = await runCompletionGate(ctx);
    if (!gateResult.passed) {
      recordCompletionGate(false);
      if (gateResult.critical) {
        // 阻断级失败：强制模型重新回答
        logWarn(`Completion Gate 🔴阻断: ${gateResult.reason}`);
        ctx.messages.push({
          role: 'user',
          content: `⚠️ 完成检查发现严重问题: ${gateResult.reason}\n请修正后重新给出回答。`,
          ephemeral: true,
        });
        transition(ctx, S.THINKING);
        return;
      }
      // 咨询级失败：仅记录，不阻断
      logWarn(`Completion Gate 🟡咨询: ${gateResult.reason}（不阻断）`);
    } else {
      recordCompletionGate(true);
    }
  } catch { /* Gate 异常不影响主流程 */ }

  logInfo('模型停止工具调用 → ReAct Agent Loop 结束');
  clearPlanTracker();
  if (isMemoryEnabled() && ctx.messages.length >= 10) {
    try {
      const { extractMemoriesFromConversation } = await import('./memory-manager.js');
      await extractMemoriesFromConversation(
        ctx.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
        currentSession?.title
      );
    } catch { /* 不阻塞 */ }
  }

  callbacks.onDone(ctx.content || '（模型未返回内容）', ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined, makeStats(ctx));
  transition(ctx, S.TERMINATED);
}

/**
 * COMPRESSING 状态：触发上下文压缩
 */
async function handleCompressing(
  ctx: LoopContext,
  api: OllamaAPI,
  model: string,
): Promise<void> {
  const numCtx = state.get<number>(KEYS.NUM_CTX, 24576);
  if (shouldAutoCompress(ctx.messages, numCtx)) {
    logInfo('COMPRESSING: 上下文压缩触发');
    const compressAC = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER) || new AbortController();
    try {
      const compressed = await compressWithLLM(ctx.messages, api as any, model, { abortController: compressAC });
      if (compressed.length < ctx.messages.length || estimateTokens(compressed.map(m => m.content || '').join('')) < estimateTokens(ctx.messages.map(m => m.content || '').join(''))) {
        ctx.messages.length = 0;
        ctx.messages.push(...compressed);
        logSuccess('COMPRESSING: 完成');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      logWarn('COMPRESSING: 失败', (err as Error).message);
    }
  }
  transition(ctx, S.REFLECTING);
}

// ═══════════════════════════════════════════════════════════════
// Harness: 主入口 — 状态机循环
// ═══════════════════════════════════════════════════════════════

function makeStats(ctx: LoopContext) {
  return {
    eval_count: ctx.totalEvalCount || undefined,
    prompt_eval_count: ctx.totalPromptEvalCount || undefined,
    total_duration: ctx.totalInferenceNs || undefined,
  };
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
  const mode: AgentMode = state.get<AgentMode>('agentMode', 'auto');

  if (!api || !model) {
    showToast('请先选择模型', 'error');
    return;
  }

  // ── 构建 LoopContext ──
  const ctx: LoopContext = {
    state: S.INIT,
    sessionId,
    loopCount: 0,
    maxLoops: state.get<number>('maxTurns', 85),
    content: '',
    thinking: '',
    toolCalls: [],
    allToolRecords: [],
    messages: [],
    totalEvalCount: 0,
    totalPromptEvalCount: 0,
    totalInferenceNs: 0,
    loopEvalCount: 0,
    loopPromptEvalCount: 0,
    loopInferenceNs: 0,
    prevLoopSuccessKeys: [],
    prevToolCalls: [],
    mode,
    planRetries: 0,
    startTime: Date.now(),
  };

  state.set('_loopState', S.INIT);
  persistLoopContext(ctx);
  startSessionMetrics(sessionId, model);
  // Plan Mode 激活时注册 plan_track 工具
  const { setPlanModeActive } = await import('./tool-registry.js');
  setPlanModeActive(mode === 'plan');

  // ── 状态机主循环 ──
  try {
    // Phase 1: INIT
    await handleInit(ctx, api, model, callbacks, userContent, images, historyMessages, currentSession);
    transition(ctx, S.THINKING);

    // Phase 2-7: THINKING → PARSING → EXECUTING → OBSERVING → REFLECTING → (COMPRESSING) → loop
    while (ctx.state !== S.TERMINATED) {
      // ── v0.12.1: 看门狗 — 全局超时熔断（可通过设置 loopWatchdogMs 配置，0=禁用）──
      // 默认 30 分钟，用户强调不要随意加超时限制
      const WATCHDOG_MS = state.get<number>('loopWatchdogMs', 1_800_000);
      if (WATCHDOG_MS > 0 && Date.now() - ctx.startTime > WATCHDOG_MS) {
        logWarn(`看门狗触发: Agent Loop 运行超过 ${WATCHDOG_MS / 60000} 分钟，强制终止`);
        ctx.messages.push({
          role: 'user',
          content: `⚠️ 任务运行时间超过 ${Math.round(WATCHDOG_MS / 60000)} 分钟限制，系统自动终止。请简化任务或分批执行。`,
          ephemeral: true,
        });
        callbacks.onDone(ctx.content || '（看门狗超时终止）', ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined, makeStats(ctx));
        transition(ctx, S.TERMINATED);
        break;
      }

      // ── v0.12.1: 上下文硬上限 — 消息数超阈值强制压缩 ──
      if (ctx.messages.length > MAX_MESSAGES) {
        logWarn(`上下文硬上限触发: ${ctx.messages.length} 条消息 > ${MAX_MESSAGES}，强制压缩`);
        transition(ctx, S.COMPRESSING);
        ctx.state = S.COMPRESSING; // 跳过 transition 验证直接进入（压缩态允许）
        state.set('_loopState', S.COMPRESSING); // 同步全局状态
      }

      // 检查中止信号
      if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) {
        logInfo('ReAct Agent Loop 已中止');
        if (ctx.allToolRecords.length > 0) {
          state.set('_abortToolRecords', ctx.allToolRecords);
        }
        throw new DOMException('Aborted', 'AbortError');
      }

      // Token 感知的动态迭代预算
      const numCtx = state.get<number>(KEYS.NUM_CTX, 24576);
      const usageRatio = estimateTokens(ctx.messages.map(m => m.content || '').join('')) / numCtx;
      if (usageRatio > 0.8 && (ctx.maxLoops - ctx.loopCount) > 3) {
        const newMax = ctx.loopCount + 3;
        logWarn(`上下文使用率 ${(usageRatio * 100).toFixed(0)}%, 限制剩余迭代为 ${newMax - ctx.loopCount} 轮（原 ${ctx.maxLoops - ctx.loopCount} 轮）`);
        ctx.maxLoops = newMax;
      }

      // 非首轮迭代：通知 UI
      if (ctx.loopCount > 0 && callbacks.onNewIteration) {
        callbacks.onNewIteration(ctx.prevToolCalls.length > 0 ? ctx.prevToolCalls : undefined);
      }

      // 状态分发
      switch (ctx.state) {
        case S.THINKING:
          await handleThinking(ctx, api, model, callbacks);
          // handleThinking 内部会 transition 到 PARSING 或 TERMINATED
          break;

        case S.PARSING:
          await handleParsing(ctx);
          // handleParsing 内部会 transition 到 EXECUTING 或 REFLECTING
          break;

        case S.EXECUTING:
          await handleExecuting(ctx, callbacks);
          // handleExecuting 内部会 transition 到 OBSERVING 或 THINKING 或 TERMINATED
          break;

        case S.OBSERVING:
          await handleObserving(ctx, currentSession);
          // handleObserving 内部会 transition 到 REFLECTING
          break;

        case S.REFLECTING:
          await handleReflecting(ctx, callbacks, currentSession);
          // handleReflecting 内部会 transition 到 THINKING / COMPRESSING / TERMINATED
          break;

        case S.COMPRESSING:
          await handleCompressing(ctx, api, model);
          // handleCompressing 内部会 transition 到 REFLECTING
          break;

        default:
          logWarn(`未知状态: ${ctx.state}，强制终止`);
          transition(ctx, S.TERMINATED);
      }

      persistLoopContext(ctx);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // 中止是正常的，但仍需通知 UI 清理状态
      callbacks.onDone(ctx.content || '（已中止）', ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined, makeStats(ctx));
    } else {
      logError('Agent Loop 异常', (err as Error).message);
      callbacks.onDone(ctx.content || '（Agent Loop 异常终止）', ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined, makeStats(ctx));
    }
    transition(ctx, S.TERMINATED);
  } finally {
    clearPlanTracker();
    endSessionMetrics();
  }
}
