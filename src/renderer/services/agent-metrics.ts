/**
 * Agent Metrics — 治理与度量模块
 * Harness Engineering: 度量驱动的优化循环
 *
 * 功能：
 * - 会话级度量采集（迭代效率、工具成功率、完成质量）
 * - 全局趋势聚合
 * - 错误模式识别（转向循环）
 * - 度量仪表盘数据源
 */

import { logInfo, logDebug } from './log-service.js';
import type { AgentMetrics, LoopContext } from '../types.js';

// ═══════════════════════════════════════════════════════════════
// 应用版本号（由 main.ts 初始化时注入，避免硬编码）
// ═══════════════════════════════════════════════════════════════

let _appVersion = 'unknown';

/** 初始化应用版本号（应在 app 启动时调用） */
export function setAppVersion(version: string): void {
  _appVersion = version;
}

// ═══════════════════════════════════════════════════════════════
// 度量采集
// ═══════════════════════════════════════════════════════════════

/** 当前会话的度量快照 */
interface SessionMetrics {
  sessionId: string;
  model: string;
  startTime: number;
  endTime: number;
  totalIterations: number;
  toolCalls: Array<{ name: string; status: string; duration?: number }>;
  totalInputTokens: number;
  totalOutputTokens: number;
  errorPatterns: string[];
}

let currentMetrics: SessionMetrics | null = null;
const sessionMetricsHistory: SessionMetrics[] = [];

/** 开始采集会话度量 */
export function startSessionMetrics(sessionId: string, model: string): void {
  currentMetrics = {
    sessionId,
    model,
    startTime: Date.now(),
    endTime: 0,
    totalIterations: 0,
    toolCalls: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    errorPatterns: [],
  };
  logDebug(`Agent Metrics: 开始采集会话 ${sessionId}`);
}

/** 记录一轮迭代 */
export function recordIteration(ctx: LoopContext): void {
  if (!currentMetrics) return;
  currentMetrics.totalIterations = ctx.loopCount;
  currentMetrics.totalInputTokens = ctx.totalPromptEvalCount;
  currentMetrics.totalOutputTokens = ctx.totalEvalCount;
}

/** 记录工具调用 */
export function recordToolCall(name: string, status: string, durationMs?: number): void {
  if (!currentMetrics) return;
  currentMetrics.toolCalls.push({ name, status, duration: durationMs });
  if (status === 'error') {
    // 错误模式：记录工具名和失败状态
    const pattern = `${name}:error`;
    if (!currentMetrics.errorPatterns.includes(pattern)) {
      currentMetrics.errorPatterns.push(pattern);
    }
  }
}

/** 结束会话度量 */
export function endSessionMetrics(): SessionMetrics | null {
  if (!currentMetrics) return null;
  currentMetrics.endTime = Date.now();
  sessionMetricsHistory.push({ ...currentMetrics });
  const metrics = { ...currentMetrics };
  logInfo(
    `Agent Metrics: 会话完成 — ` +
    `${metrics.totalIterations} 轮, ` +
    `${metrics.toolCalls.length} 工具调用, ` +
    `${formatPercent(getToolSuccessRate(metrics))} 成功率`
  );
  currentMetrics = null;
  // R84: 持久化度量历史到 localStorage
  persistMetricsHistory();
  return metrics;
}

// ═══════════════════════════════════════════════════════════════
// R84: 度量持久化 — localStorage 存储与恢复
// ═══════════════════════════════════════════════════════════════

const METRICS_STORAGE_KEY = '_metona_agent_metrics';
const METRICS_HISTORY_MAX = 100;

/** R84: 将度量历史保存到 localStorage */
function persistMetricsHistory(): void {
  try {
    const recent = sessionMetricsHistory.slice(-METRICS_HISTORY_MAX);
    const serialized = recent.map(m => ({
      sessionId: m.sessionId,
      model: m.model,
      duration: m.endTime - m.startTime,
      iterations: m.totalIterations,
      toolCallCount: m.toolCalls.length,
      toolSuccessRate: getToolSuccessRate(m),
      errorPatterns: m.errorPatterns,
      inputTokens: m.totalInputTokens,
      outputTokens: m.totalOutputTokens,
      timestamp: m.endTime,
    }));
    localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // localStorage 满或不可用时静默忽略
  }
}

