/**
 * Context Manager - 智能上下文管理 (v5.0)
 * 三层策略：滑动窗口 + LLM 摘要压缩 + 记忆注入
 * 支持自动压缩与手动 /compress 触发
 */

import type { OllamaMessage, OllamaStreamChunk } from '../types.js';
import { logInfo, logWarn, logSuccess, logError } from './log-service.js';

/** 粗略估算 token 数 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 中文按 1.5 字/token，英文按 4 字符/token
  let chineseChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) chineseChars++;
    else otherChars++;
  }
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/** 自动压缩阈值：当消息 token 占 context window 比例超过此值时触发自动压缩 */
export const AUTO_COMPRESS_THRESHOLD = 0.5;

/** 压缩后保留首尾消息数 */
const COMPRESS_KEEP_HEAD = 2;
const COMPRESS_KEEP_TAIL = 2;

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

/**
 * LLM 摘要压缩：调用模型对中间消息生成摘要
 * 保留首尾各 keepHead/keepTail 条消息，中间用 LLM 摘要替换
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

  let summary = '';
  try {
    await api.chatStream(
      {
        model,
        messages: [{
          role: 'user',
          content: `请将以下对话摘要为一段简洁的上下文总结。保留关键信息：讨论的主题、得出的结论、用户的偏好、未完成的任务、关键工具调用结果。用中文输出，不超过 ${maxSummaryTokens} 字。\n\n对话记录：\n${conversationText}`
        }],
        stream: true,
        think: false,
        options: { num_ctx: 8192, temperature: 0.3 }
      },
      (chunk: OllamaStreamChunk) => {
        if (chunk.message?.content) {
          summary += chunk.message.content;
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

  if (!summary.trim()) {
    logWarn('上下文压缩: 模型未返回摘要内容');
    return messages;
  }

  // 构建压缩后的摘要消息
  const summaryMsg: OllamaMessage = {
    role: 'system',
    content: `📋 以下是对之前对话的摘要（已压缩 ${uncompressedMiddle.length} 条消息）：\n\n${summary}`,
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
 * 将较早的消息每 batchSize 条压缩为一段摘要（快速文本截取，不调用 LLM）
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
 * 快速摘要（不调用模型，直接提取关键信息）
 */
function createQuickSummary(messages: OllamaMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role = msg.role === 'user' ? '用户' : 'AI';
    const content = msg.content || '';
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
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
 * 根据 token 限制裁剪消息
 */
function trimByTokenLimit(messages: OllamaMessage[], maxTokens: number): OllamaMessage[] {
  let totalTokens = 0;
  const result: OllamaMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = estimateTokens(msg.content || '') +
      (msg.images ? msg.images.length * 100 : 0) +
      (msg.tool_calls ? msg.tool_calls.length * 50 : 0);

    // system 消息始终保留
    if (msg.role === 'system') {
      totalTokens += msgTokens;
      result.unshift(msg);
      continue;
    }

    if (totalTokens + msgTokens > maxTokens && result.length > 2) {
      break;
    }

    totalTokens += msgTokens;
    result.unshift(msg);
  }

  return result;
}
