/**
 * 会话摘要持久化（localStorage）与上下文注入。
 */

import type { OllamaMessage } from '../../types.js';
import { logInfo, logWarn } from '../log-service.js';

export interface SessionSummary {
  id: string;
  createdAt: number;
  goal: string;
  summary: string;
  toolsUsed: string[];
  keyFindings: string[];
  tokenUsage: number;
}

const SESSION_SUMMARY_KEY = 'metona_session_summaries';
const MAX_SESSION_SUMMARIES = 10;

export function saveSessionSummary(summary: SessionSummary): void {
  try {
    const existing = loadSessionSummaries();
    existing.unshift(summary);
    if (existing.length > MAX_SESSION_SUMMARIES) existing.length = MAX_SESSION_SUMMARIES;
    localStorage.setItem(SESSION_SUMMARY_KEY, JSON.stringify(existing));
    logInfo(`R123: 会话摘要已保存 (${summary.id})`);
  } catch (err) {
    logWarn(`R123: 保存会话摘要失败: ${(err as Error).message}`);
  }
}

export function loadSessionSummaries(): SessionSummary[] {
  try {
    const raw = localStorage.getItem(SESSION_SUMMARY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SessionSummary[];
  } catch {
    return [];
  }
}

export function getSessionSummariesBackup(): SessionSummary[] {
  return loadSessionSummaries();
}

export function restoreSessionSummariesBackup(summaries: SessionSummary[]): void {
  if (!Array.isArray(summaries)) return;
  try {
    localStorage.setItem(SESSION_SUMMARY_KEY, JSON.stringify(summaries.slice(0, MAX_SESSION_SUMMARIES)));
    logInfo(`R123: 从备份恢复 ${summaries.length} 条会话摘要`);
  } catch (err) {
    logWarn(`R123: 恢复会话摘要失败: ${(err as Error).message}`);
  }
}

export function generateSessionSummary(
  goal: string,
  messages: OllamaMessage[],
  toolRecords: Array<{ name: string }>,
  totalTokens: number,
): SessionSummary {
  const toolsUsed = [...new Set(toolRecords.map((t) => t.name))];
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const lastAssistant = assistantMessages[assistantMessages.length - 1];

  return {
    id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    goal: goal.slice(0, 200),
    summary: (lastAssistant?.content || '').slice(0, 500),
    toolsUsed,
    keyFindings: [],
    tokenUsage: totalTokens,
  };
}

export function formatSessionSummariesForContext(summaries: SessionSummary[]): string {
  if (summaries.length === 0) return '';
  const lines = ['[历史会话参考]', ''];
  for (const s of summaries.slice(0, 3)) {
    const date = new Date(s.createdAt).toLocaleDateString();
    lines.push(
      `- ${date}: 目标="${s.goal.slice(0, 60)}..." | 工具=[${s.toolsUsed.join(', ')}] | 结果=${s.summary.slice(0, 100)}...`,
    );
  }
  return lines.join('\n');
}