/** R84: 从 localStorage 恢复度量历史 */
export function loadMetricsHistory(): void {
  try {
    const raw = localStorage.getItem(METRICS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Array<Record<string, any>>;
    for (const item of parsed) {
      sessionMetricsHistory.push({
        sessionId: item.sessionId || 'unknown',
        model: item.model || 'unknown',
        startTime: item.timestamp ? item.timestamp - (item.duration || 0) : 0,
        endTime: item.timestamp || 0,
        totalIterations: item.iterations || 0,
        toolCalls: [],
        totalInputTokens: item.inputTokens || 0,
        totalOutputTokens: item.outputTokens || 0,
        errorPatterns: item.errorPatterns || [],
      });
    }
    logInfo(`R84: 恢复了 ${sessionMetricsHistory.length} 条历史度量`);
  } catch {
    // 解析失败静默忽略
  }
}

/** R84: 获取度量历史（供 UI 仪表盘使用） */
export function getMetricsHistory(): SessionMetrics[] {
  return [...sessionMetricsHistory];
}

// ═══════════════════════════════════════════════════════════════
// 度量计算
// ═══════════════════════════════════════════════════════════════

/** 计算工具成功率 */
function getToolSuccessRate(m: SessionMetrics): number {
  if (m.toolCalls.length === 0) return 1;
  const successCount = m.toolCalls.filter(t => t.status === 'success').length;
  return successCount / m.toolCalls.length;
}

/** 格式化百分比 */
function formatPercent(ratio: number): string {
  return (ratio * 100).toFixed(1) + '%';
}


/** 聚合全局度量 */
export function aggregateMetrics(): AgentMetrics {
  const history = sessionMetricsHistory;
  if (history.length === 0) {
    return {
      totalSessions: 0,
      avgIterationsPerTask: 0,
      toolSuccessRate: 0,
      frequentErrors: [],
      tokenEfficiency: 0,
      collectedAt: Date.now(),
    };
  }

  const totalIterations = history.reduce((s, m) => s + m.totalIterations, 0);
  const allToolCalls = history.flatMap(m => m.toolCalls);
  const successCalls = allToolCalls.filter(t => t.status === 'success').length;
  const totalInputTokens = history.reduce((s, m) => s + m.totalInputTokens, 0);
  const totalOutputTokens = history.reduce((s, m) => s + m.totalOutputTokens, 0);

  // 聚合错误模式
  const errorCounts = new Map<string, number>();
  for (const m of history) {
    for (const pattern of m.errorPatterns) {
      errorCounts.set(pattern, (errorCounts.get(pattern) || 0) + 1);
    }
  }
  const frequentErrors = Array.from(errorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, count]) => ({ pattern, count }));

  return {
    totalSessions: history.length,
    avgIterationsPerTask: Math.round(totalIterations / history.length),
    toolSuccessRate: allToolCalls.length > 0 ? successCalls / allToolCalls.length : 0,
    frequentErrors,
    tokenEfficiency: totalInputTokens > 0 ? totalOutputTokens / totalInputTokens : 0,
    collectedAt: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════════
// 转向循环：错误模式 → 改进建议
// ═══════════════════════════════════════════════════════════════

export interface ImprovementSuggestion {
  pattern: string;
  frequency: number;
  suggestion: string;
  severity: 'high' | 'medium' | 'low';
}

/**
 * 分析错误模式，生成改进建议
 * 实现"让错误只犯一次"的核心理念
 */
export function generateImprovementSuggestions(): ImprovementSuggestion[] {
  const metrics = aggregateMetrics();
  const suggestions: ImprovementSuggestion[] = [];

  for (const err of metrics.frequentErrors) {
    const [tool, status] = err.pattern.split(':');

    // 特定工具的重复失败
    if (status === 'error') {
      if (tool === 'web_fetch' && err.count >= 3) {
        suggestions.push({
          pattern: err.pattern,
          frequency: err.count,
          suggestion: `web_fetch 频繁失败 (${err.count}次)。考虑在 AGENT.md 中添加规则：优先使用 browser_open + browser_extract 作为替代方案。`,
          severity: 'high',
        });
      } else if (tool === 'web_search' && err.count >= 3) {
        suggestions.push({
          pattern: err.pattern,
          frequency: err.count,
          suggestion: `web_search 频繁失败 (${err.count}次)。检查 SearXNG 配置或网络连接。可在 AGENT.md 中添加备用搜索策略。`,
          severity: 'high',
        });
      } else if (err.count >= 5) {
        suggestions.push({
          pattern: err.pattern,
          frequency: err.count,
          suggestion: `工具 ${tool} 反复失败 ${err.count} 次。建议审查该工具的参数构造逻辑，或在 AGENT.md 中添加错误处理指南。`,
          severity: 'medium',
        });
      }
    }
  }

  // Token 效率过低
  if (metrics.tokenEfficiency < 0.1 && metrics.totalSessions > 3) {
    suggestions.push({
      pattern: 'low_token_efficiency',
      frequency: metrics.totalSessions,
      suggestion: `Token 效率过低 (${formatPercent(metrics.tokenEfficiency)})。Agent 可能过度调用工具。建议在 AGENT.md 中添加：简单常识问题直接回答，不要调用工具。`,
      severity: 'medium',
    });
  }

  // 迭代次数过高
  if (metrics.avgIterationsPerTask > 50) {
    suggestions.push({
      pattern: 'high_iterations',
      frequency: metrics.totalSessions,
      suggestion: `平均迭代次数过高 (${metrics.avgIterationsPerTask} 轮)。建议降低 maxTurns 设置或在 AGENT.md 中添加提前终止条件。`,
      severity: 'medium',
    });
  }

  return suggestions;
}

/**
 * 将改进建议格式化为 AGENT.md 补充规则
 */
export function formatSuggestionsAsRules(suggestions: ImprovementSuggestion[]): string {
  if (suggestions.length === 0) return '';

  let rules = '\n\n## 自动生成的改进规则\n';
  rules += '> 以下规则由 Agent Metrics 系统根据历史错误模式自动生成\n\n';

  for (const s of suggestions) {
    rules += `### ${s.pattern}\n`;
    rules += `- **严重程度**: ${s.severity}\n`;
    rules += `- **出现频率**: ${s.frequency} 次\n`;
    rules += `- **建议**: ${s.suggestion}\n\n`;
  }

  return rules;
}

// ═══════════════════════════════════════════════════════════════
// 格式化输出（供仪表盘使用）
// ═══════════════════════════════════════════════════════════════

export function formatMetricsReport(metrics: AgentMetrics): string {
  return [
    `Agent Metrics 报告 (${new Date(metrics.collectedAt).toLocaleString()})`,
    `${'─'.repeat(50)}`,
    `总会话数:         ${metrics.totalSessions}`,
    `平均迭代/任务:    ${metrics.avgIterationsPerTask}`,
    `工具成功率:       ${formatPercent(metrics.toolSuccessRate)}`,
    `Token 效率:       ${formatPercent(metrics.tokenEfficiency)}`,
    `高频错误:         ${metrics.frequentErrors.length > 0 ? metrics.frequentErrors.map(e => `${e.pattern}(${e.count}次)`).join(', ') : '无'}`,
  ].join('\n');
}

/** P3-14: 导出结构化指标（JSON 格式，兼容 Prometheus/OpenTelemetry 采集器） */
export function exportMetricsJSON(): string {
  const metrics = aggregateMetrics();
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    application: 'metona-ollama-desktop',
    version: _appVersion,
    metrics: {
      sessions_total: metrics.totalSessions,
      avg_iterations_per_task: metrics.avgIterationsPerTask,
      tool_success_rate: parseFloat(metrics.toolSuccessRate.toFixed(4)),
      token_efficiency: parseFloat(metrics.tokenEfficiency.toFixed(4)),
      top_errors: metrics.frequentErrors.slice(0, 5),
      improvement_suggestions: generateImprovementSuggestions().slice(0, 3).map(s => ({
        pattern: s.pattern,
        severity: s.severity,
        suggestion: s.suggestion,
      })),
    },
    collected_at: metrics.collectedAt,
  }, null, 2);
}

