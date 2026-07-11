/**
 * Context Manager - 智能上下文管理 (v5.0)
 * 三层策略：滑动窗口 + LLM 摘要压缩 + 记忆注入
 * 支持自动压缩与手动 /compress 触发
 */

import type { OllamaMessage, OllamaStreamChunk } from '../types.js';
import { logInfo, logWarn, logSuccess, logError } from './log-service.js';

// ── R12: 压缩去重 — 内容指纹追踪 ──

/** DJB2 哈希函数，用于消息内容指纹 */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

/** 记录已压缩消息批次的内容指纹，避免重复压缩相同内容 */
const _compressedContentHashes = new Set<string>();
const MAX_COMPRESSED_HASHES = 100;

/** R12: 计算消息批次的内容指纹 */
function computeMessagesHash(messages: OllamaMessage[]): string {
  const content = messages.map(m => `${m.role}:${(m.content || '').slice(0, 200)}`).join('|');
  return djb2Hash(content);
}

/** R12: 检查消息批次是否已被压缩过 */
function isAlreadyCompressed(messages: OllamaMessage[]): boolean {
  if (messages.length === 0) return true;
  const hash = computeMessagesHash(messages);
  return _compressedContentHashes.has(hash);
}

/** R12: 记录已压缩的消息批次指纹 */
function markAsCompressed(messages: OllamaMessage[]): void {
  const hash = computeMessagesHash(messages);
  _compressedContentHashes.add(hash);
  // LRU 式淘汰：超过上限时移除最早的
  if (_compressedContentHashes.size > MAX_COMPRESSED_HASHES) {
    const firstKey = _compressedContentHashes.values().next().value;
    if (firstKey) _compressedContentHashes.delete(firstKey);
  }
}

// ── R18: 上下文使用率预测 ──

/** 上下文使用率趋势数据点 */
interface TokenUsagePoint {
  turn: number;
  tokens: number;
  numCtx: number;
  timestamp: number;
}

const _tokenUsageTrend: TokenUsagePoint[] = [];
const MAX_TREND_POINTS = 20;
let _currentTurn = 0;

/** R18: 上下文预警级别 */
export type ContextWarningLevel = 'safe' | 'notice' | 'warning' | 'critical';

/** R18: 上下文预测结果 */
export interface ContextPrediction {
  level: ContextWarningLevel;
  currentUsage: number;    // 0-1
  predictedUsage: number;  // 预测下一轮的使用率
  turnsToOverflow: number; // 预计多少轮后溢出（-1 表示不会溢出）
  message: string;
}

/** R18: 记录当前轮次的 token 使用量 */
export function recordTokenUsage(tokens: number, numCtx: number): void {
  _currentTurn++;
  _tokenUsageTrend.push({
    turn: _currentTurn,
    tokens,
    numCtx,
    timestamp: Date.now(),
  });
  if (_tokenUsageTrend.length > MAX_TREND_POINTS) {
    _tokenUsageTrend.shift();
  }
}

/** R18: 预测上下文溢出风险 */
export function predictContextOverflow(numCtx: number): ContextPrediction {
  const currentTokens = _tokenUsageTrend.length > 0
    ? _tokenUsageTrend[_tokenUsageTrend.length - 1].tokens
    : 0;
  const currentUsage = currentTokens / numCtx;

  // 至少需要 3 个数据点才能做线性回归预测
  if (_tokenUsageTrend.length < 3) {
    const level: ContextWarningLevel = currentUsage > 0.8 ? 'critical'
      : currentUsage > 0.6 ? 'warning'
      : currentUsage > 0.4 ? 'notice'
      : 'safe';
    return {
      level,
      currentUsage,
      predictedUsage: currentUsage,
      turnsToOverflow: -1,
      message: level === 'safe' ? '' : `当前上下文使用率 ${(currentUsage * 100).toFixed(0)}%`,
    };
  }

  // 线性回归：y = ax + b，预测未来 token 增长
  const n = _tokenUsageTrend.length;
  const xs = _tokenUsageTrend.map(p => p.turn);
  const ys = _tokenUsageTrend.map(p => p.tokens);
  const xMean = xs.reduce((s, x) => s + x, 0) / n;
  const yMean = ys.reduce((s, y) => s + y, 0) / n;
  let numerator = 0, denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }
  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;

  // 预测下一轮
  const nextTurn = _currentTurn + 1;
  const predictedTokens = Math.max(0, slope * nextTurn + intercept);
  const predictedUsage = predictedTokens / numCtx;

  // 计算预计多少轮后溢出
  let turnsToOverflow = -1;
  if (slope > 0) {
    turnsToOverflow = Math.ceil((numCtx - intercept) / slope - _currentTurn);
    if (turnsToOverflow < 0) turnsToOverflow = 0;
  }

  // 确定预警级别
  const maxUsage = Math.max(currentUsage, predictedUsage);
  let level: ContextWarningLevel;
  let message = '';

  if (maxUsage > 0.85 || turnsToOverflow === 0) {
    level = 'critical';
    message = `⚠️ 上下文即将溢出！当前 ${currentTokens}/${numCtx} tokens (${(currentUsage * 100).toFixed(0)}%)，预计 ${turnsToOverflow} 轮后溢出`;
  } else if (maxUsage > 0.7 || (turnsToOverflow >= 1 && turnsToOverflow <= 3)) {
    level = 'warning';
    message = `⚠️ 上下文使用率较高 (${(currentUsage * 100).toFixed(0)}%)，预计 ${turnsToOverflow} 轮后可能溢出，建议压缩`;
  } else if (maxUsage > 0.5) {
    level = 'notice';
    message = `上下文使用率 ${(currentUsage * 100).toFixed(0)}%，趋势正常`;
  } else {
    level = 'safe';
  }

  return { level, currentUsage, predictedUsage, turnsToOverflow, message };
}

