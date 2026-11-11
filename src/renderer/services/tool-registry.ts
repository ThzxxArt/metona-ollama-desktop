/**
 * Tool Registry - 工具注册与调度中心
 * 管理所有可用工具的定义，负责执行调度
 */

import type { ToolDefinition, ToolResult, ToolCall } from '../types.js';
import type { SubAgentPermission } from './sub-agent.js';
import { state, KEYS } from '../state/state.js';
import { logToolStart, logToolResult, logError, logInfo, logWarn } from './log-service.js';
import { getMCPToolDefinitions } from './mcp-client.js';
import { recordToolAnalytics } from './tools/analytics.js';
import { TOOL_DEFINITIONS, MODE_TOOLS, type ToolMode } from './tools/catalog.js';
import { truncateToolResult, formatToolResult, getToolIcon, formatToolName } from './tools/format.js';
import {
  validateToolSecurity,
  validateToolArgs,
  coerceToolArgs,
  suggestToolFix,
} from './tools/validate.js';

export { TOOL_DEFINITIONS, MODE_TOOLS } from './tools/catalog.js';
export type { ToolMode } from './tools/catalog.js';
export { validateToolSecurity, validateToolArgs, coerceToolArgs, suggestToolFix } from './tools/validate.js';
export { truncateToolResult, formatToolResult, getToolIcon, formatToolName } from './tools/format.js';

/**
 * 子代理工具确认回调（由 agent-engine 在主循环生命周期内设置）。
 * 子代理与主 Agent 共用同一确认管线：全局模式为 confirm 时，
 * 子代理的写类工具同样需要用户确认，防止借道子代理绕过确认机制。
 */
let _subAgentConfirmHandler: ((call: ToolCall) => Promise<boolean>) | null = null;

export function setSubAgentConfirmHandler(handler: ((call: ToolCall) => Promise<boolean>) | null): void {
  _subAgentConfirmHandler = handler;
}

// 工具模式缓存：key=工具名, value=模式
const _toolModes = new Map<string, ToolMode>();

export function needsConfirmation(toolName: string): boolean {
  if (!MODE_TOOLS.includes(toolName)) return false;
  return getToolMode(toolName) === 'confirm';
}

/** 获取工具模式，默认 confirm */
export function getToolMode(toolName: string): ToolMode {
  return _toolModes.get(toolName) ?? 'confirm';
}

/** 设置工具执行模式 */
export function setToolMode(toolName: string, mode: ToolMode): void {
  _toolModes.set(toolName, mode);
  if (mode === 'disabled') {
    setToolEnabled(toolName, false);
  } else {
    setToolEnabled(toolName, true);
  }
}

/** 兼容旧接口：设置 run_command 执行模式 */
export function setRunCommandMode(mode: ToolMode): void {
  setToolMode('run_command', mode);
}

/** 初始化全局工具模式（从数据库加载） */
export function initGlobalToolMode(mode: ToolMode): void {
  for (const toolName of MODE_TOOLS) {
    setToolMode(toolName, mode);
  }
}

let enabledTools: Set<string> = new Set(TOOL_DEFINITIONS.map(def => def.function.name));

export function setToolEnabled(toolName: string, enabled: boolean): void {
  if (enabled) enabledTools.add(toolName);
  else enabledTools.delete(toolName);
}


export function getEnabledToolDefinitions(): ToolDefinition[] {
  const builtIn = TOOL_DEFINITIONS.filter(def => enabledTools.has(def.function.name));
  return [...builtIn, ..._mcpToolCache];
}

// R55: 语义工具检索 — 根据用户查询过滤相关工具，减少上下文占用

/** 核心工具集 — 始终包含的关键工具 */
const CORE_TOOLS = new Set([
  'read_file', 'write_file', 'list_directory', 'search_files', 'edit_file',
  'run_command', 'web_search', 'web_fetch', 'memory', 'git',
]);

