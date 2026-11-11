/**
 * 上下文构建：滑动窗口、快速摘要、system 分区、token 裁剪。
 */

import type { OllamaMessage } from '../../types.js';
import { logInfo } from '../log-service.js';
import { estimateTokens, getAdaptiveCompressThreshold } from './tokenizer.js';
import type { ContextBuildOptions, StructuredSummary } from './types.js';

const COMPRESS_KEEP_HEAD = 5;
const COMPRESS_KEEP_TAIL = 8;

export function scoreMessageImportance(msg: OllamaMessage): number {
  let score = 5;
  const content = msg.content || '';

  if (
    content.includes('[SOUL.md]') ||
    content.includes('[AGENTS.md]') ||
    content.includes('[USER.md]') ||
    content.includes('[相关记忆]') ||
    content.includes('[历史会话摘要]')
  ) {
    return 10;
  }
  if (content.startsWith('[日期]')) return 10;
  if (content.startsWith('[环境]')) return 10;
  if (content.includes('安全规则')) return 10;

  if (msg.role === 'user') score += 2;
  if (msg.role === 'system') score -= 2;
  if (msg.ephemeral) return 0;
  if (msg.compressed) score = 4;

  const highValuePatterns = [
    /路径|目录|path|file|config|配置|命令|command|exec/i,
    /错误|error|失败|fail|bug|fix|修复|解决/i,
    /版本|version|API|http|url|端口|port|localhost/i,
    /记住|保存|memory|偏好|规则|rule/i,
    /完成|done|✓|success|成功|结果|result/i,
    /项目|project|工作空间|workspace|git|repo|仓库/i,
  ];
  for (const p of highValuePatterns) {
    if (p.test(content)) {
      score += 1;
      break;
    }
  }

  if (msg.tool_calls?.length) score += 2;

  if (msg.role === 'tool' && msg.tool_name) {
    if (/write_file|edit_file|delete_file|file_transfer/.test(msg.tool_name)) score += 2;
    if (/search_files|web_search/.test(msg.tool_name)) score += 1;
    if (/read_file|list_directory|tree/.test(msg.tool_name)) score += 1;
  }

  if (content.length > 500) score += 1;
  if (content.length > 2000) score += 1;
  if (msg.images?.length) score -= 1;

  return Math.max(1, Math.min(10, score));
}