/** R18: 获取 token 使用趋势数据（供调试用） */
export function getTokenUsageTrend(): TokenUsagePoint[] {
  return [..._tokenUsageTrend];
}

// ── Token 校准系统 ──

/** 校准比例：actualTokens / estimatedTokens，基于 Ollama 返回的实际计数动态修正 */
let _tokenCalibrationRatio = 1.0;
let _calibrationSamples = 0;
let _calibrationModel = '';  // C8: 记录校准时的模型名
const MIN_CALIBRATION_SAMPLES = 3;

/**
 * 记录 Ollama 返回的实际 token 计数，用于校准估算器。
 * 在 agent-engine.ts 每轮流式完成后调用。
 * C8: 模型切换时自动重置校准比例，避免不同 tokenizer 导致估算失真
 * @param actualInputTokens Ollama 返回的 prompt_eval_count
 * @param actualOutputTokens Ollama 返回的 eval_count
 * @param estimatedTokens 本轮消息调用 estimateTokens 的合计值
 * @param modelName 当前使用的模型名
 */
export function recordActualTokens(actualInputTokens: number, actualOutputTokens: number, estimatedCount: number, modelName?: string): void {
  // C8: 模型切换时重置校准
  if (modelName && modelName !== _calibrationModel) {
    _calibrationModel = modelName;
    _tokenCalibrationRatio = 1.0;
    _calibrationSamples = 0;
  }
  if (actualInputTokens <= 0 || estimatedCount <= 0) return;
  // 仅用 prompt_eval_count（实际输入 token）与估算值对比，
  // 因为 estimatedCount 只估算消息内容（不含输出 token），加入 eval_count 会导致比值虚高
  const sampleRatio = actualInputTokens / Math.max(1, estimatedCount);
  // 指数移动平均，平滑异常值
  const alpha = 0.3;
  _tokenCalibrationRatio = _tokenCalibrationRatio * (1 - alpha) + sampleRatio * alpha;
  _calibrationSamples++;
}

/** 估算 token 数（自动使用校准后的比例） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 中文按 1.5 字/token，英文按 4 字符/token
  let chineseChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) chineseChars++;
    else otherChars++;
  }
  const raw = Math.ceil(chineseChars / 1.5 + otherChars / 4);
  // 应用校准比例（仅在有足够样本后）
  if (_calibrationSamples >= MIN_CALIBRATION_SAMPLES) {
    return Math.ceil(raw * _tokenCalibrationRatio);
  }
  return raw;
}

/** 获取当前校准比例（供调试用） */
export function getTokenCalibration(): { ratio: number; samples: number } {
  return { ratio: _tokenCalibrationRatio, samples: _calibrationSamples };
}

/** 自动压缩阈值：当消息 token 占 context window 比例超过此值时触发自动压缩 */
export const AUTO_COMPRESS_THRESHOLD = 0.3;

/** R14: 自适应压缩阈值 — 根据模型上下文长度动态调整 */
export function getAdaptiveCompressThreshold(numCtx: number): number {
  // 小上下文模型（<8K）：更早触发压缩（40%），留更多余量
  // 中等上下文（8K-32K）：标准阈值（30%）
  // 大上下文（>32K）：稍晚触发（25%），避免过于频繁压缩
  if (numCtx < 8192) return 0.4;
  if (numCtx > 32768) return 0.25;
  return AUTO_COMPRESS_THRESHOLD;
}

/** R19: 压缩效果指标 */
export interface CompressionMetrics {
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  compressionRatio: number;
  timestamp: number;
}
const _compressionHistory: CompressionMetrics[] = [];
const MAX_COMPRESSION_HISTORY = 20;

/** R19: 获取压缩历史指标 */
export function getCompressionHistory(): CompressionMetrics[] {
  return [..._compressionHistory];
}

