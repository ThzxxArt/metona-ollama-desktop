/**
 * Agent Safety — Agent 安全防护与行为治理模块
 * 
 * 从 agent-engine.ts 提取的 R51-R56 功能：
 * - R51: 工具结果离线存储
 * - R52: 状态震荡检测
 * - R54: 增强死循环检测
 * - R56: 目标对齐验证
 * 
 * 设计原则：
 * - 纯函数/可测试，不依赖 OllamaAPI
 * - 模块级状态隔离，通过 reset* 函数清理
 */

import type { OllamaMessage } from '../types.js';
import { logInfo } from './log-service.js';
import { stableStringify } from '../utils/utils.js';

// ═══════════════════════════════════════════════════════════════
// R51: 工具结果离线存储
// ═══════════════════════════════════════════════════════════════

/** 会话级缓存，完整结果按 ID 存储，上下文仅保留精简引用 */
const _toolResultStore = new Map<string, { toolName: string; fullContent: string; timestamp: number }>();
const TOOL_STORE_MAX = 200;

/** 存储完整工具结果并返回引用 ID */
export function storeToolResult(toolName: string, fullContent: string): string {
  const refId = `toolref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _toolResultStore.set(refId, { toolName, fullContent, timestamp: Date.now() });
  // LRU 淘汰
  if (_toolResultStore.size > TOOL_STORE_MAX) {
    const oldestKey = _toolResultStore.keys().next().value;
    if (oldestKey) _toolResultStore.delete(oldestKey);
  }
  return refId;
}

/** 将旧工具结果消息精简为引用格式 */
export function compactOldToolResult(msg: OllamaMessage): OllamaMessage {
  if (msg.role !== 'tool' || !msg.content) return msg;
  if (msg.content.startsWith('[工具结果已归档]')) return msg;
  if (msg.content.length > 1500) {
    const refId = storeToolResult(msg.tool_name || 'unknown', msg.content);
    const summary = msg.content.slice(0, 500);
    const totalLen = msg.content.length;
    return {
      ...msg,
      content: `${summary}\n\n[工具结果已归档 ref=${refId} 完整内容 ${totalLen} 字符已离线存储，如需查看完整结果请重新调用工具]`,
    };
  }
  return msg;
}

// ═══════════════════════════════════════════════════════════════
// 状态震荡 / 死循环检测（历史功能，检测逻辑已被移除；保留调用历史
// 数组以维持快照/恢复 API 的兼容性）
// ═══════════════════════════════════════════════════════════════

const _toolCallHistory: string[] = [];

/** 记录工具调用到历史序列（供快照/恢复） */
export function recordToolCallHistory(toolName: string, args: Record<string, unknown>): void {
  const key = `${toolName}:${stableStringify(args).slice(0, 100)}`;
  _toolCallHistory.push(key);
  if (_toolCallHistory.length > 8) _toolCallHistory.shift();
}

// R56/R63 已删除：目标对齐验证 + 速率限制

// ═══════════════════════════════════════════════════════════════
// R66-R67: 错误分类系统 — 区分瞬态/永久错误，指导重试策略
// ═══════════════════════════════════════════════════════════════

export type ErrorClass = 'transient' | 'permanent' | 'security' | 'unknown';

export interface ClassifiedError {
  class: ErrorClass;
  shouldRetry: boolean;
  maxRetries: number;
  backoffMs: number;
  userMessage: string;
}

/** R66: 瞬态错误模式 — 可重试 */
const TRANSIENT_PATTERNS = [
  /timeout|timed?\s*out/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT/i,
  /socket\s*hang\s*up/i,
  /network|connection\s*(refused|reset|closed)/i,
  /503|502|500/i,
  /rate\s*limit|429/i,
  /EAGAIN|EBUSY/i,
  /temporarily\s*unavailable/i,
  /超时|连接.*失败|网络.*错误/,
];

/** R66: 永久错误模式 — 不可重试 */
const PERMANENT_PATTERNS = [
  /ENOENT|no\s*such\s*file/i,
  /EACCES|permission\s*denied/i,
  /ENOTDIR|EISDIR/i,
  /invalid\s*(path|argument|parameter)/i,
  /syntax\s*error/i,
  /JSON.*parse/i,
  /not\s*found/i,
  /文件不存在|路径.*错误|参数.*无效/,
];

/** R66: 安全错误模式 — 不可重试，需用户介入 */
const SECURITY_PATTERNS = [
  /安全警告|security/i,
  /injection|注入/i,
  /path\s*traversal|路径遍历/i,
  /file:\/\/|内网/i,
];

/** R66: 分类错误并给出重试建议 */
export function classifyError(error: string): ClassifiedError {
  const errLower = error.toLowerCase();
  
  // 安全错误
  for (const p of SECURITY_PATTERNS) {
    if (p.test(error)) {
      return {
        class: 'security',
        shouldRetry: false,
        maxRetries: 0,
        backoffMs: 0,
        userMessage: `安全拦截: ${error.slice(0, 100)}`,
      };
    }
  }
  
  // 永久错误
  for (const p of PERMANENT_PATTERNS) {
    if (p.test(error)) {
      return {
        class: 'permanent',
        shouldRetry: false,
        maxRetries: 0,
        backoffMs: 0,
        userMessage: `操作失败（不可重试）: ${error.slice(0, 100)}`,
      };
    }
  }
  
  // 瞬态错误
  for (const p of TRANSIENT_PATTERNS) {
    if (p.test(error)) {
      return {
        class: 'transient',
        shouldRetry: true,
        maxRetries: 2,
        backoffMs: 1000,
        userMessage: `临时错误（可重试）: ${error.slice(0, 100)}`,
      };
    }
  }
  
  // 未知错误 — 允许 1 次重试
  return {
    class: 'unknown',
    shouldRetry: true,
    maxRetries: 1,
    backoffMs: 500,
    userMessage: error.slice(0, 100),
  };
}

/** R67: 计算指数退避延迟 */
export function calculateBackoff(attempt: number, baseMs: number): number {
  return Math.min(baseMs * Math.pow(2, attempt), 10_000); // 上限 10 秒
}

// ═══════════════════════════════════════════════════════════════
// R76: 路径沙箱验证 — 确保文件操作不超出工作空间边界
// ═══════════════════════════════════════════════════════════════

/** R76: 验证路径是否在工作空间范围内 */
export function validatePathSandbox(
  path: string,
  workspaceDir: string,
): { valid: boolean; reason?: string; normalizedPath?: string } {
  if (!path) return { valid: false, reason: '路径为空' };
  if (!workspaceDir) return { valid: true, normalizedPath: path }; // 无工作空间时放行
  
  try {
    // 标准化路径（处理 .. 和 . ）
    const normalized = normalizePath(path);
    const normalizedWs = normalizePath(workspaceDir);
    
    // 绝对路径检查
    if (isAbsolute(normalized)) {
      if (!normalized.toLowerCase().startsWith(normalizedWs.toLowerCase())) {
        return {
          valid: false,
          reason: `路径 "${path}" 不在工作空间 "${workspaceDir}" 范围内`,
        };
      }
    }
    
    // 检查路径遍历攻击
    // P0 修复：用前缀锚定 replace，避免工作空间路径是另一路径子串时误判
    const wsLower = normalizedWs.toLowerCase();
    const normLower = normalized.toLowerCase();
    const relativePath = normLower.startsWith(wsLower)
      ? normLower.slice(wsLower.length).replace(/^[\\/]/, '')
      : normLower;
    if (relativePath.includes('..')) {
      // 允许在工作空间内部的相对路径引用
      const segments = relativePath.split(/[\\/]/);
      let depth = 0;
      for (const seg of segments) {
        if (seg === '..') depth--;
        else if (seg && seg !== '.') depth++;
        if (depth < 0) {
          return {
            valid: false,
            reason: `路径遍历检测: "${path}" 试图超出工作空间边界`,
          };
        }
      }
    }
    
    return { valid: true, normalizedPath: normalized };
  } catch {
    return { valid: false, reason: `路径解析失败: ${path}` };
  }
}

/** R76: 路径标准化辅助函数 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/** R76: 判断是否为绝对路径 */
function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');
}

// R87 已删除：工具熔断器

// ═══════════════════════════════════════════════════════════════
// R88: 工具结果元数据 — 为模型提供结果大小的上下文提示
// ═══════════════════════════════════════════════════════════════

/** R88: 估算字符串的 token 数（轻量级，用于工具结果元数据） */
export function estimateResultTokens(text: string): number {
  if (!text) return 0;
  let cn = 0, other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cn++;
    else other++;
  }
  return Math.ceil(cn / 1.5 + other / 4);
}

/** R88: 为工具结果添加元数据提示，帮助模型理解结果规模 */
export function addResultMetadata(formattedResult: string): string {
  const tokens = estimateResultTokens(formattedResult);
  if (tokens > 500) {
    return formattedResult + `\n[元数据: ~${tokens} tokens]`;
  }
  return formattedResult;
}

// ═══════════════════════════════════════════════════════════════
// R97: 错误模式学习 — 从重复错误中学习并生成改进建议
// ═══════════════════════════════════════════════════════════════

export interface ErrorPatternEntry {
  toolName: string;
  errorSignature: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  suggestedFix?: string;
}

const _errorPatterns = new Map<string, ErrorPatternEntry>();
const MAX_ERROR_PATTERNS = 50;

/** R97: 已知的错误→建议映射 */
const ERROR_FIX_MAP: Array<{ pattern: RegExp; fix: string }> = [
  { pattern: /ENOENT|no such file/i, fix: '检查文件路径是否正确，使用 list_directory 确认文件存在' },
  { pattern: /EACCES|permission denied/i, fix: '检查文件权限，或尝试使用不同路径' },
  { pattern: /timeout|timed out/i, fix: '尝试拆分任务为更小的步骤，或增加超时时间' },
  { pattern: /ECONNRESET|ECONNREFUSED/i, fix: '检查网络连接或目标服务是否可用' },
  { pattern: /rate limit|429/i, fix: '降低调用频率，添加延迟重试' },
  { pattern: /JSON.*parse|syntax error/i, fix: '验证输入数据的 JSON 格式是否正确' },
  { pattern: /tool.*not.*found|unknown tool/i, fix: '检查工具名拼写，使用正确的工具名' },
  { pattern: /invalid.*argument|参数.*无效/i, fix: '检查工具参数是否符合要求' },
];

/** R97: 记录错误模式并返回改进建议 */
export function recordErrorPattern(toolName: string, errorMsg: string): string | undefined {
  // 提取错误签名（移除具体路径/数值等细节）
  const signature = errorMsg
    .replace(/['"]/g, '')
    .replace(/\/[\w./\\-]+/g, '<path>')
    .replace(/\d+/g, 'N')
    .slice(0, 100);

  const key = `${toolName}::${signature}`;
  const now = Date.now();
  const existing = _errorPatterns.get(key);

  if (existing) {
    existing.count++;
    existing.lastSeen = now;
  } else {
    // LRU 淘汰
    if (_errorPatterns.size >= MAX_ERROR_PATTERNS) {
      const oldestKey = _errorPatterns.keys().next().value;
      if (oldestKey) _errorPatterns.delete(oldestKey);
    }
    // 查找建议
    let suggestedFix: string | undefined;
    for (const { pattern, fix } of ERROR_FIX_MAP) {
      if (pattern.test(errorMsg)) {
        suggestedFix = fix;
        break;
      }
    }
    _errorPatterns.set(key, {
      toolName, errorSignature: signature, count: 1,
      firstSeen: now, lastSeen: now, suggestedFix,
    });
  }

  // 如果同一错误出现 2+ 次，返回建议
  const entry = _errorPatterns.get(key);
  if (entry && entry.count >= 2 && entry.suggestedFix) {
    return `[错误模式提示] "${toolName}" 已 ${entry.count} 次出现类似错误。建议: ${entry.suggestedFix}`;
  }
  return undefined;
}

// R104 已删除：工具结果去重

// ═══════════════════════════════════════════════════════════════
// R109 已移除：工具参数消毒（sanitizeToolArgs）
// 该实现会污染 write_file 的 content 等数据型参数（把合法文本当作注入
// 模式替换掉），安全收益不抵数据破坏风险；注入防御由以下机制承担：
// - 主进程 checkPathAllowed / checkCommandAllowed / checkPublicHttpUrl
// - 系统提示词的数据边界标记（REFERENCE_DATA / TOOL_RESULT 信封）
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// R112: 诊断系统 — 收集 Agent 运行状态用于调试和优化
// ═══════════════════════════════════════════════════════════════

export interface AgentDiagnostics {
  timestamp: number;
  toolResultStoreSize: number;
  toolCallHistoryLength: number;
  errorPatternCount: number;
  topErrorPatterns: Array<{ tool: string; signature: string; count: number }>;
}

/** R112: 收集 Agent 诊断信息 */
export function collectDiagnostics(): AgentDiagnostics {
  const now = Date.now();

  const topErrorPatterns = Array.from(_errorPatterns.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(e => ({ tool: e.toolName, signature: e.errorSignature, count: e.count }));

  return {
    timestamp: now,
    toolResultStoreSize: _toolResultStore.size,
    toolCallHistoryLength: _toolCallHistory.length,
    errorPatternCount: _errorPatterns.size,
    topErrorPatterns,
  };
}

/** R112: 格式化诊断报告（用于日志输出） */
export function formatDiagnosticsReport(diag: AgentDiagnostics): string {
  const lines: string[] = [
    `Agent Diagnostics Report (${new Date(diag.timestamp).toLocaleTimeString()})`,
    `${'─'.repeat(50)}`,
    `Tool Result Store: ${diag.toolResultStoreSize} entries`,
    `Tool Call History: ${diag.toolCallHistoryLength} entries`,
    `Error Patterns: ${diag.errorPatternCount}`,
  ];
  for (const ep of diag.topErrorPatterns) {
    lines.push(`  ⚠️ ${ep.tool}: "${ep.signature}" (${ep.count}x)`);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// R113: 命令白名单增强 — 对 run_command 进行更精细的安全控制
// ═══════════════════════════════════════════════════════════════

/** R113: 高风险命令模式 — 需要用户确认 */
const HIGH_RISK_COMMAND_PATTERNS = [
  { pattern: /\brm\s+-rf?\b/i, risk: 'high', reason: '递归删除文件' },
  { pattern: /\bformat\b/i, risk: 'high', reason: '格式化磁盘' },
  { pattern: /\bmkfs\b/i, risk: 'high', reason: '创建文件系统' },
  { pattern: /\bdd\s+if=/i, risk: 'high', reason: '磁盘镜像写入' },
  { pattern: /\bchmod\s+777\b/i, risk: 'medium', reason: '设置全权限' },
  { pattern: /\bchown\b/i, risk: 'medium', reason: '修改文件所有者' },
  { pattern: /\bkill\s+-9\b/i, risk: 'medium', reason: '强制终止进程' },
  { pattern: /\biptables\b/i, risk: 'high', reason: '修改防火墙规则' },
  { pattern: /\breg(?:edit|svc)?\s+/i, risk: 'high', reason: '修改注册表' },
  { pattern: /\bnetsh\b/i, risk: 'medium', reason: '修改网络配置' },
  { pattern: /\bgit\s+push\s+--force\b/i, risk: 'medium', reason: '强制推送（覆盖远程）' },
  { pattern: /\bnpm\s+publish\b/i, risk: 'medium', reason: '发布 npm 包' },
];

/** R113: 禁止的命令模式 — 不可执行 */
const FORBIDDEN_COMMAND_PATTERNS = [
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/i, reason: 'fork 炸弹' },
  { pattern: /\brm\s+-rf\s+\/\s*$/i, reason: '删除根目录' },
  { pattern: /\bmkfs\.\w+\s+\/dev\//i, reason: '格式化系统设备' },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/i, reason: '系统关机/重启' },
  { pattern: /\b>\s*\/dev\/sda/i, reason: '直接写入磁盘设备' },
];

/** R113: 检查命令安全性，返回风险评估结果 */
export function checkCommandSafety(command: string): { safe: boolean; riskLevel: 'none' | 'medium' | 'high' | 'forbidden'; reason?: string } {
  // 检查禁止的命令
  for (const { pattern, reason } of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, riskLevel: 'forbidden', reason: `禁止执行: ${reason}` };
    }
  }

  // 检查高风险命令
  for (const { pattern, risk, reason } of HIGH_RISK_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return {
        safe: risk !== 'high', // high risk 需要 confirmation（但不是完全禁止）
        riskLevel: risk as 'medium' | 'high',
        reason: `${reason}（风险等级: ${risk}）`,
      };
    }
  }

  return { safe: true, riskLevel: 'none' };
}

// ═══════════════════════════════════════════════════════════════
// R95: 工具结果按类型智能截断 — 不同工具类型采用不同截断策略
// ═══════════════════════════════════════════════════════════════

/** R95: 工具类型 → 截断策略映射 */
const TOOL_TRUNCATE_STRATEGY: Record<string, {
  /** 优先保留的部分 */
  preserve: 'head' | 'tail' | 'both' | 'json_keys';
  /** 默认最大长度 */
  maxLen: number;
  /** JSON keys 保留策略（仅当 preserve=json_keys 时生效） */
  keepKeys?: string[];
}> = {
  // 命令输出：保留尾部（最终结果在尾部）
  run_command: { preserve: 'both', maxLen: 4000 },
  // 搜索结果：保留头部（最相关的结果在头部）
  search_files: { preserve: 'head', maxLen: 3000 },
  web_search: { preserve: 'head', maxLen: 3000 },
  // 文件读取：保留头部（文件开头通常更重要）
  read_file: { preserve: 'head', maxLen: 6000 },
  // 目录列表：保留头部
  list_directory: { preserve: 'head', maxLen: 2000 },
  tree: { preserve: 'head', maxLen: 3000 },
  // 网页抓取：保留头部（标题和摘要）
  web_fetch: { preserve: 'head', maxLen: 5000 },
  // Git 输出：保留尾部
  git: { preserve: 'tail', maxLen: 3000 },
  // 默认：两端保留
  _default: { preserve: 'both', maxLen: 4000 },
};

/**
 * R95: 按工具类型智能截断工具结果
 * 不同工具类型的输出有不同的结构特征，截断策略应适配
 */
export function smartTruncateByToolType(
  toolName: string,
  content: string,
  maxLen?: number,
): string {
  const strategy = TOOL_TRUNCATE_STRATEGY[toolName] || TOOL_TRUNCATE_STRATEGY._default;
  const limit = maxLen ?? strategy.maxLen;

  if (content.length <= limit) return content;

  const truncateMsg = (originalLen: number, truncatedLen: number) =>
    `\n... [R95截断: ${originalLen - truncatedLen} 字符已省略]`;

  switch (strategy.preserve) {
    case 'head':
      return content.slice(0, limit) + truncateMsg(content.length, limit);

    case 'tail':
      return truncateMsg(content.length, limit) + content.slice(-limit);

    case 'both': {
      // 保留前 60% + 后 40%
      const headLen = Math.floor(limit * 0.6);
      const tailLen = limit - headLen;
      return (
        content.slice(0, headLen) +
        truncateMsg(content.length, limit) +
        content.slice(-tailLen)
      );
    }

    case 'json_keys': {
      // 尝试解析 JSON 并保留指定 keys
      try {
        const parsed = JSON.parse(content);
        const kept: Record<string, unknown> = {};
        if (strategy.keepKeys) {
          for (const key of strategy.keepKeys) {
            if (key in parsed) kept[key] = parsed[key];
          }
        }
        let result = JSON.stringify(kept);
        if (result.length > limit) {
          // 如果保留 keys 后仍然过长，截断
          return result.slice(0, limit) + truncateMsg(result.length, limit);
        }
        return result;
      } catch {
        // JSON 解析失败，回退到 both 策略
        const headLen = Math.floor(limit * 0.6);
        const tailLen = limit - headLen;
        return (
          content.slice(0, headLen) +
          truncateMsg(content.length, limit) +
          content.slice(-tailLen)
        );
      }
    }

    default:
      return content.slice(0, limit) + truncateMsg(content.length, limit);
  }
}

// R99 已移除：工具结果引用解析（retrieveToolResult / checkArchivedReferences）
// 归档结果暂无工具可取回；如需查看完整结果，模型按归档提示重新调用原工具

// ═══════════════════════════════════════════════════════════════
// 统一重置（新会话开始时调用）
// ═══════════════════════════════════════════════════════════════

export function resetAllSafetyState(): void {
  _toolResultStore.clear();
  _toolCallHistory.length = 0;
  // R97: 清理错误模式
  _errorPatterns.clear();
  // R118: 清理性能分析数据
  _loopTimings.length = 0;
  logInfo('Agent Safety: 所有安全状态已重置');
}

// ═══════════════════════════════════════════════════════════════
// P1 #3: 安全状态快照/恢复 — 供 Sub-Agent 隔离使用
// ═══════════════════════════════════════════════════════════════

export interface SafetyStateSnapshot {
  toolResultStore: Map<string, { toolName: string; fullContent: string; timestamp: number }>;
  toolCallHistory: string[];
  errorPatterns: Map<string, ErrorPatternEntry>;
  loopTimings: LoopTiming[];
}

/** P1 #3: 快照当前安全状态（供 Sub-Agent 在隔离环境中使用） */
export function snapshotSafetyState(): SafetyStateSnapshot {
  return {
    toolResultStore: new Map(_toolResultStore),
    toolCallHistory: [..._toolCallHistory],
    errorPatterns: new Map(_errorPatterns),
    loopTimings: [..._loopTimings],
  };
}

/** P1 #3: 从快照恢复安全状态（Sub-Agent 执行完毕后恢复主 Agent 状态） */
export function restoreSafetyState(snapshot: SafetyStateSnapshot): void {
  _toolResultStore.clear();
  snapshot.toolResultStore.forEach((v, k) => _toolResultStore.set(k, v));
  _toolCallHistory.length = 0;
  _toolCallHistory.push(...snapshot.toolCallHistory);
  _errorPatterns.clear();
  snapshot.errorPatterns.forEach((v, k) => _errorPatterns.set(k, v));
  _loopTimings.length = 0;
  _loopTimings.push(...snapshot.loopTimings);
}

// ═══════════════════════════════════════════════════════════════
// R116: 错误恢复建议增强 — 提供上下文化的错误恢复建议
// ═══════════════════════════════════════════════════════════════

interface ErrorRecoverySuggestion {
  toolName: string;
  error: string;
  suggestions: string[];
  severity: 'low' | 'medium' | 'high';
}

const _errorRecoveryRules: Array<{
  pattern: RegExp;
  suggestions: string[];
  severity: ErrorRecoverySuggestion['severity'];
}> = [
  {
    pattern: /ENOENT|no such file|文件不存在|not found/i,
    suggestions: [
      '检查文件路径是否正确（注意大小写和路径分隔符）',
      '使用 list_dir 确认文件是否存在',
      '如果文件需要创建，先使用 write_file 创建',
    ],
    severity: 'low',
  },
  {
    pattern: /EACCES|permission denied|权限/i,
    suggestions: [
      '检查文件权限设置',
      '尝试使用不同的路径（工作空间目录内）',
      '联系管理员获取必要权限',
    ],
    severity: 'medium',
  },
  {
    pattern: /timeout|超时|timed?\s*out/i,
    suggestions: [
      '将任务拆分为更小的步骤',
      '检查网络连接是否正常',
      '增加超时时间或重试',
    ],
    severity: 'medium',
  },
  {
    pattern: /syntax error|语法错误|parse error/i,
    suggestions: [
      '检查代码语法是否正确',
      '使用 JSON 验证工具检查格式',
      '查看错误行号定位问题',
    ],
    severity: 'high',
  },
  {
    pattern: /connection refused|ECONNREFUSED|连接.*拒绝/i,
    suggestions: [
      '确认目标服务是否正在运行',
      '检查端口号和地址是否正确',
      '检查防火墙设置',
    ],
    severity: 'medium',
  },
  {
    pattern: /rate limit|429|频率/i,
    suggestions: [
      '降低请求频率，添加延迟',
      '等待一段时间后重试',
      '考虑使用缓存减少请求次数',
    ],
    severity: 'low',
  },
  {
    pattern: /out of memory|内存不足|OOM/i,
    suggestions: [
      '减少处理的数据量（分批处理）',
      '检查是否有内存泄漏',
      '增加系统可用内存',
    ],
    severity: 'high',
  },
];

/** R116: 获取上下文化的错误恢复建议 */
export function getErrorRecoverySuggestions(toolName: string, error: string): ErrorRecoverySuggestion {
  const suggestions: string[] = [];
  let severity: ErrorRecoverySuggestion['severity'] = 'low';
  
  for (const rule of _errorRecoveryRules) {
    if (rule.pattern.test(error)) {
      suggestions.push(...rule.suggestions);
      if (rule.severity === 'high') severity = 'high';
      else if (rule.severity === 'medium' && severity !== 'high') severity = 'medium';
    }
  }
  
  // 工具特定的建议
  if (toolName === 'run_command' && /command not found|命令未找到/i.test(error)) {
    suggestions.push('检查命令是否已安装（使用 which/where 确认）');
    suggestions.push('确认命令名称拼写正确');
  }
  if (toolName === 'write_file' && /disk full|磁盘已满/i.test(error)) {
    suggestions.push('清理磁盘空间后重试');
    suggestions.push('尝试写入到其他磁盘');
  }
  if (toolName === 'web_fetch' && /SSL|certificate/i.test(error)) {
    suggestions.push('检查 URL 是否使用 HTTPS');
    suggestions.push('确认 SSL 证书是否有效');
  }
  
  // 如果没有匹配到任何规则，提供通用建议
  if (suggestions.length === 0) {
    suggestions.push('检查参数是否正确');
    suggestions.push('尝试简化操作步骤');
    suggestions.push('查看完整错误信息以获取更多线索');
  }
  
  return { toolName, error, suggestions, severity };
}

/** R116: 格式化错误恢复建议为可读字符串 */
export function formatErrorRecovery(suggestion: ErrorRecoverySuggestion): string {
  const severityIcon = suggestion.severity === 'high' ? '🔴' : suggestion.severity === 'medium' ? '🟡' : '🟢';
  const lines = [
    `${severityIcon} 错误恢复建议 (${suggestion.toolName}):`,
    `错误: ${suggestion.error.slice(0, 200)}`,
    '建议:',
  ];
  for (let i = 0; i < suggestion.suggestions.length; i++) {
    lines.push(`  ${i + 1}. ${suggestion.suggestions[i]}`);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// R118: 循环计时数据（供安全状态快照/恢复使用；报告生成已移除）
// ═══════════════════════════════════════════════════════════════

export interface LoopTiming {
  loop: number;
  phase: string;
  durationMs: number;
  timestamp: number;
}

const _loopTimings: LoopTiming[] = [];

