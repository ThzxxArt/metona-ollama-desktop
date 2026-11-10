/**
 * 工具调用统计与热力图。
 */

import { TOOL_DEFINITIONS } from './catalog.js';
import { formatToolName, getToolIcon } from './format.js';

export interface ToolHeatmapData {
  toolName: string;
  displayName: string;
  icon: string;
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  heatLevel: number; // 0-4
  lastUsed: number;
  errorCount: number;
}

export interface ToolAnalytics {
  toolName: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  lastUsed: number;
  commonErrors: Map<string, number>;
}

const _toolAnalytics = new Map<string, ToolAnalytics>();

/** R25: 记录工具执行分析数据 */
export function recordToolAnalytics(toolName: string, success: boolean, durationMs: number, error?: string): void {
  let analytics = _toolAnalytics.get(toolName);
  if (!analytics) {
    analytics = {
      toolName,
      totalCalls: 0,
      successCount: 0,
      errorCount: 0,
      avgDurationMs: 0,
      lastUsed: 0,
      commonErrors: new Map(),
    };
    _toolAnalytics.set(toolName, analytics);
  }

  analytics.totalCalls++;
  if (success) analytics.successCount++;
  else {
    analytics.errorCount++;
    if (error) {
      const errorKey = error.slice(0, 100);
      analytics.commonErrors.set(errorKey, (analytics.commonErrors.get(errorKey) || 0) + 1);
    }
  }

  const alpha = 0.2;
  analytics.avgDurationMs =
    analytics.avgDurationMs === 0 ? durationMs : analytics.avgDurationMs * (1 - alpha) + durationMs * alpha;
  analytics.lastUsed = Date.now();
}

/** R25: 获取工具分析数据 */
export function getToolAnalytics(): Array<
  ToolAnalytics & { successRate: number; commonErrorsArray: Array<{ error: string; count: number }> }
> {
  return Array.from(_toolAnalytics.values()).map((a) => ({
    ...a,
    successRate: a.totalCalls > 0 ? a.successCount / a.totalCalls : 0,
    commonErrorsArray: Array.from(a.commonErrors.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    commonErrors: undefined as unknown as Map<string, number>,
  }));
}

/** R25: 重置工具分析数据 */
export function resetToolAnalytics(): void {
  _toolAnalytics.clear();
}

/** R30: 获取工具使用热力图数据 */
export function getToolHeatmap(): ToolHeatmapData[] {
  const analytics = getToolAnalytics();
  const maxCalls = Math.max(1, ...analytics.map((a) => a.totalCalls));

  const allTools = new Map<string, ToolHeatmapData>();
  for (const def of TOOL_DEFINITIONS) {
    const name = def.function.name;
    allTools.set(name, {
      toolName: name,
      displayName: formatToolName(name),
      icon: getToolIcon(name),
      totalCalls: 0,
      successRate: 0,
      avgDurationMs: 0,
      heatLevel: 0,
      lastUsed: 0,
      errorCount: 0,
    });
  }

  for (const a of analytics) {
    const entry = allTools.get(a.toolName);
    if (entry) {
      entry.totalCalls = a.totalCalls;
      entry.successRate = a.successRate;
      entry.avgDurationMs = a.avgDurationMs;
      entry.lastUsed = a.lastUsed;
      entry.errorCount = a.errorCount;
    } else {
      allTools.set(a.toolName, {
        toolName: a.toolName,
        displayName: a.toolName,
        icon: '🔧',
        totalCalls: a.totalCalls,
        successRate: a.successRate,
        avgDurationMs: a.avgDurationMs,
        heatLevel: 0,
        lastUsed: a.lastUsed,
        errorCount: a.errorCount,
      });
    }
  }

  const result = Array.from(allTools.values());
  for (const entry of result) {
    if (entry.totalCalls === 0) entry.heatLevel = 0;
    else {
      const ratio = entry.totalCalls / maxCalls;
      if (ratio > 0.75) entry.heatLevel = 4;
      else if (ratio > 0.5) entry.heatLevel = 3;
      else if (ratio > 0.25) entry.heatLevel = 2;
      else entry.heatLevel = 1;
    }
  }

  result.sort((a, b) => b.totalCalls - a.totalCalls);
  return result;
}