/** R19: 获取平均压缩率 */
export function getAverageCompressionRatio(): number {
  if (_compressionHistory.length === 0) return 1.0;
  const sum = _compressionHistory.reduce((s, m) => s + m.compressionRatio, 0);
  return sum / _compressionHistory.length;
}

/** 压缩后保留首尾消息数 */
const COMPRESS_KEEP_HEAD = 5;
const COMPRESS_KEEP_TAIL = 8;

// ── 消息重要性评分（纯规则，不调用 LLM）──

/** 重要性评分：0-10，越高越应该保留。SOUL.md 和规则记忆始终保留。 */
export function scoreMessageImportance(msg: OllamaMessage): number {
  let score = 5; // 默认中等

  // SOUL.md / 日期 / 环境 消息永远不可压缩
  if (msg.content?.includes('[SOUL.md]') || msg.content?.includes('<<<REFERENCE_DATA_START>>>')) return 10;
  if (msg.content?.startsWith('[日期]')) return 10;
  if (msg.content?.startsWith('[环境]')) return 10;
  // 安全规则提示也不可压缩
  if (msg.content?.includes('安全规则')) return 10;

  // 角色权重
  if (msg.role === 'user') score += 2;      // 用户消息最重要
  if (msg.role === 'system') score -= 2;    // 系统消息通常可压缩

  // ephemeral 临时消息 → 最低权重，优先丢弃
  if (msg.ephemeral) return 0;

  // 已压缩标记 → 中等权重（C6: 提高从 1 到 4，避免快速摘要被立即丢弃）
  if (msg.compressed) score = 4;

  const content = msg.content || '';

  // 关键词检测
  const highValuePatterns = [/路径|目录|path|file|config|配置|命令|command|exec/i,
    /错误|error|失败|fail|bug|fix|修复|解决/i,
    /版本|version|API|http|url|端口|port|localhost/i,
    /记住|保存|memory|偏好|偏好|规则|rule/i,
    /完成|done|✓|success|成功|结果|result/i,
    /项目|project|工作空间|workspace|git|repo|仓库/i,
  ];
  // R10: 修复低价值模式误报 — 移除单字“好”（匹配几乎所有中文文本）
  // 仅匹配明确的短语回复，且仅对短消息（<100字）生效
  const lowValuePatterns = [/^(好的|明白|ok|知道了|嗯|哦|好[的呀吧]|收到)$/i,
    /^(继续|请继续|帮帮我|可以吗|行吗|好的谢谢)$/i,
    /^(谢谢|感谢|不客气|多谢|thanks?)$/i,
  ];

  for (const p of highValuePatterns) {
    if (p.test(content)) { score += 1; break; }
  }
  for (const p of lowValuePatterns) {
    if (p.test(content) && content.length < 100) { score -= 2; break; }
  }

  // 工具调用 → 高价值
  if (msg.tool_calls?.length) score += 2;

  // R20: 工具结果类型感知 — 不同工具结果的价值不同
  if (msg.role === 'tool' && msg.tool_name) {
    // 写类工具结果：高价值（记录了操作结果）
    if (/write_file|edit_file|delete_file|create_directory|move_file|copy_file/.test(msg.tool_name)) {
      score += 2;
    }
    // 搜索类工具结果：中等价值
    if (/search_files|web_search/.test(msg.tool_name)) {
      score += 1;
    }
    // 读取类工具结果：中等价值
    if (/read_file|list_directory|tree/.test(msg.tool_name)) {
      score += 1;
    }
    // 时间/计算类工具结果：低价值（时效性强，很快过期）
    if (/datetime|random|uuid|hash/.test(msg.tool_name)) {
      score -= 2;
    }
  }

  // 长度加分：长消息通常包含更多信息
  if (content.length > 500) score += 1;
  if (content.length > 2000) score += 1;

  // 图像附件 → 中等价值（大但语义密度低）
  if (msg.images?.length) score -= 1;

  return Math.max(1, Math.min(10, score));
}

export interface ContextBuildOptions {
  /** 滑动窗口大小（最近 N 条消息完整保留） */
  windowSize?: number;
  /** 每 N 条更早的消息压缩为一段摘要 */
  summaryBatchSize?: number;
  /** 最大 token 数限制 */
  maxTokens?: number;
  /** 系统 prompt 注入的记忆上下文 */
  memoryContext?: string;
  /** 工作空间上下文 */
  workspaceContext?: string;
}

// ── R16: 增量摘要合并工具函数 ──

