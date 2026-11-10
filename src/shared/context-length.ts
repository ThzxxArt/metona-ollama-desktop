/**
 * 上下文长度校验与格式化（纯函数）
 */

import { DEFAULT_CONTEXT_LENGTH, MAX_CONTEXT_LENGTH, MIN_CONTEXT_LENGTH } from './contracts/ollama.js';

export function clampContextLength(value: unknown, fallback = DEFAULT_CONTEXT_LENGTH): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_CONTEXT_LENGTH, Math.max(MIN_CONTEXT_LENGTH, Math.round(n)));
}

export function formatContextLength(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}
