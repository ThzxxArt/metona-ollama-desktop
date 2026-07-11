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
import { logInfo, logWarn } from './log-service.js';

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
// R52: 状态震荡检测
// ═══════════════════════════════════════════════════════════════

const _toolCallHistory: string[] = [];
const MAX_HISTORY_LEN = 8;

/** 检测工具调用序列是否存在震荡模式（A→B→A→B） */
export function detectOscillation(): boolean {
  if (_toolCallHistory.length < 4) return false;
  const len = _toolCallHistory.length;
  const a = _toolCallHistory[len - 4];
  const b = _toolCallHistory[len - 3];
  const c = _toolCallHistory[len - 2];
  const d = _toolCallHistory[len - 1];
  return a === c && b === d && a !== b;
}

/** 记录工具调用到历史序列 */
export function recordToolCallHistory(toolName: string, args: Record<string, unknown>): void {
  const key = `${toolName}:${JSON.stringify(args, Object.keys(args).sort()).slice(0, 100)}`;
  _toolCallHistory.push(key);
  if (_toolCallHistory.length > MAX_HISTORY_LEN) _toolCallHistory.shift();
}

/** 重置工具调用历史（新一轮对话开始时） */
export function resetToolCallHistory(): void {
  _toolCallHistory.length = 0;
}

// ═══════════════════════════════════════════════════════════════
// R54: 增强死循环检测
// ═══════════════════════════════════════════════════════════════

/** 检测连续 N 次完全相同的工具调用 */
export function detectConsecutiveIdentical(minCount: number): { detected: boolean; toolName: string; count: number } {
  if (_toolCallHistory.length < minCount) return { detected: false, toolName: '', count: 0 };
  const recent = _toolCallHistory.slice(-minCount);
  const allSame = recent.every(k => k === recent[0]);
  if (allSame) {
    return { detected: true, toolName: recent[0].split(':')[0], count: minCount };
  }
  return { detected: false, toolName: '', count: 0 };
}

// ═══════════════════════════════════════════════════════════════
// R56: 目标对齐验证
// ═══════════════════════════════════════════════════════════════

/** 用户原始目标（在 handleInit 时设置） */
let _userGoal: string = '';

/** 设置用户原始目标 */
export function setUserGoal(goal: string): void {
  _userGoal = goal.slice(0, 500); // 限制长度防止占用过多内存
}

/** 获取用户原始目标 */
export function getUserGoal(): string {
  return _userGoal;
}

/** 重置用户目标 */
export function resetUserGoal(): void {
  _userGoal = '';
}

/** 目标对齐检测结果 */
export interface GoalAlignmentResult {
  aligned: boolean;
  reason: string;
  suggestion?: string;
}

/**
 * R56: 检测 Agent 是否偏离用户原始目标
 * 
 * 检测策略：
 * 1. 提取用户目标中的关键动词和名词
 * 2. 检查最近 5 轮的工具调用是否与目标关键词相关
 * 3. 如果连续多轮工具调用都与目标无关，判定为偏离
 * 
 * @param recentToolNames 最近 N 轮的工具调用名称列表
 * @param recentContent 最近 N 轮的模型输出内容摘要
 * @param loopCount 当前循环计数
 */
export function checkGoalAlignment(
  recentToolNames: string[],
  recentContent: string,
  loopCount: number,
): GoalAlignmentResult {
  if (!_userGoal || _userGoal.length < 10) {
    return { aligned: true, reason: '目标太短，跳过对齐检测' };
  }

  // 仅在循环数 >= 6 时开始检测（前几轮可能是探索阶段）
  if (loopCount < 6) {
    return { aligned: true, reason: '前期探索阶段，跳过检测' };
  }

  const goalLower = _userGoal.toLowerCase();
  
  // 提取目标关键词
  const goalKeywords = extractGoalKeywords(_userGoal);
  
  // 检查最近内容是否包含目标关键词
  const contentLower = recentContent.toLowerCase();
  const contentMatches = goalKeywords.filter(kw => contentLower.includes(kw.toLowerCase()));
  
  // 检查最近的工具调用是否与目标相关
  // 每种工具与特定目标类型的关联度
  const toolGoalRelevance = assessToolGoalRelevance(recentToolNames, goalLower);
  
  // 如果最近内容中包含目标关键词，认为是对齐的
  if (contentMatches.length >= 1) {
    return { aligned: true, reason: `内容中包含目标关键词: ${contentMatches.join(', ')}` };
  }
  
  // 如果工具调用与目标高度相关，认为是对齐的
  if (toolGoalRelevance.relevant) {
    return { aligned: true, reason: toolGoalRelevance.reason };
  }
  
  // 偏离判定：内容无关键词 + 工具不相关 + 已过探索阶段
  return {
    aligned: false,
    reason: `最近 ${recentToolNames.length} 轮工具调用 (${recentToolNames.slice(-3).join(', ')}) 与用户目标"${_userGoal.slice(0, 60)}..."可能不相关`,
    suggestion: `请回顾用户原始任务: "${_userGoal.slice(0, 100)}"。如果当前操作是在为任务做准备，请继续；如果已经偏离，请调整方向。`,
  };
}