/** R16: 从已压缩消息中提取结构化摘要 */
function extractStructuredSummary(compressedMsgs: OllamaMessage[]): StructuredSummary {
  const summary: StructuredSummary = {
    topics: [], decisions: [], pendingTasks: [], constraints: [], knowledge: [], toolResults: [],
  };
  for (const msg of compressedMsgs) {
    const content = msg.content || '';
    // 解析结构化摘要中的各部分
    const topicMatch = content.match(/📌 主题:\s*(.+)/);
    if (topicMatch) summary.topics.push(...topicMatch[1].split('；').filter(Boolean));
    const decisionMatch = content.match(/✅ 决策:\s*(.+)/);
    if (decisionMatch) summary.decisions.push(...decisionMatch[1].split('；').filter(Boolean));
    const pendingMatch = content.match(/⏳ 待办:\s*(.+)/);
    if (pendingMatch) summary.pendingTasks.push(...pendingMatch[1].split('；').filter(Boolean));
    const constraintMatch = content.match(/📏 约束:\s*(.+)/);
    if (constraintMatch) summary.constraints.push(...constraintMatch[1].split('；').filter(Boolean));
    const knowledgeMatch = content.match(/🧠 知识点:\s*(.+)/);
    if (knowledgeMatch) summary.knowledge.push(...knowledgeMatch[1].split('；').filter(Boolean));
    const toolMatch = content.match(/🔧 工具结果:\s*(.+)/);
    if (toolMatch) summary.toolResults.push(...toolMatch[1].split('；').filter(Boolean));
  }
  return summary;
}

/** R16: 合并两个结构化摘要，去重并限制条目数 */
function mergeSummaries(old_: StructuredSummary, new_: StructuredSummary): StructuredSummary {
  const mergeArrays = (oldArr: string[], newArr: string[], max: number): string[] => {
    // 合并、去重、限制数量（新摘要优先）
    const combined = [...new Set([...newArr, ...oldArr])];
    return combined.slice(0, max);
  };
  return {
    topics: mergeArrays(old_.topics, new_.topics, 4),
    decisions: mergeArrays(old_.decisions, new_.decisions, 3),
    pendingTasks: mergeArrays(old_.pendingTasks, new_.pendingTasks, 3),
    constraints: mergeArrays(old_.constraints, new_.constraints, 3),
    knowledge: mergeArrays(old_.knowledge, new_.knowledge, 3),
    toolResults: mergeArrays(old_.toolResults, new_.toolResults, 3),
  };
}

// ── R17: System 消息分区优化 ──

/** R17: 判断 system 消息是否为稳定前缀（不会在会话中改变） */
function isStableSystemMessage(content: string): boolean {
  // SOUL.md、安全规则、日期、环境信息等 — 在整个会话中不会改变
  return content.includes('[SOUL.md]')
    || content.includes('<<<REFERENCE_DATA_START>>>')
    || content.startsWith('[日期]')
    || content.startsWith('[环境]')
    || content.includes('安全规则')
    || content.includes('系统提示')
    || content.includes('You are');  // 通用系统 prompt
}

/** R17: 对 system 消息排序，稳定部分在前，动态部分在后，支持 LLM Prefix Caching */
function reorderSystemMessagesForPrefixCaching(messages: OllamaMessage[]): void {
  // 找到所有 system 消息
  const systemIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') systemIndices.push(i);
  }
  if (systemIndices.length <= 1) return;

  // 提取并分类
  const stableContents: string[] = [];
  const dynamicContents: string[] = [];
  for (const idx of systemIndices) {
    const content = messages[idx].content || '';
    if (isStableSystemMessage(content)) {
      stableContents.push(content);
    } else {
      dynamicContents.push(content);
    }
  }

  if (stableContents.length === 0 || dynamicContents.length === 0) return;

  // 合并稳定部分和动态部分
  const stableContent = stableContents.join('\n\n');
  const dynamicContent = dynamicContents.join('\n\n');

  // 重写第一条 system 消息为稳定部分，其余 system 消息合并为动态部分
  const firstSysIdx = systemIndices[0];
  messages[firstSysIdx].content = stableContent;

  // 将其余 system 消息合并为一条动态 system 消息，放在最后一条 system 消息位置
  const lastSysIdx = systemIndices[systemIndices.length - 1];
  if (firstSysIdx !== lastSysIdx) {
    messages[lastSysIdx].content = dynamicContent;
    // 删除中间的 system 消息
    const middleSysIndices = systemIndices.slice(1, -1);
    for (let i = middleSysIndices.length - 1; i >= 0; i--) {
      messages.splice(middleSysIndices[i], 1);
    }
  } else {
    // 只有一条 system 消息时，追加动态内容
    messages[firstSysIdx].content = stableContent + '\n\n' + dynamicContent;
  }

  logInfo(`R17: System 消息分区完成 — 稳定前缀 ${estimateTokens(stableContent)} tokens, 动态部分 ${estimateTokens(dynamicContent)} tokens`);
}