function extractStructuredSummary(compressedMsgs: OllamaMessage[]): StructuredSummary {
  const summary: StructuredSummary = {
    topics: [],
    decisions: [],
    pendingTasks: [],
    constraints: [],
    knowledge: [],
    toolResults: [],
  };
  for (const msg of compressedMsgs) {
    const content = msg.content || '';
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

function mergeSummaries(old_: StructuredSummary, new_: StructuredSummary): StructuredSummary {
  const mergeArrays = (oldArr: string[], newArr: string[], max: number): string[] =>
    [...new Set([...newArr, ...oldArr])].slice(0, max);
  return {
    topics: mergeArrays(old_.topics, new_.topics, 4),
    decisions: mergeArrays(old_.decisions, new_.decisions, 3),
    pendingTasks: mergeArrays(old_.pendingTasks, new_.pendingTasks, 3),
    constraints: mergeArrays(old_.constraints, new_.constraints, 3),
    knowledge: mergeArrays(old_.knowledge, new_.knowledge, 3),
    toolResults: mergeArrays(old_.toolResults, new_.toolResults, 3),
  };
}

function isStableSystemMessage(content: string): boolean {
  return (
    content.includes('[SOUL.md]') ||
    content.includes('[AGENTS.md]') ||
    content.includes('[USER.md]') ||
    content.startsWith('[日期]') ||
    content.startsWith('[环境]') ||
    content.includes('安全规则') ||
    content.includes('系统提示') ||
    content.includes('You are')
  );
}

function reorderSystemMessagesForPrefixCaching(messages: OllamaMessage[]): void {
  const systemIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') systemIndices.push(i);
  }
  if (systemIndices.length <= 1) return;

  const stableContents: string[] = [];
  const dynamicContents: string[] = [];
  for (const idx of systemIndices) {
    const content = messages[idx].content || '';
    if (isStableSystemMessage(content)) stableContents.push(content);
    else dynamicContents.push(content);
  }

  if (stableContents.length === 0 || dynamicContents.length === 0) return;

  const stableContent = stableContents.join('\n\n');
  const dynamicContent = dynamicContents.join('\n\n');
  const firstSysIdx = systemIndices[0];
  messages[firstSysIdx].content = stableContent;

  const lastSysIdx = systemIndices[systemIndices.length - 1];
  if (firstSysIdx !== lastSysIdx) {
    messages[lastSysIdx].content = dynamicContent;
    const middleSysIndices = systemIndices.slice(1, -1);
    for (let i = middleSysIndices.length - 1; i >= 0; i--) {
      messages.splice(middleSysIndices[i], 1);
    }
  } else {
    messages[firstSysIdx].content = stableContent + '\n\n' + dynamicContent;
  }

  logInfo(
    `R17: System 消息分区完成 — 稳定前缀 ${estimateTokens(stableContent)} tokens, 动态部分 ${estimateTokens(dynamicContent)} tokens`,
  );
}

const DEFAULT_OPTIONS: Required<ContextBuildOptions> = {
  windowSize: 40,
  summaryBatchSize: 30,
  maxTokens: 131072,
  memoryContext: '',
  workspaceContext: '',
};

export function buildContext(allMessages: OllamaMessage[], options: ContextBuildOptions = {}): OllamaMessage[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const result: OllamaMessage[] = [];

  const existingSystem = allMessages.filter((m) => m.role === 'system');
  const stableParts: string[] = [];
  const dynamicParts: string[] = [];

  for (const sys of existingSystem) {
    if (isStableSystemMessage(sys.content || '')) stableParts.push(sys.content || '');
    else dynamicParts.push(sys.content || '');
  }
  if (opts.memoryContext) dynamicParts.push(opts.memoryContext);
  if (opts.workspaceContext) dynamicParts.push(opts.workspaceContext);

  let systemContent = '';
  if (stableParts.length > 0) systemContent += stableParts.join('\n\n') + '\n\n';
  if (dynamicParts.length > 0) systemContent += dynamicParts.join('\n\n') + '\n\n';

  if (systemContent.trim()) result.push({ role: 'system', content: systemContent.trim() });

  const nonSystemMessages = allMessages.filter((m) => m.role !== 'system');
  if (nonSystemMessages.length <= opts.windowSize) {
    result.push(...nonSystemMessages);
    return result;
  }

  const recentMessages = nonSystemMessages.slice(-opts.windowSize);
  const olderMessages = nonSystemMessages.slice(0, -opts.windowSize);
  const compressedMsgs = olderMessages.filter((m) => m.compressed);
  const uncompressedMsgs = olderMessages.filter((m) => !m.compressed);

  result.push(...compressedMsgs);
  if (uncompressedMsgs.length > 0) {
    result.push(...summarizeOlderMessages(uncompressedMsgs, opts.summaryBatchSize));
  }
  result.push(...recentMessages);

  const trimmed = trimByTokenLimit(result, opts.maxTokens);
  logInfo(
    `上下文构建: ${nonSystemMessages.length} 条消息 → ${trimmed.length} 条 (窗口: ${opts.windowSize})`,
    `估算 tokens: ${estimateTokens(trimmed.map((m) => m.content).join(''))}`,
  );
  return trimmed;
}

export function shouldAutoCompress(messages: OllamaMessage[], numCtx: number): boolean {
  let totalTokens = 0;
  for (const m of messages) {
    totalTokens += estimateTokens(m.content || '');
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        const argsSize = JSON.stringify(tc.function.arguments || {}).length;
        totalTokens += estimateTokens(tc.function.name) + Math.ceil(argsSize / 4) + 20;
      }
    }
    if (m.images?.length) totalTokens += m.images.length * 100;
  }
  return totalTokens > numCtx * getAdaptiveCompressThreshold(numCtx);
}