/** 从用户目标中提取关键词 */
function extractGoalKeywords(goal: string): string[] {
  const keywords: string[] = [];
  
  // 中文关键词
  const cnPatterns = [
    /搜索|查找|查一下|搜一下|检索|查询/g,
    /写入|创建|生成|保存|输出/g,
    /运行|执行|编译|构建/g,
    /读取|查看|打开/g,
    /修改|编辑|更新|替换/g,
    /删除|移除|清理/g,
    /下载|安装/g,
    /分析|研究|评估|对比/g,
    /测试|验证|检查/g,
    /部署|发布/g,
  ];
  
  // 英文关键词
  const enPatterns = [
    /\b(search|find|lookup)\b/gi,
    /\b(write|create|generate|save)\b/gi,
    /\b(run|execute|build|compile)\b/gi,
    /\b(read|view|open)\b/gi,
    /\b(edit|modify|update|replace)\b/gi,
    /\b(delete|remove|clean)\b/gi,
    /\b(download|install)\b/gi,
    /\b(analyze|research|evaluate|compare)\b/gi,
    /\b(test|verify|check)\b/gi,
    /\b(deploy|publish)\b/gi,
  ];
  
  for (const p of [...cnPatterns, ...enPatterns]) {
    const matches = goal.match(p);
    if (matches) keywords.push(...matches);
  }
  
  // 提取路径/文件名（如果目标中包含）
  const pathMatches = goal.match(/[\w-]+\.(ts|js|py|json|md|txt|html|css|go|rs|java|cpp|c)/gi);
  if (pathMatches) keywords.push(...pathMatches);
  
  // 提取引号中的内容
  const quotedMatches = goal.match(/[""']([^""']{3,30})[""']/g);
  if (quotedMatches) {
    for (const q of quotedMatches) {
      keywords.push(q.replace(/[""']/g, ''));
    }
  }
  
  return [...new Set(keywords)];
}

/** 评估工具调用与用户目标的相关性 */
function assessToolGoalRelevance(toolNames: string[], goalLower: string): { relevant: boolean; reason: string } {
  if (toolNames.length === 0) return { relevant: true, reason: '无工具调用，跳过' };
  
  // 文件操作类目标
  const isFileTask = /文件|目录|file|directory|path|路径/.test(goalLower);
  // 搜索类目标
  const isSearchTask = /搜索|查找|查|search|find|grep/.test(goalLower);
  // 命令执行类目标
  const isCommandTask = /运行|执行|命令|终端|run|execute|command|shell/.test(goalLower);
  // 网络类目标
  const isWebTask = /网页|网站|url|web|fetch|搜索|search/.test(goalLower);
  // Git 类目标
  const isGitTask = /git|提交|推送|分支|commit|push|pull/.test(goalLower);
  // 浏览器类目标
  const isBrowserTask = /浏览器|网页|截图|browser|screenshot/.test(goalLower);
  
  const recentTools = toolNames.slice(-5);
  
  if (isFileTask && recentTools.some(t => /read_file|write_file|edit_file|list_directory|search_files|tree/.test(t))) {
    return { relevant: true, reason: '文件操作与文件类目标相关' };
  }
  if (isSearchTask && recentTools.some(t => /search_files|web_search|grep/.test(t))) {
    return { relevant: true, reason: '搜索操作与搜索类目标相关' };
  }
  if (isCommandTask && recentTools.some(t => /run_command/.test(t))) {
    return { relevant: true, reason: '命令执行与命令类目标相关' };
  }
  if (isWebTask && recentTools.some(t => /web_search|web_fetch|browser_open/.test(t))) {
    return { relevant: true, reason: '网络操作与网络类目标相关' };
  }
  if (isGitTask && recentTools.some(t => /git/.test(t))) {
    return { relevant: true, reason: 'Git 操作与 Git 类目标相关' };
  }
  if (isBrowserTask && recentTools.some(t => /browser_/.test(t))) {
    return { relevant: true, reason: '浏览器操作与浏览器类目标相关' };
  }
  
  // memory 和 plan_track 始终认为相关
  if (recentTools.some(t => /memory|plan_track/.test(t))) {
    return { relevant: true, reason: '记忆/计划操作始终相关' };
  }
  
  return { relevant: false, reason: '最近工具调用与目标类型不匹配' };
}

// ═══════════════════════════════════════════════════════════════
// R63: 工具调用速率限制 — 防止快速连续调用同一工具浪费资源
// ═══════════════════════════════════════════════════════════════

const _toolCallTimestamps = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000; // 60 秒窗口
const RATE_LIMIT_DEFAULT = 20;    // 默认每分钟最多 20 次

/** R63: 工具特定的速率限制配置 */
const TOOL_RATE_LIMITS: Record<string, number> = {
  web_search: 10,      // 每分钟最多 10 次搜索
  web_fetch: 8,        // 每分钟最多 8 次抓取
  run_command: 15,     // 每分钟最多 15 次命令
  browser_open: 8,     // 每分钟最多 8 次浏览器打开
  download_file: 5,    // 每分钟最多 5 次下载
};

/** R63: 检查工具调用是否超过速率限制 */
export function checkRateLimit(toolName: string): { allowed: boolean; retryAfterMs: number } {
  const limit = TOOL_RATE_LIMITS[toolName] ?? RATE_LIMIT_DEFAULT;
  const now = Date.now();
  const timestamps = _toolCallTimestamps.get(toolName) || [];
  
  // 清理过期时间戳
  const valid = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
  
  if (valid.length >= limit) {
    // 计算最早过期时间
    const oldest = valid[0];
    const retryAfterMs = RATE_LIMIT_WINDOW - (now - oldest);
    return { allowed: false, retryAfterMs: Math.max(1000, retryAfterMs) };
  }
  
  valid.push(now);
  _toolCallTimestamps.set(toolName, valid);
  return { allowed: true, retryAfterMs: 0 };
}

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
    const relativePath = normalized.toLowerCase().replace(normalizedWs.toLowerCase(), '').replace(/^[\\/]/, '');
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

// ═══════════════════════════════════════════════════════════════
// R87: 工具熔断器 — 连续失败后自动禁用工具，防止雪崩
// ═══════════════════════════════════════════════════════════════

/** 工具失败计数器 */
const _toolFailureCount = new Map<string, number>();
const CIRCUIT_BREAKER_THRESHOLD = 5;  // 连续失败 5 次后熔断
const CIRCUIT_BREAKER_COOLDOWN = 60_000; // 熔断冷却 60 秒
const _circuitBreakerTripped = new Map<string, number>(); // toolName → trip timestamp

/** R87: 记录工具失败 */
export function recordToolFailure(toolName: string): void {
  const count = (_toolFailureCount.get(toolName) || 0) + 1;
  _toolFailureCount.set(toolName, count);
  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    _circuitBreakerTripped.set(toolName, Date.now());
    logWarn(`R87: 熔断器触发 — ${toolName} 连续失败 ${count} 次，禁用 60 秒`);
  }
}

/** R87: 记录工具成功（重置失败计数） */
export function recordToolSuccess(toolName: string): void {
  _toolFailureCount.delete(toolName);
  _circuitBreakerTripped.delete(toolName);
}

/** R87: 检查工具是否被熔断 */
export function isToolCircuitBroken(toolName: string): { broken: boolean; remainingMs: number } {
  const tripTime = _circuitBreakerTripped.get(toolName);
  if (!tripTime) return { broken: false, remainingMs: 0 };
  const elapsed = Date.now() - tripTime;
  if (elapsed >= CIRCUIT_BREAKER_COOLDOWN) {
    // 冷却期过了，半开状态：允许调用但保持失败计数
    _circuitBreakerTripped.delete(toolName);
    _toolFailureCount.set(toolName, CIRCUIT_BREAKER_THRESHOLD - 1); // 只给一次机会
    return { broken: false, remainingMs: 0 };
  }
  return { broken: true, remainingMs: CIRCUIT_BREAKER_COOLDOWN - elapsed };
}

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

interface ErrorPatternEntry {
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

// ═══════════════════════════════════════════════════════════════
// R104: 工具结果去重 — 相似结果检测，减少上下文中的冗余
// ═══════════════════════════════════════════════════════════════

interface ToolResultFingerprint {
  toolName: string;
  contentHash: string;
  timestamp: number;
  resultLength: number;
}

const _resultFingerprints: ToolResultFingerprint[] = [];
const MAX_FINGERPRINTS = 50;

/** R104: 计算内容的简化指纹（用于相似度检测） */
function computeResultFingerprint(content: string): string {
  // 取内容的前200字符 + 后100字符作为指纹
  const head = content.slice(0, 200);
  const tail = content.slice(-100);
  let hash = 5381;
  const combined = head + tail;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) + hash + combined.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

/** R104: 检查工具结果是否与最近的结果高度相似 */
export function isDuplicateToolResult(toolName: string, resultContent: string): { duplicate: boolean; similarTo?: string } {
  const hash = computeResultFingerprint(resultContent);
  const now = Date.now();
  const DEDUP_WINDOW = 60_000; // 60 秒内的结果视为候选

  // 查找相同工具+相同指纹的结果
  for (const fp of _resultFingerprints) {
    if (fp.toolName === toolName && fp.contentHash === hash && (now - fp.timestamp) < DEDUP_WINDOW) {
      return { duplicate: true, similarTo: `${fp.timestamp}` };
    }
  }

  // 记录当前结果
  _resultFingerprints.push({
    toolName, contentHash: hash, timestamp: now, resultLength: resultContent.length,
  });
  if (_resultFingerprints.length > MAX_FINGERPRINTS) {
    _resultFingerprints.shift();
  }

  return { duplicate: false };
}

// ═══════════════════════════════════════════════════════════════
// R105: 上下文年龄追踪 — 跟踪消息年龄以优化压缩决策
// ═══════════════════════════════════════════════════════════════

const _messageTimestamps = new Map<number, number>(); // message index → creation timestamp

/** R105: 记录消息创建时间 */
export function recordMessageAge(msgIndex: number): void {
  _messageTimestamps.set(msgIndex, Date.now());
}

/** R105: 获取消息年龄（毫秒），-1 表示未记录 */
export function getMessageAge(msgIndex: number): number {
  const ts = _messageTimestamps.get(msgIndex);
  if (!ts) return -1;
  return Date.now() - ts;
}

/** R105: 获取年龄超过阈值的消息索引列表 */
export function getAgedMessageIndices(thresholdMs: number): number[] {
  const now = Date.now();
  const result: number[] = [];
  for (const [idx, ts] of _messageTimestamps) {
    if (now - ts > thresholdMs) result.push(idx);
  }
  return result.sort((a, b) => a - b);
}

/** R105: 清理已删除消息的时间戳记录 */
export function cleanupMessageTimestamps(validIndices: Set<number>): void {
  for (const key of _messageTimestamps.keys()) {
    if (!validIndices.has(key)) {
      _messageTimestamps.delete(key);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// R109: 工具参数消毒 — 防止通过工具参数注入恶意内容
// ═══════════════════════════════════════════════════════════════

/** R109: 消毒工具参数中的潜在注入内容 */
export function sanitizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...args };

  // 对字符串参数进行消毒
  const stringKeys = ['content', 'command', 'query', 'text', 'old_text', 'new_text', 'message'];
  for (const key of stringKeys) {
    if (typeof sanitized[key] === 'string') {
      sanitized[key] = sanitizeInjectionPatterns(sanitized[key] as string);
    }
  }

  // R109: run_command 特殊处理 — 移除命令链中的注入尝试
  if (toolName === 'run_command' && typeof sanitized.command === 'string') {
    // 移除命令中的 prompt injection 尝试（如 `# 删除所有文件` 伪装为注释）
    sanitized.command = (sanitized.command as string)
      .replace(/#\s*(?:ignore|forget|override|disregard|忽略|忘记|覆盖)\s.*$/gim, '')
      .replace(/\|\s*(?:sh|bash|zsh|powershell|cmd)\b/gi, '')
      .trim();
  }

  return sanitized;
}

/** R109: 清理潜在的 prompt injection 模式 */
function sanitizeInjectionPatterns(text: string): string {
  if (!text || text.length < 20) return text;
  // 仅清理明显的注入模式，保留正常文本
  return text
    .replace(/ignore\s+(all\s+)?previous\s+(instructions?|prompts?)/gi, '[已过滤]')
    .replace(/forget\s+(all\s+)?(instructions?|prompts?|rules?)/gi, '[已过滤]')
    .replace(/disregard\s+(all|any|previous)\s+(instructions?|rules?)/gi, '[已过滤]')
    .replace(/忽略.{0,4}(之前|前面|以上|所有).{0,4}(指令|提示|规则|系统)/g, '[已过滤]');
}

// ═══════════════════════════════════════════════════════════════
// R112: 诊断系统 — 收集 Agent 运行状态用于调试和优化
// ═══════════════════════════════════════════════════════════════

export interface AgentDiagnostics {
  timestamp: number;
  toolResultStoreSize: number;
  toolCallHistoryLength: number;
  rateLimitActiveTools: string[];
  circuitBreakerStatus: Array<{ tool: string; broken: boolean; failures: number }>;
  errorPatternCount: number;
  topErrorPatterns: Array<{ tool: string; signature: string; count: number }>;
  resultFingerprintCount: number;
  duplicateResultCount: number;
  userGoal: string;
}

/** R112: 收集 Agent 诊断信息 */
export function collectDiagnostics(): AgentDiagnostics {
  const rateLimitActive: string[] = [];
  const now = Date.now();
  for (const [tool, timestamps] of _toolCallTimestamps) {
    const valid = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (valid.length > 0) {
      rateLimitActive.push(`${tool}(${valid.length}/${TOOL_RATE_LIMITS[tool] ?? RATE_LIMIT_DEFAULT})`);
    }
  }

  const circuitBreakerStatus = Array.from(_toolFailureCount.entries()).map(([tool, count]) => ({
    tool,
    broken: _circuitBreakerTripped.has(tool),
    failures: count,
  }));

  const topErrorPatterns = Array.from(_errorPatterns.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(e => ({ tool: e.toolName, signature: e.errorSignature, count: e.count }));

  const duplicateCount = _resultFingerprints.filter(fp => {
    // 同一工具同一指纹出现多次
    return _resultFingerprints.some(other =>
      other !== fp && other.toolName === fp.toolName && other.contentHash === fp.contentHash
    );
  }).length;

  return {
    timestamp: now,
    toolResultStoreSize: _toolResultStore.size,
    toolCallHistoryLength: _toolCallHistory.length,
    rateLimitActiveTools: rateLimitActive,
    circuitBreakerStatus,
    errorPatternCount: _errorPatterns.size,
    topErrorPatterns,
    resultFingerprintCount: _resultFingerprints.length,
    duplicateResultCount: duplicateCount,
    userGoal: _userGoal.slice(0, 80),
  };
}

/** R112: 格式化诊断报告（用于日志输出） */
export function formatDiagnosticsReport(diag: AgentDiagnostics): string {
  const lines: string[] = [
    `Agent Diagnostics Report (${new Date(diag.timestamp).toLocaleTimeString()})`,
    `${'─'.repeat(50)}`,
    `Tool Result Store: ${diag.toolResultStoreSize} entries`,
    `Tool Call History: ${diag.toolCallHistoryLength} entries`,
    `Rate Limit Active: ${diag.rateLimitActiveTools.length > 0 ? diag.rateLimitActiveTools.join(', ') : 'none'}`,
    `Circuit Breakers:`,
  ];
  for (const cb of diag.circuitBreakerStatus) {
    lines.push(`  ${cb.broken ? '🔴' : '🟢'} ${cb.tool}: ${cb.failures} failures${cb.broken ? ' (BROKEN)' : ''}`);
  }
  lines.push(`Error Patterns: ${diag.errorPatternCount}`);
  for (const ep of diag.topErrorPatterns) {
    lines.push(`  ⚠️ ${ep.tool}: "${ep.signature}" (${ep.count}x)`);
  }
  lines.push(`Result Fingerprints: ${diag.resultFingerprintCount} (duplicates: ${diag.duplicateResultCount})`);
  lines.push(`User Goal: "${diag.userGoal}"`);
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

// ═══════════════════════════════════════════════════════════════
// R99: 工具结果引用解析 — 从归档存储检索完整工具结果
// ═══════════════════════════════════════════════════════════════

/**
 * R99: 根据 refId 检索归档的完整工具结果
 * 当模型在上下文中看到 [工具结果已归档 ref=xxx] 标记时，
 * 可以通过此函数获取完整内容
 */
export function retrieveToolResult(refId: string): { toolName: string; fullContent: string; timestamp: number } | null {
  const entry = _toolResultStore.get(refId);
  if (!entry) return null;
  return { ...entry };
}

/**
 * R99: 从文本中提取工具结果引用 ID
 * 匹配格式: [工具结果已归档 ref=toolref_xxx_yyy]
 */
export function extractToolResultRefs(text: string): string[] {
  const matches = text.match(/\[工具结果已归档\s+ref=(toolref_[\w_]+)\]/g);
  if (!matches) return [];
  return matches.map(m => {
    const idMatch = m.match(/ref=(toolref_[\w_]+)/);
    return idMatch ? idMatch[1] : '';
  }).filter(Boolean);
}

/**
 * R99: 检查消息中是否引用了归档的工具结果，
 * 如果有则返回需要检索的引用信息
 */
export function checkArchivedReferences(messages: Array<{ content?: string }>): Array<{ refId: string; toolName: string; fullContent: string }> {
  const results: Array<{ refId: string; toolName: string; fullContent: string }> = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    const content = msg.content || '';
    if (!content.includes('[工具结果已归档')) continue;
    const refIds = extractToolResultRefs(content);
    for (const refId of refIds) {
      if (seen.has(refId)) continue;
      seen.add(refId);
      const retrieved = retrieveToolResult(refId);
      if (retrieved) {
        results.push({
          refId,
          toolName: retrieved.toolName,
          fullContent: retrieved.fullContent,
        });
      }
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// 统一重置（新会话开始时调用）
// ═══════════════════════════════════════════════════════════════

export function resetAllSafetyState(): void {
  _toolResultStore.clear();
  _toolCallHistory.length = 0;
  _userGoal = '';
  _toolCallTimestamps.clear();
  _toolFailureCount.clear();
  _circuitBreakerTripped.clear();
  // R97: 清理错误模式
  _errorPatterns.clear();
  // R104: 清理结果指纹
  _resultFingerprints.length = 0;
  // R105: 清理消息时间戳
  _messageTimestamps.clear();
  // R118: 清理性能分析数据
  _loopTimings.length = 0;
  logInfo('Agent Safety: 所有安全状态已重置');
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
// R118: Agent 循环性能分析 — 识别 Agent Loop 瓶颈
// ═══════════════════════════════════════════════════════════════

interface LoopTiming {
  loop: number;
  phase: string;
  durationMs: number;
  timestamp: number;
}

const _loopTimings: LoopTiming[] = [];
const MAX_TIMING_ENTRIES = 200;

/** R118: 记录阶段执行时间 */
export function recordLoopTiming(loop: number, phase: string, durationMs: number): void {
  _loopTimings.push({ loop, phase, durationMs, timestamp: Date.now() });
  if (_loopTimings.length > MAX_TIMING_ENTRIES) {
    _loopTimings.shift();
  }
}

/** R118: 生成性能分析报告 */
export function generatePerformanceReport(): {
  totalLoops: number;
  avgLoopTime: number;
  slowestPhase: string;
  phaseTimings: Record<string, { avg: number; max: number; count: number }>;
  bottlenecks: string[];
} {
  if (_loopTimings.length === 0) {
    return {
      totalLoops: 0,
      avgLoopTime: 0,
      slowestPhase: '',
      phaseTimings: {},
      bottlenecks: ['无性能数据'],
    };
  }
  
  // 按阶段汇总
  const phaseMap: Record<string, { total: number; max: number; count: number }> = {};
  const loopTotals: Record<number, number> = {};
  
  for (const t of _loopTimings) {
    if (!phaseMap[t.phase]) {
      phaseMap[t.phase] = { total: 0, max: 0, count: 0 };
    }
    phaseMap[t.phase].total += t.durationMs;
    phaseMap[t.phase].max = Math.max(phaseMap[t.phase].max, t.durationMs);
    phaseMap[t.phase].count++;
    
    loopTotals[t.loop] = (loopTotals[t.loop] || 0) + t.durationMs;
  }
  
  // 计算平均值
  const phaseTimings: Record<string, { avg: number; max: number; count: number }> = {};
  for (const [phase, data] of Object.entries(phaseMap)) {
    phaseTimings[phase] = {
      avg: Math.round(data.total / data.count),
      max: data.max,
      count: data.count,
    };
  }
  
  // 找到最慢的阶段
  let slowestPhase = '';
  let slowestAvg = 0;
  for (const [phase, data] of Object.entries(phaseTimings)) {
    if (data.avg > slowestAvg) {
      slowestAvg = data.avg;
      slowestPhase = phase;
    }
  }
  
  // 计算平均每轮时间
  const loopTimes = Object.values(loopTotals);
  const avgLoopTime = loopTimes.length > 0
    ? Math.round(loopTimes.reduce((s, t) => s + t, 0) / loopTimes.length)
    : 0;
  
  // 识别瓶颈
  const bottlenecks: string[] = [];
  if (slowestAvg > 5000) {
    bottlenecks.push(`⚠️ ${slowestPhase} 阶段平均耗时 ${slowestAvg}ms，是主要瓶颈`);
  }
  if (avgLoopTime > 30000) {
    bottlenecks.push(`⚠️ 平均每轮 ${avgLoopTime}ms，整体速度较慢`);
  }
  // 检查是否有异常慢的单次执行
  for (const [phase, data] of Object.entries(phaseTimings)) {
    if (data.max > data.avg * 3) {
      bottlenecks.push(`⚠️ ${phase} 阶段最大耗时 ${data.max}ms 远超平均 ${data.avg}ms，可能存在异常`);
    }
  }
  if (bottlenecks.length === 0) {
    bottlenecks.push('✅ 未检测到明显性能瓶颈');
  }
  
  return {
    totalLoops: loopTimes.length,
    avgLoopTime,
    slowestPhase,
    phaseTimings,
    bottlenecks,
  };
}

/** R118: 格式化性能报告 */
export function formatPerformanceReport(): string {
  const report = generatePerformanceReport();
  const lines = [
    `Agent Loop 性能分析 (${report.totalLoops} 轮)`,
    `${'─'.repeat(40)}`,
    `平均每轮耗时: ${report.avgLoopTime}ms`,
    `最慢阶段: ${report.slowestPhase}`,
    '',
    '阶段明细:',
  ];
  for (const [phase, data] of Object.entries(report.phaseTimings)) {
    lines.push(`  ${phase}: avg=${data.avg}ms max=${data.max}ms (${data.count}次)`);
  }
  lines.push('');
  lines.push('瓶颈分析:');
  for (const b of report.bottlenecks) {
    lines.push(`  ${b}`);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// R114: 工具调用依赖图 — 分析工具间依赖关系优化并行执行
// ═══════════════════════════════════════════════════════════════

interface ToolDependency {
  tool: string;
  dependsOn: string[]; // 依赖的其他工具（必须先完成）
  produces: string[];  // 产出（文件路径等）
  consumes: string[];  // 消费（文件路径等）
}

/** R114: 从工具调用序列推断依赖关系 */
export function inferToolDependencies(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
): ToolDependency[] {
  const dependencies: ToolDependency[] = [];
  const fileProducers = new Map<string, string>(); // filePath → toolName
  
  for (const call of toolCalls) {
    const dep: ToolDependency = {
      tool: call.name,
      dependsOn: [],
      produces: [],
      consumes: [],
    };
    
    // write_file/create_directory 产生文件
    if (call.name === 'write_file' && call.arguments.path) {
      const path = String(call.arguments.path);
      dep.produces.push(path);
      fileProducers.set(path, call.name);
    }
    
    // read_file/edit_file/delete_file 消费文件
    if (['read_file', 'edit_file', 'delete_file'].includes(call.name) && call.arguments.path) {
      const path = String(call.arguments.path);
      dep.consumes.push(path);
      const producer = fileProducers.get(path);
      if (producer) {
        dep.dependsOn.push(producer);
      }
    }
    
    // run_command 可能消费前面产生的文件
    if (call.name === 'run_command' && call.arguments.command) {
      const cmd = String(call.arguments.command);
      for (const [filePath, producer] of fileProducers) {
        if (cmd.includes(filePath)) {
          dep.consumes.push(filePath);
          dep.dependsOn.push(producer);
        }
      }
    }
    
    dependencies.push(dep);
  }
  
  return dependencies;
}

/** R114: 基于依赖关系对工具调用分组（可并行执行的分为一组） */
export function groupToolsByDependency(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
): Array<Array<{ name: string; arguments: Record<string, unknown> }>> {
  const deps = inferToolDependencies(toolCalls);
  const groups: Array<Array<{ name: string; arguments: Record<string, unknown> }>> = [];
  const completed = new Set<string>();
  
  let remaining = [...toolCalls.map((tc, i) => ({ ...tc, index: i }))];
  
  while (remaining.length > 0) {
    const currentBatch: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const batchIndices = new Set<number>();
    
    for (const tc of remaining) {
      const dep = deps[tc.index];
      // 检查所有依赖是否已完成
      const canRun = dep.dependsOn.every(d => completed.has(d));
      if (canRun) {
        currentBatch.push({ name: tc.name, arguments: tc.arguments });
        batchIndices.add(tc.index);
      }
    }
    
    if (currentBatch.length === 0) {
      // 没有可执行的（可能有循环依赖），强制执行剩余的
      groups.push(remaining.map(tc => ({ name: tc.name, arguments: tc.arguments })));
      break;
    }
    
    groups.push(currentBatch);
    for (const idx of batchIndices) {
      completed.add(toolCalls[idx].name);
    }
    remaining = remaining.filter(tc => !batchIndices.has(tc.index));
  }
  
  return groups;
}

// ═══════════════════════════════════════════════════════════════
// R117: 记忆搜索相关性调优 — 微调记忆搜索评分权重
// ═══════════════════════════════════════════════════════════════

export interface MemorySearchConfig {
  idfWeight: number;       // IDF 权重
  fuzzyWeight: number;     // 模糊匹配权重
  phraseBonus: number;     // 多词短语奖励
  recencyBonus: number;    // 时近性奖励
  frequencyBonus: number;  // 访问频率奖励
}

const _memorySearchConfig: MemorySearchConfig = {
  idfWeight: 1.0,
  fuzzyWeight: 0.5,
  phraseBonus: 2.0,
  recencyBonus: 0.3,
  frequencyBonus: 0.2,
};

/** R117: 获取当前记忆搜索配置 */
export function getMemorySearchConfig(): MemorySearchConfig {
  return { ..._memorySearchConfig };
}

/** R117: 更新记忆搜索配置 */
export function updateMemorySearchConfig(updates: Partial<MemorySearchConfig>): void {
  Object.assign(_memorySearchConfig, updates);
  logInfo(`R117: 记忆搜索配置已更新`, JSON.stringify(_memorySearchConfig));
}

/** R117: 根据搜索效果自动调优 */
export function autoTuneMemorySearch(
  avgResultCount: number,
  avgRelevanceScore: number
): { tuned: boolean; changes: string[] } {
  const changes: string[] = [];
  
  // 如果结果太多但相关性低，增加 IDF 权重
  if (avgResultCount > 10 && avgRelevanceScore < 0.3) {
    _memorySearchConfig.idfWeight += 0.2;
    changes.push(`IDF 权重增加到 ${_memorySearchConfig.idfWeight.toFixed(1)}（提高区分度）`);
  }
  
  // 如果结果太少，降低模糊匹配阈值
  if (avgResultCount < 2) {
    _memorySearchConfig.fuzzyWeight += 0.1;
    changes.push(`模糊匹配权重增加到 ${_memorySearchConfig.fuzzyWeight.toFixed(1)}（放宽匹配）`);
  }
  
  // 如果相关性分数高但结果少，增加频率奖励
  if (avgRelevanceScore > 0.7 && avgResultCount < 5) {
    _memorySearchConfig.frequencyBonus += 0.1;
    changes.push(`频率奖励增加到 ${_memorySearchConfig.frequencyBonus.toFixed(1)}（优先高频条目）`);
  }
  
  return { tuned: changes.length > 0, changes };
}

// ═══════════════════════════════════════════════════════════════
// R119: 工具执行队列优先级 — 按重要性排序工具执行
// ═══════════════════════════════════════════════════════════════

export type ToolPriority = 'critical' | 'high' | 'normal' | 'low';

const TOOL_PRIORITY_MAP: Record<string, ToolPriority> = {
  // 关键：用户直接请求的操作
  write_file: 'critical',
  edit_file: 'critical',
  delete_file: 'high',
  
  // 高：信息获取类
  read_file: 'high',
  list_directory: 'high',
  search_files: 'high',
  
  // 普通：辅助工具
  run_command: 'normal',
  web_search: 'normal',
  web_fetch: 'normal',
  git: 'normal',
  
  // 低：非关键
  memory: 'low',
  datetime: 'low',
  calculator: 'low',
  random: 'low',
  uuid: 'low',
};

/** R119: 获取工具优先级 */
export function getToolPriority(toolName: string): ToolPriority {
  return TOOL_PRIORITY_MAP[toolName] || 'normal';
}

/** R119: 按优先级排序工具调用 */
export function sortToolsByPriority<T extends { name: string }>(
  tools: T[]
): T[] {
  const priorityOrder: Record<ToolPriority, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  
  return [...tools].sort((a, b) => {
    const pa = priorityOrder[getToolPriority(a.name)];
    const pb = priorityOrder[getToolPriority(b.name)];
    return pa - pb;
  });
}

/** R119: 按优先级分批（同优先级可并行） */
export function batchToolsByPriority<T extends { name: string }>(
  tools: T[]
): T[][] {
  const batches: T[][] = [];
  const sorted = sortToolsByPriority(tools);
  
  let currentBatch: T[] = [];
  let currentPriority: ToolPriority | null = null;
  
  for (const tool of sorted) {
    const priority = getToolPriority(tool.name);
    if (currentPriority === null) {
      currentPriority = priority;
    }
    if (priority !== currentPriority) {
      if (currentBatch.length > 0) batches.push(currentBatch);
      currentBatch = [];
      currentPriority = priority;
    }
    currentBatch.push(tool);
  }
  
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

// ═══════════════════════════════════════════════════════════════
// R124: 压缩上下文中工具引用解析 — 恢复被压缩的工具结果引用
// ═══════════════════════════════════════════════════════════════

/** R124: 在压缩后的上下文中解析工具引用 */
export function resolveCompressedReferences(
  messages: Array<{ role: string; content: string }>
): { resolved: number; unresolved: string[] } {
  let resolved = 0;
  const unresolved: string[] = [];
  
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const content = msg.content || '';
    
    // 查找引用标记
    const refMatch = content.match(/\[工具结果已归档 ref=(\S+)/);
    if (refMatch) {
      const refId = refMatch[1];
      const stored = _toolResultStore.get(refId);
      if (stored) {
        resolved++;
      } else {
        unresolved.push(refId);
      }
    }
  }
  
  return { resolved, unresolved };
}

/** R124: 恢复压缩引用为完整内容（仅对指定引用） */
export function restoreCompressedReference(
  refId: string,
  maxLen?: number
): string | null {
  const stored = _toolResultStore.get(refId);
  if (!stored) return null;
  
  const content = stored.fullContent;
  if (maxLen && content.length > maxLen) {
    return content.slice(0, maxLen) + `\n...(已截断，完整内容 ${content.length} 字符)`;
  }
  return content;
}