const DEFAULT_OPTIONS: Required<ContextBuildOptions> = {
  windowSize: 40,
  summaryBatchSize: 30,
  maxTokens: 131072,
  memoryContext: '',
  workspaceContext: ''
};

/**
 * 构建发送给模型的 messages（同步，滑动窗口）
 * 三层策略：
 *   a. 滑动窗口：最近 N 条消息完整保留
 *   b. 更早的消息：每 N 条压缩为一段摘要（快速文本截取）
 *   c. 系统 prompt 注入记忆上下文
 */
export function buildContext(
  allMessages: OllamaMessage[],
  options: ContextBuildOptions = {}
): OllamaMessage[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const result: OllamaMessage[] = [];

  // R17: System 消息分区 — 稳定部分在前，动态部分在后，支持 LLM Prefix Caching
  // 稳定部分：已有的 system 消息（SOUL.md、规则等，不随会话变化）
  // 动态部分：memoryContext、workspaceContext（每轮可能变化）
  const existingSystem = allMessages.filter(m => m.role === 'system');
  const stableParts: string[] = [];
  const dynamicParts: string[] = [];

  for (const sys of existingSystem) {
    if (isStableSystemMessage(sys.content || '')) {
      stableParts.push(sys.content || '');
    } else {
      dynamicParts.push(sys.content || '');
    }
  }
  // memoryContext 和 workspaceContext 是动态的
  if (opts.memoryContext) dynamicParts.push(opts.memoryContext);
  if (opts.workspaceContext) dynamicParts.push(opts.workspaceContext);

  let systemContent = '';
  // 稳定前缀优先
  if (stableParts.length > 0) systemContent += stableParts.join('\n\n') + '\n\n';
  // 动态部分在后
  if (dynamicParts.length > 0) systemContent += dynamicParts.join('\n\n') + '\n\n';

  if (systemContent.trim()) {
    result.push({ role: 'system', content: systemContent.trim() });
  }

  // 非 system 消息
  const nonSystemMessages = allMessages.filter(m => m.role !== 'system');

  if (nonSystemMessages.length <= opts.windowSize) {
    result.push(...nonSystemMessages);
    return result;
  }

  // 滑动窗口：最近 N 条
  const recentMessages = nonSystemMessages.slice(-opts.windowSize);

  // 更早的消息：已压缩标记的保留原样，未压缩的做快速摘要
  const olderMessages = nonSystemMessages.slice(0, -opts.windowSize);
  const compressedMsgs = olderMessages.filter(m => m.compressed);
  const uncompressedMsgs = olderMessages.filter(m => !m.compressed);

  // 已压缩的消息直接保留
  result.push(...compressedMsgs);

  // 未压缩的消息做快速摘要
  if (uncompressedMsgs.length > 0) {
    const summaries = summarizeOlderMessages(uncompressedMsgs, opts.summaryBatchSize);
    result.push(...summaries);
  }

  result.push(...recentMessages);

  // Token 估算和裁剪
  const trimmed = trimByTokenLimit(result, opts.maxTokens);

  logInfo(`上下文构建: ${nonSystemMessages.length} 条消息 → ${trimmed.length} 条 (窗口: ${opts.windowSize})`,
    `估算 tokens: ${estimateTokens(trimmed.map(m => m.content).join(''))}`);

  return trimmed;
}

/**
 * 判断是否需要自动压缩
 * 当总 token 数超过 context window 的 AUTO_COMPRESS_THRESHOLD 比例时返回 true
 * C3: 包含 tool_calls 和 images 的 token 开销
 * R13: tool_calls 开销按实际参数大小估算而非固定 50
 */
export function shouldAutoCompress(messages: OllamaMessage[], numCtx: number): boolean {
  let totalTokens = 0;
  for (const m of messages) {
    totalTokens += estimateTokens(m.content || '');
    // R13: tool_calls 开销按实际 JSON 参数大小估算
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        const argsSize = JSON.stringify(tc.function.arguments || {}).length;
        totalTokens += estimateTokens(tc.function.name) + Math.ceil(argsSize / 4) + 20; // 20 tokens overhead per call
      }
    }
    if (m.images?.length) totalTokens += m.images.length * 100;
  }
  // R14: 使用自适应压缩阈值
  const threshold = numCtx * getAdaptiveCompressThreshold(numCtx);
  return totalTokens > threshold;
}

// ── 结构化压缩 ──

/** 结构化摘要 */
export interface StructuredSummary {
  /** 讨论的主题 */
  topics: string[];
  /** 已做出的决定 */
  decisions: string[];
  /** 未完成的待办事项 */
  pendingTasks: string[];
  /** 发现的约束/规则 */
  constraints: string[];
  /** 关键知识点（跨会话有价值的信息） */
  knowledge: string[];
  /** 工具调用结果摘要 */
  toolResults: string[];
}

