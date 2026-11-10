/**
 * 上下文压力、Token 预算、趋势压缩决策与 Token 报告。
 */

import type { OllamaMessage } from '../../types.js';
import { logInfo } from '../log-service.js';
import {
  estimateTokens,
  getAdaptiveCompressThreshold,
  predictContextOverflow,
  getCompressionHistory,
  getAverageCompressionRatio,
  type ContextWarningLevel,
} from './tokenizer.js';

export type ContextPressureLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ContextPressureInfo {
  level: ContextPressureLevel;
  tokenUsageRatio: number;
  messageCount: number;
  recommendedActions: string[];
}

export interface ContextStats {
  totalTokens: number;
  contentTokens: number;
  usageRatio: number;
  messageCount: number;
  pressureInfo: ContextPressureInfo;
  compressDecision: { shouldCompress: boolean; reason: string; urgency: 'low' | 'medium' | 'high' };
}

function calculateTotalTokens(messages: OllamaMessage[]): number {
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
  return totalTokens;
}

export function calculateContextStats(messages: OllamaMessage[], numCtx: number): ContextStats {
  const totalTokens = calculateTotalTokens(messages);
  let contentTokens = 0;
  for (const m of messages) contentTokens += estimateTokens(m.content || '');

  const usageRatio = numCtx > 0 ? totalTokens / numCtx : 0;
  const msgCount = messages.length;

  let level: ContextPressureLevel;
  const actions: string[] = [];
  if (usageRatio > 0.7) {
    level = 'critical';
    actions.push('llm_compress', 'truncate_results', 'compact_old', 'merge_messages', 'clear_ephemeral');
  } else if (usageRatio > 0.5) {
    level = 'high';
    actions.push('truncate_results', 'compact_old', 'merge_messages');
  } else if (usageRatio > 0.3) {
    level = 'medium';
    actions.push('compact_old', 'clear_ephemeral');
  } else {
    level = 'low';
    if (msgCount > 60) actions.push('compact_old');
  }
  const pressureInfo: ContextPressureInfo = {
    level,
    tokenUsageRatio: usageRatio,
    messageCount: msgCount,
    recommendedActions: actions,
  };

  const baseThreshold = getAdaptiveCompressThreshold(numCtx);
  const prediction = predictContextOverflow(numCtx);
  let shouldCompress = false;
  let reason = '';
  let urgency: 'low' | 'medium' | 'high' = 'low';

  if (prediction.level === 'critical' || (prediction.level === 'warning' && prediction.turnsToOverflow <= 2)) {
    shouldCompress = true;
    reason = `趋势预测触发: ${prediction.message}`;
    urgency = 'high';
  } else if (
    prediction.turnsToOverflow > 0 &&
    prediction.turnsToOverflow <= 5 &&
    usageRatio > baseThreshold * 0.8
  ) {
    shouldCompress = true;
    reason = `趋势加速: ${prediction.turnsToOverflow} 轮后可能溢出，当前使用率 ${(usageRatio * 100).toFixed(0)}%`;
    urgency = 'medium';
  } else if (usageRatio > baseThreshold) {
    shouldCompress = true;
    reason = `标准阈值触发: 使用率 ${(usageRatio * 100).toFixed(0)}% > 阈值 ${(baseThreshold * 100).toFixed(0)}%`;
    urgency = usageRatio > 0.6 ? 'high' : 'medium';
  } else {
    const msgThreshold = getIncrementalCompressThresholdMessages(numCtx);
    if (msgCount >= msgThreshold) {
      shouldCompress = true;
      reason = `消息条数触发: ${msgCount} >= ${msgThreshold}`;
      urgency = 'low';
    }
  }

  return {
    totalTokens,
    contentTokens,
    usageRatio,
    messageCount: msgCount,
    pressureInfo,
    compressDecision: { shouldCompress, reason, urgency },
  };
}

export function getContextPressureLevel(messages: OllamaMessage[], numCtx: number): ContextPressureInfo {
  return calculateContextStats(messages, numCtx).pressureInfo;
}

interface TokenBudgetEntry {
  loop: number;
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: number;
  timestamp: number;
}

const _tokenBudgetHistory: TokenBudgetEntry[] = [];
const MAX_BUDGET_ENTRIES = 50;
let _totalInputTokens = 0;
let _totalOutputTokens = 0;
let _budgetNumCtx = 131072;

export function setTokenBudgetNumCtx(numCtx: number): void {
  _budgetNumCtx = numCtx;
}

export function recordBudgetUsage(
  loop: number,
  inputTokens: number,
  outputTokens: number,
  estimatedTokens: number,
): void {
  _tokenBudgetHistory.push({ loop, inputTokens, outputTokens, estimatedTokens, timestamp: Date.now() });
  if (_tokenBudgetHistory.length > MAX_BUDGET_ENTRIES) _tokenBudgetHistory.shift();
  _totalInputTokens += inputTokens;
  _totalOutputTokens += outputTokens;
}