function summarizeOlderMessages(messages: OllamaMessage[], batchSize: number): OllamaMessage[] {
  const summaries: OllamaMessage[] = [];
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    summaries.push({
      role: 'user',
      content: `【更早的对话摘要（第 ${Math.floor(i / batchSize) + 1} 部分）】\n${createQuickSummary(batch)}`,
      compressed: true,
    });
  }
  return summaries;
}

function createQuickSummary(messages: OllamaMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'user' ? '用户' : 'AI';
    const content = msg.content || '';
    const importance = scoreMessageImportance(msg);

    let preview: string;
    if (importance >= 8) preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
    else if (importance >= 5) preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    else {
      if (content.trim().length < 10) continue;
      preview = content.length > 40 ? content.slice(0, 40) + '...' : content;
    }

    if (preview.trim()) parts.push(`${role}: ${preview}`);
    if (msg.tool_calls?.length) {
      parts.push(`  [工具: ${msg.tool_calls.map((t) => t.function.name).join(', ')}]`);
    }
  }
  return parts.join('\n');
}

function trimByTokenLimit(messages: OllamaMessage[], maxTokens: number): OllamaMessage[] {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
  if (nonSystemMsgs.length <= 4) return messages;

  const PROTECT_RECENT = 6;
  const recentMsgs = nonSystemMsgs.slice(-PROTECT_RECENT);
  const olderMsgs = nonSystemMsgs.slice(0, -PROTECT_RECENT);

  interface MsgGroup {
    msgs: OllamaMessage[];
    tokens: number;
    importance: number;
    originalIndex: number;
  }

  const groups: MsgGroup[] = [];
  let i = 0;
  while (i < olderMsgs.length) {
    const msg = olderMsgs[i];
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const groupMsgs: OllamaMessage[] = [msg];
      let tokens =
        estimateTokens(msg.content || '') +
        (msg.images ? msg.images.length * 100 : 0) +
        (msg.tool_calls ? msg.tool_calls.length * 50 : 0);
      let maxImportance = scoreMessageImportance(msg);
      let j = i + 1;
      while (j < olderMsgs.length && olderMsgs[j].role === 'tool') {
        const toolMsg = olderMsgs[j];
        groupMsgs.push(toolMsg);
        tokens += estimateTokens(toolMsg.content || '');
        maxImportance = Math.max(maxImportance, scoreMessageImportance(toolMsg));
        j++;
      }
      groups.push({ msgs: groupMsgs, tokens, importance: maxImportance, originalIndex: i });
      i = j;
    } else {
      const tokens =
        estimateTokens(msg.content || '') +
        (msg.images ? msg.images.length * 100 : 0) +
        (msg.tool_calls ? msg.tool_calls.length * 50 : 0);
      groups.push({ msgs: [msg], tokens, importance: scoreMessageImportance(msg), originalIndex: i });
      i++;
    }
  }

  const systemTokens = systemMsgs.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
  const recentTokens = recentMsgs.reduce(
    (sum, m) =>
      sum +
      estimateTokens(m.content || '') +
      (m.images ? m.images.length * 100 : 0) +
      (m.tool_calls ? m.tool_calls.length * 50 : 0),
    0,
  );
  const availableTokens = maxTokens - systemTokens - recentTokens;
  if (availableTokens <= 0) return [...systemMsgs, ...recentMsgs];

  const totalGroups = groups.length;
  groups.forEach((g, idx) => {
    const recencyRatio = totalGroups > 1 ? idx / (totalGroups - 1) : 1;
    g.importance += Math.round(recencyRatio * 2);
  });
  const sortedGroups = [...groups].sort((a, b) => b.importance - a.importance);

  let usedTokens = 0;
  const keptOriginalIndices = new Set<number>();
  for (const group of sortedGroups) {
    if (usedTokens + group.tokens > availableTokens && keptOriginalIndices.size >= 2) break;
    usedTokens += group.tokens;
    keptOriginalIndices.add(group.originalIndex);
  }

  const result: OllamaMessage[] = [...systemMsgs];
  for (const g of groups) {
    if (keptOriginalIndices.has(g.originalIndex)) result.push(...g.msgs);
  }
  result.push(...recentMsgs);
  return result;
}

export { extractStructuredSummary, mergeSummaries, isStableSystemMessage, reorderSystemMessagesForPrefixCaching };