/**
 * LLM 摘要压缩：调用模型对中间消息生成结构化 JSON 摘要。
 * 保留首尾各 keepHead/keepTail 条消息，中间用 JSON 摘要替换。
 * v6.0: 输出结构化 JSON，支持增量合并。
 *
 * @returns 压缩后的消息列表（包含 compressed 标记的摘要消息）
 */
export async function compressWithLLM(
  messages: OllamaMessage[],
  api: { chatStream: (params: Record<string, unknown>, onChunk: (chunk: OllamaStreamChunk) => void, ac?: AbortController) => Promise<void> },
  model: string,
  options: {
    keepHead?: number;
    keepTail?: number;
    maxSummaryTokens?: number;
    abortController?: AbortController;
  } = {}
): Promise<OllamaMessage[]> {
  const keepHead = options.keepHead ?? COMPRESS_KEEP_HEAD;
  const keepTail = options.keepTail ?? COMPRESS_KEEP_TAIL;
  const maxSummaryTokens = options.maxSummaryTokens ?? 500;

  // C1: 分离 system 和非 system 消息，再细分不可压缩的 system 消息
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');
  const incompressibleSysMsgs: OllamaMessage[] = [];
  const compressibleSysMsgs: OllamaMessage[] = [];
  for (const m of systemMsgs) {
    if (scoreMessageImportance(m) >= 10) {
      incompressibleSysMsgs.push(m);
    } else {
      compressibleSysMsgs.push(m);
    }
  }

  if (nonSystemMsgs.length <= keepHead + keepTail + 2) {
    logInfo('上下文压缩: 消息太少，跳过压缩');
    return messages;
  }

  const head = nonSystemMsgs.slice(0, keepHead);
  const tail = nonSystemMsgs.slice(-keepTail);
  const middle = nonSystemMsgs.slice(keepHead, nonSystemMsgs.length - keepTail);

  // R15: 对话轮次边界保护 — 调整 head/tail 切分点，避免在对话轮次中间切割
  // 如果 head 末尾是带 tool_calls 的 assistant，将后续 tool 消息也纳入 head
  if (head.length > 0 && head[head.length - 1].tool_calls?.length) {
    let extendIdx = 0;
    while (extendIdx < middle.length && middle[extendIdx].role === 'tool') {
      head.push(middle[extendIdx]);
      extendIdx++;
    }
    middle.splice(0, extendIdx);
  }
  // 如果 tail 开头是 tool 消息（无对应 assistant），向前扩展到包含 assistant
  if (tail.length > 0 && tail[0].role === 'tool') {
    let extendBack = middle.length - 1;
    while (extendBack >= 0 && middle[extendBack].role !== 'assistant') {
      extendBack--;
    }
    if (extendBack >= 0) {
      const moved = middle.splice(extendBack);
      tail.unshift(...moved);
    }
  }

  // 过滤掉已经压缩过的消息（避免重复压缩）
  const uncompressedMiddle = middle.filter(m => !m.compressed);
  if (uncompressedMiddle.length === 0) {
    logInfo('上下文压缩: 中间消息已全部压缩，跳过');
    return messages;
  }

  // R12: 压缩去重 — 检查这批消息是否已被压缩过（内容指纹匹配）
  if (isAlreadyCompressed(uncompressedMiddle)) {
    logInfo('R12: 消息批次内容指纹匹配已压缩记录，跳过重复压缩');
    return messages;
  }

  // 构建对话文本
  const conversationText = uncompressedMiddle.map(m => {
    const role = m.role === 'user' ? '用户' : 'AI';
    let content = m.content || '';
    if (content.length > 2000) content = content.slice(0, 2000) + '...';
    if (m.tool_calls?.length) {
      const toolNames = m.tool_calls.map(t => t.function.name).join(', ');
      content += ` [工具调用: ${toolNames}]`;
    }
    return `${role}: ${content}`;
  }).join('\n');

  logInfo(`上下文压缩: 开始 LLM 摘要，${uncompressedMiddle.length} 条消息待压缩`);

  let summaryJson = '';
  try {
    await api.chatStream(
      {
        model,
        messages: [{
          role: 'user',
          content: `请将以下对话摘要为结构化 JSON。保留关键信息，用中文输出。严格按此 JSON 格式返回（不要输出其他内容）：\n\n{\n  "topics": ["讨论的 2-4 个核心主题"],\n  "decisions": ["已做出的决定（最多 3 条）"],\n  "pendingTasks": ["尚未完成的任务（最多 3 条）"],\n  "constraints": ["发现的约束/规则/偏好（最多 3 条）"],\n  "knowledge": ["跨会话有价值的长期知识点（最多 3 条）"],\n  "toolResults": ["关键工具调用结果摘要（最多 3 条）"]\n}\n\n对话记录：\n${conversationText}`
        }],
        stream: true,
        think: false,
        options: { num_ctx: 8192, temperature: 0.3 }
      },
      (chunk: OllamaStreamChunk) => {
        if (chunk.message?.content) {
          summaryJson += chunk.message.content;
        }
      },
      options.abortController
    );
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      logWarn('上下文压缩: LLM 调用被中止');
      return messages;
    }
    logError('上下文压缩: LLM 调用失败', (err as Error).message);
    return messages;
  }

  if (!summaryJson.trim()) {
    logWarn('上下文压缩: 模型未返回摘要内容');
    return messages;
  }

  // 解析 JSON 摘要（容错：提取第一个 JSON 块或直接解析）
  let parsed: StructuredSummary;
  try {
    const jsonMatch = summaryJson.match(/\{[\s\S]*"topics"[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(summaryJson);
  } catch {
    logWarn('上下文压缩: JSON 解析失败，使用纯文本摘要');
    parsed = { topics: [summaryJson.slice(0, 100)], decisions: [], pendingTasks: [], constraints: [], knowledge: [], toolResults: [] };
  }

  // R16: 增量摘要合并 — 提取已有压缩摘要并与新摘要合并
  const alreadyCompressedMiddle = middle.filter(m => m.compressed && m.role !== 'system');
  if (alreadyCompressedMiddle.length > 0) {
    const oldSummary = extractStructuredSummary(alreadyCompressedMiddle);
    parsed = mergeSummaries(oldSummary, parsed);
    logInfo(`R16: 合并了 ${alreadyCompressedMiddle.length} 条旧摘要到新摘要`);
  }

  // 构建结构化摘要消息文本
  const parts: string[] = [];
  if (parsed.topics.length) parts.push(`📌 主题: ${parsed.topics.join('；')}`);
  if (parsed.decisions.length) parts.push(`✅ 决策: ${parsed.decisions.join('；')}`);
  if (parsed.pendingTasks.length) parts.push(`⏳ 待办: ${parsed.pendingTasks.join('；')}`);
  if (parsed.constraints.length) parts.push(`📏 约束: ${parsed.constraints.join('；')}`);
  if (parsed.knowledge.length) parts.push(`🧠 知识点: ${parsed.knowledge.join('；')}`);
  if (parsed.toolResults.length) parts.push(`🔧 工具结果: ${parsed.toolResults.join('；')}`);

  // R11: 压缩质量验证 — 如果摘要为空或过短，回退到文本摘要
  if (parts.length === 0 || parts.join('').length < 50) {
    logWarn('R11: 压缩摘要质量不足，回退到文本摘要');
    const textSummary = uncompressedMiddle.map(m => {
      const role = m.role === 'user' ? '用户' : 'AI';
      const content = (m.content || '').slice(0, 200);
      return `${role}: ${content}`;
    }).join('\n').slice(0, 1000);
    parts.length = 0;
    parts.push(`📌 主题: ${textSummary}`);
  }

  // 构建压缩后的摘要消息
  // C5: 使用 user role 而非 system role，避免部分模型拒绝多个 system 消息
  const summaryMsg: OllamaMessage = {
    role: 'user',
    content: `📋 以下是对之前对话的摘要（已压缩 ${uncompressedMiddle.length} 条消息）：\n\n${parts.join('\n')}`,
    compressed: true
  };

  // R16: 保留已压缩的中间消息（system 消息单独处理）+ 新摘要
  // R12: 标记这批消息为已压缩
  markAsCompressed(uncompressedMiddle);
  // R16: 已压缩的旧摘要已被合并到新摘要中，不再保留它们
  const alreadyCompressed = middle.filter(m => m.compressed && m.role === 'system');

  // C1: 合并 system 消息为一条，但保留不可压缩的 system 消息完整内容
  const mergedSystemContent = [
    ...incompressibleSysMsgs.map(m => m.content || ''),
    ...compressibleSysMsgs.map(m => m.content || ''),
    ...alreadyCompressed.filter(m => m.role === 'system').map(m => m.content || ''),
  ].filter(Boolean).join('\n\n');

  const nonSystemCompressed = alreadyCompressed.filter(m => m.role !== 'system');

  const result: OllamaMessage[] = [
    { role: 'system', content: mergedSystemContent },
    ...head,
    ...nonSystemCompressed,
    summaryMsg,
    ...tail
  ];

  // R17: System 消息分区优化 — 将 system 消息按稳定性排序，支持 LLM Prefix Caching
  // 稳定部分（SOUL.md、规则等）放在最前面，动态部分（工作空间、记忆）放在后面
  // 这样 Ollama 可以缓存稳定前缀，只重新处理动态部分
  reorderSystemMessagesForPrefixCaching(result);

  const beforeTokens = estimateTokens(messages.map(m => m.content || '').join(''));
  const afterTokens = estimateTokens(result.map(m => m.content || '').join(''));

  // R19: 记录压缩指标
  const metrics: CompressionMetrics = {
    beforeMessages: messages.length,
    afterMessages: result.length,
    beforeTokens,
    afterTokens,
    compressionRatio: beforeTokens > 0 ? afterTokens / beforeTokens : 1.0,
    timestamp: Date.now(),
  };
  _compressionHistory.push(metrics);
  if (_compressionHistory.length > MAX_COMPRESSION_HISTORY) {
    _compressionHistory.shift();
  }

  logSuccess(`上下文压缩完成: ${messages.length} 条 → ${result.length} 条, tokens: ${beforeTokens} → ${afterTokens} (压缩率: ${(metrics.compressionRatio * 100).toFixed(0)}%)`);

  return result;
}

/**
 * 将较早的消息每 batchSize 条压缩为一段摘要。
 * v6.0: 重要性高的消息保留更多内容，低价值消息激进截断。
 */
function summarizeOlderMessages(messages: OllamaMessage[], batchSize: number): OllamaMessage[] {
  const summaries: OllamaMessage[] = [];

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const summary = createQuickSummary(batch);
    summaries.push({
      role: 'system',
      content: `【更早的对话摘要（第 ${Math.floor(i / batchSize) + 1} 部分）】\n${summary}`,
      compressed: true
    });
  }

  return summaries;
}

/**
 * 快速摘要：重要性高的消息保留更多信息，低价值的激进截断
 */
function createQuickSummary(messages: OllamaMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role = msg.role === 'user' ? '用户' : 'AI';
    const content = msg.content || '';
    const importance = scoreMessageImportance(msg);

    let preview: string;
    if (importance >= 8) {
      // 高价值消息：保留 200 字
      preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
    } else if (importance >= 5) {
      // 中等价值：保留 100 字
      preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    } else {
      // 低价值：仅保留 40 字或跳过
      if (content.trim().length < 10) continue;
      preview = content.length > 40 ? content.slice(0, 40) + '...' : content;
    }

    if (preview.trim()) {
      parts.push(`${role}: ${preview}`);
    }
    if (msg.tool_calls?.length) {
      const toolNames = msg.tool_calls.map(t => t.function.name).join(', ');
      parts.push(`  [工具: ${toolNames}]`);
    }
  }

  return parts.join('\n');
}