export interface TokenBudgetStatus {
  totalInput: number;
  totalOutput: number;
  totalSpent: number;
  avgInputPerLoop: number;
  avgOutputPerLoop: number;
  budgetNumCtx: number;
  currentLoopInput: number;
  budgetUtilization: number;
  trend: 'increasing' | 'stable' | 'decreasing';
  history: TokenBudgetEntry[];
}

export function getTokenBudgetStatus(): TokenBudgetStatus {
  const history = [..._tokenBudgetHistory];
  const currentLoop = history.length > 0 ? history[history.length - 1] : null;

  let trend: 'increasing' | 'stable' | 'decreasing' = 'stable';
  if (history.length >= 3) {
    const recent = history.slice(-3);
    const avg = recent.reduce((s, e) => s + e.inputTokens, 0) / recent.length;
    const oldest = recent[0].inputTokens;
    if (avg > oldest * 1.15) trend = 'increasing';
    else if (avg < oldest * 0.85) trend = 'decreasing';
  }

  return {
    totalInput: _totalInputTokens,
    totalOutput: _totalOutputTokens,
    totalSpent: _totalInputTokens + _totalOutputTokens,
    avgInputPerLoop: history.length > 0 ? Math.round(_totalInputTokens / history.length) : 0,
    avgOutputPerLoop: history.length > 0 ? Math.round(_totalOutputTokens / history.length) : 0,
    budgetNumCtx: _budgetNumCtx,
    currentLoopInput: currentLoop?.inputTokens || 0,
    budgetUtilization: _budgetNumCtx > 0 && currentLoop ? currentLoop.inputTokens / _budgetNumCtx : 0,
    trend,
    history,
  };
}

export function resetTokenBudget(): void {
  _tokenBudgetHistory.length = 0;
  _totalInputTokens = 0;
  _totalOutputTokens = 0;
}

export function mergeConsecutiveMessages(messages: OllamaMessage[]): OllamaMessage[] {
  if (messages.length <= 2) return messages;

  const result: OllamaMessage[] = [];
  let mergedCount = 0;

  for (const msg of messages) {
    const last = result[result.length - 1];
    if (
      !last ||
      msg.role === 'tool' ||
      msg.role === 'system' ||
      msg.ephemeral ||
      msg.compressed ||
      last.role !== msg.role ||
      last.ephemeral ||
      last.compressed ||
      msg.tool_calls?.length ||
      last.tool_calls?.length
    ) {
      result.push(msg);
      continue;
    }

    const combinedContent = (last.content || '') + '\n\n' + (msg.content || '');
    if (combinedContent.length > 3000) {
      result.push(msg);
      continue;
    }

    result[result.length - 1] = { ...last, content: combinedContent };
    mergedCount++;
  }

  if (mergedCount > 0) {
    logInfo(
      `R96: 消息角色压缩 — 合并了 ${mergedCount} 条连续同角色消息 (${messages.length} → ${result.length})`,
    );
  }

  return result;
}

export function getTrendAwareCompressThreshold(
  numCtx: number,
  messages: OllamaMessage[],
): { shouldCompress: boolean; reason: string; urgency: 'low' | 'medium' | 'high' } {
  return calculateContextStats(messages, numCtx).compressDecision;
}

function getIncrementalCompressThresholdMessages(numCtx: number): number {
  const tokenThreshold = Math.floor(numCtx * 0.3);
  return Math.max(20, Math.min(120, Math.floor(tokenThreshold / 100)));
}

export interface TokenReport {
  generatedAt: number;
  session: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    loopCount: number;
    avgInputPerLoop: number;
    avgOutputPerLoop: number;
  };
  budget: {
    numCtx: number;
    currentUtilization: number;
    peakUtilization: number;
    trend: 'increasing' | 'stable' | 'decreasing';
  };
  compression: {
    historyCount: number;
    avgCompressionRatio: number;
    lastCompressionRatio: number | null;
  };
  warnings: string[];
}

