/**
 * 上下文 token 估算、校准、使用率预测与压缩指标。
 */

import type { OllamaMessage } from '../../types.js';

// ── R12: 压缩去重 — 内容指纹追踪 ──

function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

const _compressedContentHashes = new Set<string>();
const MAX_COMPRESSED_HASHES = 100;

export function computeMessagesHash(messages: OllamaMessage[]): string {
  const content = messages.map((m) => `${m.role}:${(m.content || '').slice(0, 200)}`).join('|');
  return djb2Hash(content);
}

export function isAlreadyCompressed(messages: OllamaMessage[]): boolean {
  if (messages.length === 0) return true;
  return _compressedContentHashes.has(computeMessagesHash(messages));
}

export function markAsCompressed(messages: OllamaMessage[]): void {
  const hash = computeMessagesHash(messages);
  _compressedContentHashes.add(hash);
  if (_compressedContentHashes.size > MAX_COMPRESSED_HASHES) {
    const firstKey = _compressedContentHashes.values().next().value;
    if (firstKey) _compressedContentHashes.delete(firstKey);
  }
}

// ── R18: 上下文使用率预测 ──

interface TokenUsagePoint {
  turn: number;
  tokens: number;
  numCtx: number;
  timestamp: number;
}

const _tokenUsageTrend: TokenUsagePoint[] = [];
const MAX_TREND_POINTS = 20;
let _currentTurn = 0;

export type ContextWarningLevel = 'safe' | 'notice' | 'warning' | 'critical';

export interface ContextPrediction {
  level: ContextWarningLevel;
  currentUsage: number;
  predictedUsage: number;
  turnsToOverflow: number;
  message: string;
}

export function recordTokenUsage(tokens: number, numCtx: number): void {
  _currentTurn++;
  _tokenUsageTrend.push({ turn: _currentTurn, tokens, numCtx, timestamp: Date.now() });
  if (_tokenUsageTrend.length > MAX_TREND_POINTS) _tokenUsageTrend.shift();
}

export function predictContextOverflow(numCtx: number): ContextPrediction {
  const currentTokens = _tokenUsageTrend.length > 0 ? _tokenUsageTrend[_tokenUsageTrend.length - 1].tokens : 0;
  const currentUsage = currentTokens / numCtx;

  if (_tokenUsageTrend.length < 3) {
    const level: ContextWarningLevel =
      currentUsage > 0.8 ? 'critical' : currentUsage > 0.6 ? 'warning' : currentUsage > 0.4 ? 'notice' : 'safe';
    return {
      level,
      currentUsage,
      predictedUsage: currentUsage,
      turnsToOverflow: -1,
      message: level === 'safe' ? '' : `当前上下文使用率 ${(currentUsage * 100).toFixed(0)}%`,
    };
  }

  const n = _tokenUsageTrend.length;
  const xs = _tokenUsageTrend.map((p) => p.turn);
  const ys = _tokenUsageTrend.map((p) => p.tokens);
  const xMean = xs.reduce((s, x) => s + x, 0) / n;
  const yMean = ys.reduce((s, y) => s + y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }
  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;

  const nextTurn = _currentTurn + 1;
  const predictedTokens = Math.max(0, slope * nextTurn + intercept);
  const predictedUsage = predictedTokens / numCtx;

  let turnsToOverflow = -1;
  if (slope > 0) {
    turnsToOverflow = Math.ceil((numCtx - intercept) / slope - _currentTurn);
    if (turnsToOverflow < 0) turnsToOverflow = 0;
  }

  const maxUsage = Math.max(currentUsage, predictedUsage);
  let level: ContextWarningLevel;
  let message = '';

  if (maxUsage > 0.85 || turnsToOverflow === 0) {
    level = 'critical';
    message = `⚠️ 上下文即将溢出！当前 ${currentTokens}/${numCtx} tokens (${(currentUsage * 100).toFixed(0)}%)，预计 ${turnsToOverflow} 轮后溢出`;
  } else if (maxUsage > 0.7 || (turnsToOverflow >= 1 && turnsToOverflow <= 3)) {
    level = 'warning';
    message = `⚠️ 上下文使用率较高 (${(currentUsage * 100).toFixed(0)}%)，预计 ${turnsToOverflow} 轮后可能溢出，建议压缩`;
  } else if (maxUsage > 0.5) {
    level = 'notice';
    message = `上下文使用率 ${(currentUsage * 100).toFixed(0)}%，趋势正常`;
  } else {
    level = 'safe';
  }

  return { level, currentUsage, predictedUsage, turnsToOverflow, message };
}

// ── Token 估算校准状态 ──

let _calibrationModel = '';
let _tokenCalibrationRatio = 1.0;
let _calibrationSamples = 0;
const MIN_CALIBRATION_SAMPLES = 5;

export const AUTO_COMPRESS_THRESHOLD = 0.5;

export function recordActualTokens(
  actualInputTokens: number,
  _actualOutputTokens: number,
  estimatedCount: number,
  modelName?: string,
): void {
  if (modelName && modelName !== _calibrationModel) {
    _calibrationModel = modelName;
    _tokenCalibrationRatio = 1.0;
    _calibrationSamples = 0;
  }
  if (actualInputTokens <= 0 || estimatedCount <= 0) return;
  const sampleRatio = actualInputTokens / Math.max(1, estimatedCount);
  const alpha = 0.3;
  _tokenCalibrationRatio = _tokenCalibrationRatio * (1 - alpha) + sampleRatio * alpha;
  _calibrationSamples++;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let chineseChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) chineseChars++;
    else otherChars++;
  }
  const raw = Math.ceil(chineseChars / 1.5 + otherChars / 4);
  if (_calibrationSamples >= MIN_CALIBRATION_SAMPLES) {
    return Math.ceil(raw * _tokenCalibrationRatio);
  }
  return raw;
}

export function getAdaptiveCompressThreshold(numCtx: number): number {
  if (numCtx < 8192) return 0.55;
  if (numCtx > 32768) return 0.45;
  return AUTO_COMPRESS_THRESHOLD;
}

export interface CompressionMetrics {
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  compressionRatio: number;
  timestamp: number;
}

const _compressionHistory: CompressionMetrics[] = [];
const MAX_COMPRESSION_HISTORY = 20;

export function getCompressionHistory(): CompressionMetrics[] {
  return [..._compressionHistory];
}

export function getAverageCompressionRatio(): number {
  if (_compressionHistory.length === 0) return 1.0;
  return _compressionHistory.reduce((s, m) => s + m.compressionRatio, 0) / _compressionHistory.length;
}

export function recordCompressionMetrics(metrics: CompressionMetrics): void {
  _compressionHistory.push(metrics);
  if (_compressionHistory.length > MAX_COMPRESSION_HISTORY) _compressionHistory.shift();
}