/** P3-14: 导出 Prometheus 文本格式（用于 /metrics 端点） */
export function exportMetricsPrometheus(): string {
  const metrics = aggregateMetrics();
  const lines: string[] = [];
  lines.push('# HELP metona_sessions_total Total number of sessions');
  lines.push('# TYPE metona_sessions_total gauge');
  lines.push(`metona_sessions_total ${metrics.totalSessions}`);
  lines.push('# HELP metona_avg_iterations Average iterations per task');
  lines.push('# TYPE metona_avg_iterations gauge');
  lines.push(`metona_avg_iterations ${metrics.avgIterationsPerTask}`);
  lines.push('# HELP metona_tool_success_rate Tool call success rate (0-1)');
  lines.push('# TYPE metona_tool_success_rate gauge');
  lines.push(`metona_tool_success_rate ${metrics.toolSuccessRate.toFixed(4)}`);
  lines.push('# HELP metona_token_efficiency Token output/input efficiency ratio');
  lines.push('# TYPE metona_token_efficiency gauge');
  lines.push(`metona_token_efficiency ${metrics.tokenEfficiency.toFixed(4)}`);
  for (const err of metrics.frequentErrors.slice(0, 5)) {
    const safeName = err.pattern.replace(/[^a-zA-Z0-9_]/g, '_');
    lines.push(`# HELP metona_error_${safeName} Frequency of error pattern`);
    lines.push(`# TYPE metona_error_${safeName} counter`);
    lines.push(`metona_error_${safeName} ${err.count}`);
  }
  return lines.join('\n') + '\n';
}
