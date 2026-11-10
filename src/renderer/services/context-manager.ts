/**
 * Context Manager（0.18.0）
 *
 * 已拆分为：
 * - context/tokenizer.ts    token 估算 / 校准 / 预测 / 压缩指标
 * - context/builder.ts      滑动窗口 / 快速摘要 / system 分区
 * - context/compressor.ts   LLM 结构化摘要压缩
 * - context/metrics.ts      压力分级 / Token 预算 / 趋势决策 / 报告
 * - context/session-summary.ts
 * - context/checkpoint.ts
 *
 * 本文件保留原有公共导出，调用方无需修改。
 */

export {
  type ContextWarningLevel,
  type ContextPrediction,
  recordTokenUsage,
  predictContextOverflow,
  AUTO_COMPRESS_THRESHOLD,
  recordActualTokens,
  estimateTokens,
  getAdaptiveCompressThreshold,
  type CompressionMetrics,
  getCompressionHistory,
  getAverageCompressionRatio,
} from './context/tokenizer.js';

export { scoreMessageImportance, buildContext, shouldAutoCompress } from './context/builder.js';
export type { ContextBuildOptions, StructuredSummary } from './context/types.js';

export { compressWithLLM } from './context/compressor.js';

export {
  type ContextPressureLevel,
  type ContextPressureInfo,
  type ContextStats,
  calculateContextStats,
  getContextPressureLevel,
  setTokenBudgetNumCtx,
  recordBudgetUsage,
  type TokenBudgetStatus,
  getTokenBudgetStatus,
  resetTokenBudget,
  mergeConsecutiveMessages,
  getTrendAwareCompressThreshold,
  type TokenReport,
  generateTokenReport,
  formatTokenReport,
  type CompressionStrategy,
  type CompressionDecision,
  chooseCompressionStrategy,
} from './context/metrics.js';

export {
  type SessionSummary,
  saveSessionSummary,
  loadSessionSummaries,
  getSessionSummariesBackup,
  restoreSessionSummariesBackup,
  generateSessionSummary,
  formatSessionSummariesForContext,
} from './context/session-summary.js';

export { type AgentCheckpoint, createCheckpoint, clearCheckpoints } from './context/checkpoint.js';