/**
 * 根据 token 限制裁剪消息。
 * v6.0: 按重要性评分决定保留顺序——重要性低的优先被丢弃。
 * C2: 始终保留最近 N 条消息（时间窗口保护），避免丢失关键上下文
 */
function trimByTokenLimit(messages: OllamaMessage[], maxTokens: number): OllamaMessage[] {
  // 分离 system 和非 system 消息
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');

  if (nonSystemMsgs.length <= 4) return messages; // 消息太少不裁剪

  // C2: 最近 6 条消息始终保留（时间窗口保护）
  const PROTECT_RECENT = 6;
  const recentMsgs = nonSystemMsgs.slice(-PROTECT_RECENT);
  const olderMsgs = nonSystemMsgs.slice(0, -PROTECT_RECENT);

  // 计算每条消息的 token + 重要性
  const scored = olderMsgs.map(m => ({
    msg: m,
    tokens: estimateTokens(m.content || '') +
      (m.images ? m.images.length * 100 : 0) +
      (m.tool_calls ? m.tool_calls.length * 50 : 0),
    importance: scoreMessageImportance(m),
  }));

  // system 消息的 token 消耗
  const systemTokens = systemMsgs.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
  const recentTokens = recentMsgs.reduce((sum, m) =>
    sum + estimateTokens(m.content || '') +
    (m.images ? m.images.length * 100 : 0) +
    (m.tool_calls ? m.tool_calls.length * 50 : 0), 0);
  const availableTokens = maxTokens - systemTokens - recentTokens;

  if (availableTokens <= 0) {
    // 连 system + recent 都超了，只保留 system + recent
    return [...systemMsgs, ...recentMsgs];
  }

  // 按重要性降序排列，取能装下的最大数量
  scored.sort((a, b) => b.importance - a.importance);

  let usedTokens = 0;
  const kept = new Set<number>(); // 保留的索引
  for (let i = 0; i < scored.length; i++) {
    if (usedTokens + scored[i].tokens > availableTokens && kept.size >= 2) break;
    usedTokens += scored[i].tokens;
    kept.add(i);
  }

  // 按原始顺序重建：system → 按重要性保留的旧消息 → 最近的 protected 消息
  const result: OllamaMessage[] = [...systemMsgs];
  const keptSet = new Set(scored.filter((_, i) => kept.has(i)).map(s => s.msg));
  for (const m of olderMsgs) {
    if (keptSet.has(m)) result.push(m);
  }
  result.push(...recentMsgs);

  return result;
}
