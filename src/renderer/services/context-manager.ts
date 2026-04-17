/**
 * Context Manager - 智能上下文管理 (v4.0)
 * 三层策略：滑动窗口 + 消息摘要压缩 + 记忆注入
 */

import type { OllamaMessage } from '../types.js';
import { logInfo, logWarn } from './log-service.js';

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
 * 构建发送给模型的 messages
 * 三层策略：
 *   a. 滑动窗口：最近 N 条消息完整保留
 *   b. 更早的消息：每 N 条压缩为一段摘要
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
  const existingSystem = allMessages.find(m => m.role === 'system');
  if (existingSystem) {
    systemContent += existingSystem.content;
  }

  if (systemContent.trim()) {
    result.push({ role: 'system', content: systemContent.trim() });
  }

  // 非 system 消息
  const nonSystemMessages = allMessages.filter(m => m.role !== 'system');

  if (nonSystemMessages.length <= opts.windowSize) {
    // 消息不多，全部保留
    result.push(...nonSystemMessages);
    return result;
  }

  // 滑动窗口：最近 N 条
  const recentMessages = nonSystemMessages.slice(-opts.windowSize);

  // 更早的消息：压缩为摘要
  const olderMessages = nonSystemMessages.slice(0, -opts.windowSize);
  const summaries = summarizeOlderMessages(olderMessages, opts.summaryBatchSize);

  result.push(...summaries, ...recentMessages);

  // Token 估算和裁剪
  const trimmed = trimByTokenLimit(result, opts.maxTokens);

  logInfo(`上下文构建: ${nonSystemMessages.length} 条消息 → ${trimmed.length} 条 (窗口: ${opts.windowSize})`,
    `估算 tokens: ${estimateTokens(trimmed.map(m => m.content).join(''))}`);

  return trimmed;
}

/**
 * 将较早的消息每 batchSize 条压缩为一段摘要
 */
function summarizeOlderMessages(messages: OllamaMessage[], batchSize: number): OllamaMessage[] {
  const summaries: OllamaMessage[] = [];

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const summary = createQuickSummary(batch);
    summaries.push({
      role: 'system',
      content: `【更早的对话摘要（第 ${Math.floor(i / batchSize) + 1} 部分）】\n${summary}`
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
    // 取前 100 字符作为摘要
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    if (preview.trim()) {
      parts.push(`${role}: ${preview}`);
    }
    // 如果有工具调用，记录工具名
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

  // 从后往前添加（优先保留最近的消息）
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
      break; // 已到限制，保留至少 system + 1 条消息
    }

    totalTokens += msgTokens;
    result.unshift(msg);
  }

  return result;
}