export function generateTokenReport(numCtx: number): TokenReport {
  const budget = getTokenBudgetStatus();
  const compressionHistory = getCompressionHistory();

  let peakUtilization = 0;
  for (const entry of budget.history) {
    const util = numCtx > 0 ? entry.inputTokens / numCtx : 0;
    if (util > peakUtilization) peakUtilization = util;
  }

  const warnings: string[] = [];
  if (budget.budgetUtilization > 0.7) {
    warnings.push(`当前轮 token 使用率过高: ${(budget.budgetUtilization * 100).toFixed(0)}%`);
  }
  if (budget.trend === 'increasing' && budget.avgInputPerLoop > numCtx * 0.3) {
    warnings.push(`token 消耗趋势上升，平均每轮 ${budget.avgInputPerLoop} tokens`);
  }
  if (compressionHistory.length > 0) {
    const avgRatio = getAverageCompressionRatio();
    if (avgRatio > 0.8) warnings.push(`压缩效率偏低: 平均压缩率 ${(avgRatio * 100).toFixed(0)}% (越低越好)`);
  }

  return {
    generatedAt: Date.now(),
    session: {
      totalInputTokens: budget.totalInput,
      totalOutputTokens: budget.totalOutput,
      totalTokens: budget.totalSpent,
      loopCount: budget.history.length,
      avgInputPerLoop: budget.avgInputPerLoop,
      avgOutputPerLoop: budget.avgOutputPerLoop,
    },
    budget: { numCtx, currentUtilization: budget.budgetUtilization, peakUtilization, trend: budget.trend },
    compression: {
      historyCount: compressionHistory.length,
      avgCompressionRatio: getAverageCompressionRatio(),
      lastCompressionRatio:
        compressionHistory.length > 0 ? compressionHistory[compressionHistory.length - 1].compressionRatio : null,
    },
    warnings,
  };
}

export function formatTokenReport(report: TokenReport): string {
  const lines: string[] = [
    `Token Usage Report (${new Date(report.generatedAt).toLocaleTimeString()})`,
    `${'─'.repeat(50)}`,
    `Session:`,
    `  Total Input:  ${report.session.totalInputTokens.toLocaleString()} tokens`,
    `  Total Output: ${report.session.totalOutputTokens.toLocaleString()} tokens`,
    `  Total Spent:  ${report.session.totalTokens.toLocaleString()} tokens`,
    `  Loops:        ${report.session.loopCount}`,
    `  Avg In/Loop:  ${report.session.avgInputPerLoop.toLocaleString()} tokens`,
    `  Avg Out/Loop: ${report.session.avgOutputPerLoop.toLocaleString()} tokens`,
    `Budget:`,
    `  numCtx:           ${report.budget.numCtx.toLocaleString()}`,
    `  Current Usage:    ${(report.budget.currentUtilization * 100).toFixed(1)}%`,
    `  Peak Usage:       ${(report.budget.peakUtilization * 100).toFixed(1)}%`,
    `  Trend:            ${report.budget.trend}`,
    `Compression:`,
    `  History Count:    ${report.compression.historyCount}`,
    `  Avg Ratio:        ${(report.compression.avgCompressionRatio * 100).toFixed(0)}%`,
    `  Last Ratio:       ${report.compression.lastCompressionRatio !== null ? (report.compression.lastCompressionRatio * 100).toFixed(0) + '%' : 'N/A'}`,
  ];
  if (report.warnings.length > 0) {
    lines.push(`Warnings:`);
    for (const w of report.warnings) lines.push(`  ⚠️ ${w}`);
  }
  return lines.join('\n');
}

export type CompressionStrategy = 'skip' | 'fast' | 'medium' | 'llm';

export interface CompressionDecision {
  strategy: CompressionStrategy;
  reason: string;
  estimatedSavings: number;
}

export function chooseCompressionStrategy(
  messages: OllamaMessage[],
  numCtx: number,
  pressureLevel: string,
): CompressionDecision {
  const totalTokens = estimateTokens(messages.map((m) => m.content || '').join(''));
  const usageRatio = numCtx > 0 ? totalTokens / numCtx : 0;

  if (pressureLevel === 'low' && messages.length < 30) {
    return {
      strategy: 'skip',
      reason: `上下文压力低 (${messages.length} 条消息, ${(usageRatio * 100).toFixed(0)}%)，无需压缩`,
      estimatedSavings: 0,
    };
  }

  const toolMsgs = messages.filter((m) => m.role === 'tool');
  const toolRatio = messages.length > 0 ? toolMsgs.length / messages.length : 0;

  if (toolRatio > 0.4 && pressureLevel !== 'critical') {
    return {
      strategy: 'fast',
      reason: `工具结果占比高 (${(toolRatio * 100).toFixed(0)}%)，使用快速截断压缩`,
      estimatedSavings: Math.floor(totalTokens * 0.3),
    };
  }

  if (pressureLevel === 'medium' || pressureLevel === 'high') {
    return {
      strategy: 'medium',
      reason: `中等压力 (${pressureLevel})，使用消息合并+裁剪`,
      estimatedSavings: Math.floor(totalTokens * 0.4),
    };
  }

  if (pressureLevel === 'critical' || usageRatio > 0.75) {
    return {
      strategy: 'llm',
      reason: `高压力 (${pressureLevel}, ${(usageRatio * 100).toFixed(0)}%)，使用 LLM 摘要压缩`,
      estimatedSavings: Math.floor(totalTokens * 0.6),
    };
  }

  return { strategy: 'fast', reason: '默认快速压缩', estimatedSavings: Math.floor(totalTokens * 0.2) };
}

export type { ContextWarningLevel };