/** 工具关键词映射 — 用于语义匹配 */
const TOOL_KEYWORDS: Record<string, string[]> = {
  read_file: ['read', 'file', '读取', '文件', '看', '查看', '内容', '打开文件', 'cat', 'less', 'head', 'tail', '批量读取', '多个文件'],
  write_file: ['write', 'file', '写入', '保存', '创建文件', '输出', '写入文件', '写入内容', 'echo', 'mkdir', '创建目录', '新建文件夹'],
  list_directory: ['list', 'directory', '目录', '文件夹', '列', 'ls', '列出', '查看目录', 'tree', '树', '目录结构', '层级'],
  search_files: ['search', 'find', '搜索', '查找', 'grep', '正则', '通配符', 'rg', 'ag'],
  delete_file: ['delete', 'remove', '删除', 'rm', '移除', '清空'],
  run_command: ['run', 'command', 'shell', '执行', '命令', '终端', 'cmd', 'powershell', 'bash', '脚本'],
  file_transfer: ['move', 'rename', 'copy', '移动', '重命名', 'mv', '复制', 'cp', '拷贝'],
  web_fetch: ['fetch', 'url', '网页', '抓取', '获取', '爬虫', '网页内容', '页面', '网址', '链接', '请求'],
  web_search: ['search', 'web', '搜索', '联网', '查', 'google', 'bing', '百度', '搜狗', '360', '查询', '在线搜索'],
  edit_file: ['edit', 'replace', '编辑', '替换', '修改', 'sed', '补丁', 'patch', '修改文件'],
  download_file: ['download', '下载', '保存到本地', '下载文件'],
  git: ['git', 'commit', 'push', 'pull', 'branch', '仓库', '版本控制', 'checkout', 'merge', 'diff', 'log', 'stash', 'tag'],
  compress: ['compress', 'zip', 'tar', '压缩', '解压', 'extract', '打包', '归档', '解压缩', 'gzip'],
  memory: ['memory', '记忆', 'remember', 'save', 'rule', '规则', '记住', '偏好', '事实', '遗忘', '回忆'],
  session: ['session', 'history', '会话', '历史', '历史记录', '会话列表', '读取会话'],
  spawn_task: ['sub', 'agent', 'delegate', '子代理', '委派', '并行', '子任务', '委派任务'],
  browser: ['browser', 'open', '浏览器', '打开网页', '访问', '浏览', '截图', '点击', '输入', '滚动', '等待', 'javascript'],
};

/** R55: 根据用户查询语义过滤工具定义，减少 token 占用 */
export function getRelevantToolDefinitions(userQuery: string): ToolDefinition[] {
  const allTools = getEnabledToolDefinitions();
  // 查询为空或很短时返回全部
  if (!userQuery || userQuery.length < 5) return allTools;

  const queryLower = userQuery.toLowerCase();
  const relevantTools = new Set<string>();

  // 核心工具始终包含
  for (const t of CORE_TOOLS) relevantTools.add(t);

  // 语义匹配
  for (const [toolName, keywords] of Object.entries(TOOL_KEYWORDS)) {
    if (relevantTools.has(toolName)) continue;
    for (const kw of keywords) {
      if (queryLower.includes(kw.toLowerCase())) {
        relevantTools.add(toolName);
        break;
      }
    }
  }

  // 如果匹配到的工具太少，返回全部（避免遗漏）
  if (relevantTools.size < 8) return allTools;

  const filtered = allTools.filter(t => relevantTools.has(t.function.name));
  // 确保不过度过滤 — 至少保留 60% 的工具
  if (filtered.length < allTools.length * 0.6) return allTools;

  return filtered;
}

/** MCP 工具缓存 */
let _mcpToolCache: ToolDefinition[] = [];

