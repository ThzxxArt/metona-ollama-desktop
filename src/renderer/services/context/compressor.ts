/**
 * LLM 结构化摘要压缩。
 */

import type { OllamaMessage, OllamaStreamChunk, OllamaChatParams } from '../../types.js';
import { logInfo, logWarn, logSuccess, logError } from '../log-service.js';
import {
  estimateTokens,
  isAlreadyCompressed,
  markAsCompressed,
  recordCompressionMetrics,
  type CompressionMetrics,
} from './tokenizer.js';
import {
  scoreMessageImportance,
  extractStructuredSummary,
  mergeSummaries,
  reorderSystemMessagesForPrefixCaching,
} from './builder.js';
import type { StructuredSummary } from './types.js';

const COMPRESS_KEEP_HEAD = 5;
const COMPRESS_KEEP_TAIL = 8;

export async function compressWithLLM(
  messages: OllamaMessage[],
  api: {
    chatStream: (
      params: OllamaChatParams,
      onChunk: (chunk: OllamaStreamChunk) => void,
      abortController?: AbortController,
    ) => Promise<void>;
  },
  model: string,
  options: {
    keepHead?: number;
    keepTail?: number;
    maxSummaryTokens?: number;
    abortController?: AbortController;
  } = {},
): Promise<OllamaMessage[]> {
  const keepHead = options.keepHead ?? COMPRESS_KEEP_HEAD;
  const keepTail = options.keepTail ?? COMPRESS_KEEP_TAIL;

  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
  const incompressibleSysMsgs: OllamaMessage[] = [];
  const compressibleSysMsgs: OllamaMessage[] = [];
  for (const m of systemMsgs) {
    if (scoreMessageImportance(m) >= 10) incompressibleSysMsgs.push(m);
    else compressibleSysMsgs.push(m);
  }

  if (nonSystemMsgs.length <= keepHead + keepTail + 2) {
    logInfo('上下文压缩: 消息太少，跳过压缩');
    return messages;
  }

  const head = nonSystemMsgs.slice(0, keepHead);
  const tail = nonSystemMsgs.slice(-keepTail);
  const middle = nonSystemMsgs.slice(keepHead, nonSystemMsgs.length - keepTail);

  if (head.length > 0) {
    for (let i = 0; i < head.length; i++) {
      const m = head[i];
      if (m.compressed && m.tool_calls?.length) {
        const newMsg: OllamaMessage = { ...m };
        delete newMsg.tool_calls;
        head[i] = newMsg;
      }
      if (m.compressed && m.role === 'tool') {
        head[i] = { ...m, content: '', compressed: true };
      }
    }
    const filteredHead = head.filter((m) => !(m.compressed && m.role === 'tool' && !m.content));
    head.length = 0;
    head.push(...filteredHead);
  }

  if (head.length > 0 && head[head.length - 1].tool_calls?.length) {
    let extendIdx = 0;
    while (extendIdx < middle.length && middle[extendIdx].role === 'tool') {
      head.push(middle[extendIdx]);
      extendIdx++;
    }
    middle.splice(0, extendIdx);
  }
  if (tail.length > 0 && tail[0].role === 'tool') {
    let extendBack = middle.length - 1;
    while (extendBack >= 0 && middle[extendBack].role !== 'assistant') extendBack--;
    if (extendBack >= 0) {
      tail.unshift(...middle.splice(extendBack));
    } else {
      tail.shift();
    }
  }

  const uncompressedMiddle = middle.filter((m) => !m.compressed);
  if (uncompressedMiddle.length === 0) {
    logInfo('上下文压缩: 中间消息已全部压缩，跳过');
    return messages;
  }

  if (isAlreadyCompressed(uncompressedMiddle)) {
    logInfo('R12: 消息批次内容指纹匹配已压缩记录，跳过重复压缩');
    return messages;
  }

  const conversationText = uncompressedMiddle
    .map((m) => {
      const role = m.role === 'user' ? '用户' : 'AI';
      let content = m.content || '';
      if (content.length > 2000) content = content.slice(0, 2000) + '...';
      if (m.tool_calls?.length) {
        content += ` [工具调用: ${m.tool_calls.map((t) => t.function.name).join(', ')}]`;
      }
      return `${role}: ${content}`;
    })
    .join('\n');

  logInfo(`上下文压缩: 开始 LLM 摘要，${uncompressedMiddle.length} 条消息待压缩`);

  let summaryJson = '';
  try {
    await api.chatStream(
      {
        model,
        messages: [
          {
            role: 'user',
            content: `请将以下对话摘要为结构化 JSON。保留关键信息，用中文输出。严格按此 JSON 格式返回（不要输出其他内容）：\n\n{\n  "topics": ["讨论的 2-4 个核心主题"],\n  "decisions": ["已做出的决定（最多 3 条）"],\n  "pendingTasks": ["尚未完成的任务（最多 3 条）"],\n  "constraints": ["发现的约束/规则/偏好（最多 3 条）"],\n  "knowledge": ["跨会话有价值的长期知识点（最多 3 条）"],\n  "toolResults": ["关键工具调用结果摘要（最多 3 条）"]\n}\n\n对话记录：\n${conversationText}`,
          },
        ],
        stream: true,
        think: false,
        format: {
          type: 'object',
          properties: {
            topics: { type: 'array', items: { type: 'string' } },
            decisions: { type: 'array', items: { type: 'string' } },
            pendingTasks: { type: 'array', items: { type: 'string' } },
            constraints: { type: 'array', items: { type: 'string' } },
            knowledge: { type: 'array', items: { type: 'string' } },
            toolResults: { type: 'array', items: { type: 'string' } },
          },
          required: ['topics', 'decisions', 'pendingTasks', 'constraints', 'knowledge', 'toolResults'],
        },
        options: { num_ctx: 8192 },
      },
      (chunk: OllamaStreamChunk) => {
        if (chunk.message?.content) summaryJson += chunk.message.content;
      },
      options.abortController,
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

  let parsed: StructuredSummary;
  try {
    const jsonMatch = summaryJson.match(/\{[\s\S]*"topics"[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(summaryJson);
  } catch {
    logWarn('上下文压缩: JSON 解析失败，使用纯文本摘要');
    parsed = {
      topics: [summaryJson.slice(0, 100)],
      decisions: [],
      pendingTasks: [],
      constraints: [],
      knowledge: [],
      toolResults: [],
    };
  }

  const alreadyCompressedMiddle = middle.filter((m) => m.compressed && m.role !== 'system');
  if (alreadyCompressedMiddle.length > 0) {
    parsed = mergeSummaries(extractStructuredSummary(alreadyCompressedMiddle), parsed);
    logInfo(`R16: 合并了 ${alreadyCompressedMiddle.length} 条旧摘要到新摘要`);
  }

  const parts: string[] = [];
  if (parsed.topics.length) parts.push(`📌 主题: ${parsed.topics.join('；')}`);
  if (parsed.decisions.length) parts.push(`✅ 决策: ${parsed.decisions.join('；')}`);
  if (parsed.pendingTasks.length) parts.push(`⏳ 待办: ${parsed.pendingTasks.join('；')}`);
  if (parsed.constraints.length) parts.push(`📏 约束: ${parsed.constraints.join('；')}`);
  if (parsed.knowledge.length) parts.push(`🧠 知识点: ${parsed.knowledge.join('；')}`);
  if (parsed.toolResults.length) parts.push(`🔧 工具结果: ${parsed.toolResults.join('；')}`);

  if (parts.length === 0 || parts.join('').length < 50) {
    logWarn('R11: 压缩摘要质量不足，回退到文本摘要');
    const textSummary = uncompressedMiddle
      .map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${(m.content || '').slice(0, 200)}`)
      .join('\n')
      .slice(0, 1000);
    parts.length = 0;
    parts.push(`📌 主题: ${textSummary}`);
  }

  const summaryMsg: OllamaMessage = {
    role: 'user',
    content: `📋 以下是对之前对话的摘要（已压缩 ${uncompressedMiddle.length} 条消息）：\n\n${parts.join('\n')}`,
    compressed: true,
  };

  markAsCompressed(uncompressedMiddle);
  const alreadyCompressed = middle.filter((m) => m.compressed && m.role === 'system');

  const mergedSystemContent = [
    ...incompressibleSysMsgs.map((m) => m.content || ''),
    ...compressibleSysMsgs.map((m) => m.content || ''),
    ...alreadyCompressed.map((m) => m.content || ''),
  ]
    .filter(Boolean)
    .join('\n\n');

  const result: OllamaMessage[] = [{ role: 'system', content: mergedSystemContent }, ...head, summaryMsg, ...tail];
  reorderSystemMessagesForPrefixCaching(result);

  const beforeTokens = estimateTokens(messages.map((m) => m.content || '').join(''));
  const afterTokens = estimateTokens(result.map((m) => m.content || '').join(''));

  const metrics: CompressionMetrics = {
    beforeMessages: messages.length,
    afterMessages: result.length,
    beforeTokens,
    afterTokens,
    compressionRatio: beforeTokens > 0 ? afterTokens / beforeTokens : 1.0,
    timestamp: Date.now(),
  };
  recordCompressionMetrics(metrics);

  logSuccess(
    `上下文压缩完成: ${messages.length} 条 → ${result.length} 条, tokens: ${beforeTokens} → ${afterTokens} (压缩率: ${(metrics.compressionRatio * 100).toFixed(0)}%)`,
  );

  return result;
}
