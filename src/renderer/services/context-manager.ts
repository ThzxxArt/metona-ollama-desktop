/**
 * Context Manager - 智能上下文管理 (v5.0)
 * 三层策略：滑动窗口 + LLM 摘要压缩 + 记忆注入
 * 支持自动压缩与手动 /compress 触发
 */

import type { OllamaMessage, OllamaStreamChunk } from '../types.js';
import { logInfo, logWarn, logSuccess, logError } from './log-service.js';

// ── Token 校准系统 ──

/** 校准比例：actualTokens / estimatedTokens，基于 Ollama 返回的实际计数动态修正 */
let _tokenCalibrationRatio = 1.0;
let _calibrationSamples = 0;
const MIN_CALIBRATION_SAMPLES = 3;

/**
 * 记录 Ollama 返回的实际 token 计数，用于校准估算器。
 * 在 agent-engine.ts 每轮流式完成后调用。
 * @param actualInputTokens Ollama 返回的 prompt_eval_count
 * @param actualOutputTokens Ollama 返回的 eval_count
 * @param estimatedTokens 本轮消息调用 estimateTokens 的合计值
 */
export function recordActualTokens(actualInputTokens: number, actualOutputTokens: number, estimatedCount: number): void {
  if (actualInputTokens <= 0 || estimatedCount <= 0) return;
  const actualTotal = actualInputTokens + actualOutputTokens;
  const sampleRatio = actualTotal / Math.max(1, estimatedCount);
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
export const AUTO_COMPRESS_THRESHOLD = 0.5;

/** 压缩后保留首尾消息数 */
const COMPRESS_KEEP_HEAD = 2;
const COMPRESS_KEEP_TAIL = 2;

// ── 消息重要性评分（纯规则，不调用 LLM）──

/** 重要性评分：0-10，越高越应该保留。SOUL.md 和规则记忆始终保留。 */
export function scoreMessageImportance(msg: OllamaMessage): number {
  let score = 5; // 默认中等

  // SOUL.md / 日期 / 环境 消息永远不可压缩
  if (msg.content?.startsWith('[SOUL.md]')) return 10;
  if (msg.content?.startsWith('[日期]')) return 10;
  if (msg.content?.startsWith('[环境]')) return 10;

  // 角色权重
  if (msg.role === 'user') score += 2;      // 用户消息最重要
  if (msg.role === 'system') score -= 2;    // 系统消息通常可压缩

  // ephemeral 临时消息 → 最低权重，优先丢弃
  if (msg.ephemeral) return 0;

  // 已压缩标记 → 低权重（避免压缩产物堆积）
  if (msg.compressed) score = 1;

  const content = msg.content || '';

  // 关键词检测
  const highValuePatterns = [/路径|目录|path|file|config|配置|命令|command|exec/i,
    /错误|error|失败|fail|bug|fix|修复|解决/i,
    /版本|version|API|http|url|端口|port|localhost/i,
    /记住|保存|memory|偏好|偏好|规则|rule/i,
    /完成|done|✓|success|成功|结果|result/i,
    /项目|project|工作空间|workspace|git|repo|仓库/i,
  ];
  const lowValuePatterns = [/好的|明白|ok|知道了|嗯|哦|好/i,
    /继续|请|帮我|可以吗/i,
    /谢谢|感谢|不客气/i,
  ];

  for (const p of highValuePatterns) {
    if (p.test(content)) { score += 1; break; }
  }
  for (const p of lowValuePatterns) {
    if (p.test(content) && content.length < 100) { score -= 2; break; }
  }

  // 工具调用 → 高价值
  if (msg.tool_calls?.length) score += 2;

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

const DEFAULT_OPTIONS: Required<ContextBuildOptions> = {
  windowSize: 20,
  summaryBatchSize: 20,
  maxTokens: 24576,
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

  // 系统 prompt
  let systemContent = '';
  if (opts.memoryContext) {
    systemContent += opts.memoryContext + '\n\n';
  }
  if (opts.workspaceContext) {
    systemContent += opts.workspaceContext + '\n\n';
  }

  // 提取已有的 system 消息
  const existingSystem = allMessages.filter(m => m.role === 'system');
  for (const sys of existingSystem) {
    systemContent += sys.content + '\n';
  }

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
 */
export function shouldAutoCompress(messages: OllamaMessage[], numCtx: number): boolean {
  const totalTokens = estimateTokens(messages.map(m => m.content || '').join(''));
  const threshold = numCtx * AUTO_COMPRESS_THRESHOLD;
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

  // 分离 system 和非 system 消息
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');

  if (nonSystemMsgs.length <= keepHead + keepTail + 2) {
    logInfo('上下文压缩: 消息太少，跳过压缩');
    return messages;
  }

  const head = nonSystemMsgs.slice(0, keepHead);
  const tail = nonSystemMsgs.slice(-keepTail);
  const middle = nonSystemMsgs.slice(keepHead, nonSystemMsgs.length - keepTail);

  // 过滤掉已经压缩过的消息（避免重复压缩）
  const uncompressedMiddle = middle.filter(m => !m.compressed);
  if (uncompressedMiddle.length === 0) {
    logInfo('上下文压缩: 中间消息已全部压缩，跳过');
    return messages;
  }

  // 构建对话文本
  const conversationText = uncompressedMiddle.map(m => {
    const role = m.role === 'user' ? '用户' : 'AI';
    let content = m.content || '';
    if (content.length > 500) content = content.slice(0, 500) + '...';
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

  // 构建结构化摘要消息文本
  const parts: string[] = [];
  if (parsed.topics.length) parts.push(`📌 主题: ${parsed.topics.join('；')}`);
  if (parsed.decisions.length) parts.push(`✅ 决策: ${parsed.decisions.join('；')}`);
  if (parsed.pendingTasks.length) parts.push(`⏳ 待办: ${parsed.pendingTasks.join('；')}`);
  if (parsed.constraints.length) parts.push(`📏 约束: ${parsed.constraints.join('；')}`);
  if (parsed.knowledge.length) parts.push(`🧠 知识点: ${parsed.knowledge.join('；')}`);
  if (parsed.toolResults.length) parts.push(`🔧 工具结果: ${parsed.toolResults.join('；')}`);

  // 构建压缩后的摘要消息
  const summaryMsg: OllamaMessage = {
    role: 'system',
    content: `📋 以下是对之前对话的摘要（已压缩 ${uncompressedMiddle.length} 条消息）：\n\n${parts.join('\n')}`,
    compressed: true
  };

  // 保留已压缩的中间消息 + 新摘要
  const alreadyCompressed = middle.filter(m => m.compressed);

  const result: OllamaMessage[] = [
    ...systemMsgs,
    ...head,
    ...alreadyCompressed,
    summaryMsg,
    ...tail
  ];

  const beforeTokens = estimateTokens(messages.map(m => m.content || '').join(''));
  const afterTokens = estimateTokens(result.map(m => m.content || '').join(''));

  logSuccess(`上下文压缩完成: ${messages.length} 条 → ${result.length} 条, tokens: ${beforeTokens} → ${afterTokens}`);

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
 */
function trimByTokenLimit(messages: OllamaMessage[], maxTokens: number): OllamaMessage[] {
  // 分离 system 和非 system 消息
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');

  if (nonSystemMsgs.length <= 4) return messages; // 消息太少不裁剪

  // 计算每条消息的 token + 重要性
  const scored = nonSystemMsgs.map(m => ({
    msg: m,
    tokens: estimateTokens(m.content || '') +
      (m.images ? m.images.length * 100 : 0) +
      (m.tool_calls ? m.tool_calls.length * 50 : 0),
    importance: scoreMessageImportance(m),
  }));

  // system 消息的 token 消耗
  const systemTokens = systemMsgs.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
  const availableTokens = maxTokens - systemTokens;

  // 按重要性降序排列，取能装下的最大数量
  scored.sort((a, b) => b.importance - a.importance);

  let usedTokens = 0;
  const kept = new Set<number>(); // 保留的索引
  for (let i = 0; i < scored.length; i++) {
    if (usedTokens + scored[i].tokens > availableTokens && kept.size >= 2) break;
    usedTokens += scored[i].tokens;
    kept.add(i);
  }

  // 按原始顺序重建：system → 按重要性保留的非system
  const result: OllamaMessage[] = [...systemMsgs];
  // 使用原始顺序而非重要性顺序，保持对话的时间线
  const keptSet = new Set(scored.filter((_, i) => kept.has(i)).map(s => s.msg));
  for (const m of nonSystemMsgs) {
    if (keptSet.has(m)) result.push(m);
  }

  return result;
}