/** 刷新 MCP 工具缓存（在 MCP 服务器配置变更时调用） */
export async function refreshMCPTools(): Promise<void> {
  try {
    const rawTools = await getMCPToolDefinitions();
    // v5.1.2 Shadowing 防护：MCP 工具不能覆盖内置工具
    const builtInNames = new Set(TOOL_DEFINITIONS.map(d => d.function.name));
    const filtered = rawTools.filter(t => {
      if (builtInNames.has(t.function.name)) {
        logWarn(`MCP 工具 "${t.function.name}" 与内置工具重名，已跳过`);
        return false;
      }
      return true;
    });
    const skipped = rawTools.length - filtered.length;
    _mcpToolCache = filtered;
    if (filtered.length > 0) {
      logInfo(`MCP 工具已注册: ${filtered.length} 个${skipped > 0 ? `（${skipped} 个因重名被跳过）` : ''}`, filtered.map(t => t.function.name).join(', '));
    }
  } catch (err) {
    logError('MCP 工具刷新失败', (err as Error).message);
    _mcpToolCache = [];
  }
}

// ══════════════════════════════════════════════
// R21-R30: 工具系统增强
// ══════════════════════════════════════════════

export { getToolHeatmap, type ToolHeatmapData } from './tools/analytics.js';
export { getToolAnalytics, resetToolAnalytics, type ToolAnalytics } from './tools/analytics.js';

export async function executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  // MCP 工具路由
  if (toolName.startsWith('mcp_')) {
    const { executeMCPTool } = await import('./mcp-client.js');
    return executeMCPTool(toolName, args);
  }

  if (!enabledTools.has(toolName)) {
    logError(`工具未启用: ${toolName}`);
    return { success: false, error: `工具 ${toolName} 未启用` };
  }

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) {
    logError(`工具调用仅支持桌面版: ${toolName}`);
    return { success: false, error: '工具调用仅支持桌面版' };
  }

  // R23: 参数自动类型转换
  args = coerceToolArgs(toolName, args);

  // R21: 参数验证
  const validationErrors = validateToolArgs(toolName, args);
  if (validationErrors.length > 0) {
    logError(`工具参数验证失败: ${toolName}`, validationErrors.join('; '));
    return { success: false, error: `参数验证失败: ${validationErrors.join('; ')}` };
  }

  // R28: 安全验证 — 路径遍历、命令注入防护
  const securityWarning = validateToolSecurity(toolName, args);
  if (securityWarning) {
    logError(`R28: 工具安全拦截: ${toolName}`, securityWarning);
    return { success: false, error: securityWarning };
  }

  const startTime = Date.now();

  try {
    // 内存工具（不走 IPC，直接处理 MEMORY.md）
    if (toolName === 'memory') {
      const { search, addEntry, replaceEntry, removeEntry, removeEntries, loadAllEntries, DuplicateEntryError } = await import('./memory-service.js');
      const action = args.action as string;
      switch (action) {
        case 'search': {
          const query = args.query as string;
          // 未指定 limit 时默认 8（与工具 schema 描述一致）；
          // 旧实现 0=不限，模型省略参数会返回全部记忆撑爆上下文
          const rawLimit = args.limit as number | undefined;
          const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.floor(rawLimit)
            : 8;
if (!query) return { success: false, error: '缺少 query 参数' };
const results = await search(query, limit);
          logToolResult('memory', true, `${results.length} 条结果`);
          return { success: true, action, results, total: results.length };
        }
        case 'add': {
          const type = (args.type as 'fact' | 'preference' | 'rule') || 'fact';  // 兜底默认 fact
          const content = args.content as string;
          const rawImportance = Number(args.importance);
          const importance = Number.isFinite(rawImportance)
            ? Math.min(10, Math.max(1, Math.round(rawImportance)))
            : 5;
          const tags = (args.tags as string[]) || [];
          if (!content || content.length < 2) return { success: false, error: 'add 操作缺少 content 参数或内容太短。示例: {"action":"add","type":"fact","content":"具体的记忆内容"}' };
          try {
            const entry = await addEntry(type, content, importance, tags);
            logToolResult('memory', true, `${type}: ${content.slice(0, 50)}`);
            return { success: true, action, id: entry.id, type: entry.type, content: entry.content };
          } catch (err) {
            if (err instanceof DuplicateEntryError) {
              const dupErr = err as InstanceType<typeof DuplicateEntryError>;
              logToolResult('memory', true, `重复跳过: ${dupErr.existingPreview}`);
              return { success: true, action, duplicate: true, existing_id: dupErr.existingId, message: `已跳过: 相同内容的记忆已存在 (${dupErr.existingPreview})。不要再重复添加，任务已完成。` };
            }
            throw err;
          }
        }
        case 'replace': {
          const oldText = String(args.old_text || '');
          const newContent = String(args.new_content || '');
          const result = await replaceEntry(oldText, newContent);
          logToolResult('memory', result.success, result.message);
          return { success: result.success, action, ...(result.success ? {} : { error: result.message }), message: result.message };
        }
        case 'remove': {
          const oldText = String(args.old_text || '');
          const result = await removeEntry(oldText);
          logToolResult('memory', result.success, result.message);
          return { success: result.success, action, ...(result.success ? {} : { error: result.message }), message: result.message };
        }
        case 'remove_batch': {
          const oldTexts = Array.isArray(args.old_texts) ? args.old_texts.map(String) : [];
          if (oldTexts.length === 0) return { success: false, error: '缺少 old_texts 参数（字符串数组）' };
          const result = await removeEntries(oldTexts);
          logToolResult('memory', result.success, result.message);
          return { success: result.success, action, results: result.results, deleted: result.deleted, failed: result.failed, ...(result.success ? {} : { error: result.message }), message: result.message };
        }
        case 'read_all': {
          const entries = await loadAllEntries();
          logToolResult('memory', true, `${entries.length} 条记忆`);
          return { success: true, action, entries, total: entries.length };
        }
        default:
          return { success: false, error: `未知操作: ${action}。支持: search / add / replace / remove / remove_batch / read_all` };
      }
    }
    if (toolName === 'session') {
      const bridge = window.metonaDesktop;
      if (!bridge?.db) return { success: false, error: '桌面 API 不可用' };
      const action = args.action as string || 'list';
      if (action === 'list') {
        const rawLimit = args.limit as number | undefined;
        const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(100, Math.floor(rawLimit))
          : 20;
        const search = (args.search as string) || '';
        const summaries = await bridge.db.getSessionSummaries();
        let filtered = summaries.map((s: { id: string; title: string; model: string; message_count: number; created_at: number; updated_at: number }) => ({
          id: s.id,
          title: s.title,
          model: s.model,
          messageCount: s.message_count,
          createdAt: s.created_at,
          updatedAt: s.updated_at
        }));
        if (search) {
          filtered = filtered.filter(s => s.title.toLowerCase().includes(search.toLowerCase()));
        }
        filtered.sort((a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt);
        if (limit > 0) filtered = filtered.slice(0, limit);
        logToolResult('session', true, `${filtered.length} 个会话`);
        return { success: true, action: 'list', sessions: filtered, total: filtered.length };
      }
      if (action === 'read') {
        const sessionId = args.session_id as string;
        const rawMaxMessages = args.max_messages as number | undefined;
        const maxMessages = typeof rawMaxMessages === 'number' && Number.isFinite(rawMaxMessages) && rawMaxMessages > 0
          ? Math.min(500, Math.floor(rawMaxMessages))
          : 50;
        if (!sessionId) return { success: false, error: '缺少 session_id 参数' };
        const session = await bridge.db.getSession(sessionId);
        if (!session) return { success: false, error: `会话 ${sessionId} 不存在` };
        const messages = await bridge.db.getMessages(sessionId);
        const msgs = messages.slice(0, maxMessages).map((m: any) => ({
          role: m.role,
          content: m.content || '',
          timestamp: m.created_at
        }));
        logToolResult('session', true, `${msgs.length} 条消息`);
        return { success: true, action: 'read', session: { id: session.id, title: session.title, model: session.model }, messages: msgs, total: messages.length };
      }
      return { success: false, error: `未知 action: ${action}。支持: list / read` };
    }

    // v4.3 spawn_task 走子代理（模型只能从设置面板指定，不允许 AI 自选）
    if (toolName === 'spawn_task') {
      const { executeSubAgent } = await import('./sub-agent.js');
      const task = args.task as string;
      const context = args.context as string | undefined;
      // 只使用设置面板配置的子代理模型，忽略 AI 传入的 model 参数
      const configuredModel = state.get<string>('subAgentModel', '');
      let model: string | undefined;
      if (configuredModel) {
        // 设置面板存的模型名直接使用（面板加载时已验证过列表）
        model = configuredModel;
      }
      if (!task) return { success: false, error: '缺少 task 参数' };
      // 权限上限：AI 请求的权限只降不升，封顶于用户设置的 subAgentMaxPermission。
      // 防止提示注入让 AI 自授 full_write 绕过权限分级。
      const PERMISSION_RANK: Record<SubAgentPermission, number> = { readonly: 0, limited_write: 1, full_write: 2 };
      const requested = (args.permission as SubAgentPermission | undefined) ?? 'readonly';
      const maxAllowed = state.get<SubAgentPermission>('subAgentMaxPermission', 'readonly');
      const permission: SubAgentPermission = (PERMISSION_RANK[requested] ?? 0) <= (PERMISSION_RANK[maxAllowed] ?? 0)
        ? requested
        : maxAllowed;
      logInfo(`子代理委派: ${task.slice(0, 80)}${model ? ` (模型: ${model})` : ' (跟随当前模型)'} (权限: ${permission}, 上限: ${maxAllowed})`);
      const result = await executeSubAgent(task, context, {
        model,
        permission,
        confirmHandler: _subAgentConfirmHandler ?? undefined,
        tools: getEnabledToolDefinitions(),
        needsConfirmation,
        executeTool,
      });
      logToolResult('spawn_task', result.success, result.success ? `完成, ${(result as any).loops} 轮` : result.error);
      return result;
    }

    // run_command 走 workspace IPC
    if (toolName === 'run_command') {
      const command = args.command as string;
      const cwd = args.cwd as string | undefined;
      if (!command) {
        return { success: false, error: '缺少 command 参数' };
      }
      logInfo(`工作空间命令执行: ${command.slice(0, 100)}`);
      const result = await bridge.workspace.execTool(command, cwd);
      logToolResult('run_command', result.success, result.success ? undefined : result.stderr?.slice(0, 200));
      const normalized: ToolResult = {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: result.duration
      };
      // run_command 输出可能非常大，必须与其它工具一样走截断/格式化，
      // 否则一次性把几十 MB 日志塞进上下文。
      const truncatedResult = truncateToolResult(normalized, toolName);
      const formattedResult = formatToolResult(toolName, truncatedResult);
      recordToolAnalytics(toolName, formattedResult.success, Date.now() - startTime, formattedResult.error);
      return formattedResult;
    }

    // 其他工具：IPC 调用（无超时，由 renderer 内部处理）
    const result = await bridge.tool.execute(toolName, args);
    logToolResult(toolName, result.success, result.success ? undefined : result.error);

    // R22: 截断大输出结果
    const truncatedResult = truncateToolResult(result, toolName);
    // R26: 优化结果格式
    const formattedResult = formatToolResult(toolName, truncatedResult);

    // R25: 记录分析数据
    const duration = Date.now() - startTime;
    recordToolAnalytics(toolName, formattedResult.success, duration, formattedResult.error);

    return formattedResult;
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMsg = (err as Error).message;
    logError(`工具异常: ${toolName}`, errorMsg);

    // R24: 生成错误恢复建议
    const suggestion = suggestToolFix(toolName, args, errorMsg);
    // R25: 记录分析数据
    recordToolAnalytics(toolName, false, duration, errorMsg);

    return { success: false, error: suggestion ? `${errorMsg}\n\n💡 建议: ${suggestion}` : errorMsg };
  }
}

