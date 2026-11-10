/**
 * Agent 执行轨迹缓冲与降级存储。
 */

import { logInfo, logWarn } from '../log-service.js';
import { generateId } from '../../utils/utils.js';

const _traceBuffer: Array<Record<string, any>> = [];
const TRACE_FLUSH_INTERVAL = 5000;
const TRACE_MAX_RETRIES = 3;
let _traceFlushTimer: ReturnType<typeof setTimeout> | null = null;

const TRACE_FALLBACK_KEY = '_metona_trace_fallback';
const TRACE_FALLBACK_MAX = 200;

function fallbackSaveTraces(traces: Array<Record<string, any>>): void {
  try {
    const existing = JSON.parse(localStorage.getItem(TRACE_FALLBACK_KEY) || '[]');
    const combined = [...existing, ...traces].slice(-TRACE_FALLBACK_MAX);
    localStorage.setItem(TRACE_FALLBACK_KEY, JSON.stringify(combined));
    if (traces.length > 0) {
      logWarn(`R9: ${traces.length} 条轨迹降级到 localStorage（共 ${combined.length} 条）`);
    }
  } catch {
    logWarn(`R9: 轨迹降级存储也失败，${traces.length} 条轨迹丢失`);
  }
}

async function flushTraces(): Promise<void> {
  if (_traceBuffer.length === 0) return;
  const batch = _traceBuffer.splice(0, _traceBuffer.length);
  const bridge = window.metonaDesktop;
  if (!bridge?.db) {
    fallbackSaveTraces(batch);
    return;
  }

  const entries = batch.map((trace) => ({
    id: String(trace.id || `trace_${generateId()}`),
    session_id: trace.sessionId,
    step_index: trace.stepIndex,
    thought: trace.thought,
    action: trace.action,
    action_input: trace.actionInput,
    observation: trace.observation,
    loop_count: trace.loopCount,
    error_pattern: trace.errorPattern || null,
    created_at: trace.createdAt,
  }));

  let saved = false;
  for (let attempt = 0; attempt < TRACE_MAX_RETRIES; attempt++) {
    try {
      const result = await bridge.db.saveTracesBatch(entries);
      if (result.success) {
        saved = true;
        break;
      }
    } catch {
      if (attempt < TRACE_MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  if (!saved) fallbackSaveTraces(batch);
}

export function getTraceFallbackBackup(): Array<Record<string, any>> {
  try {
    const raw = localStorage.getItem(TRACE_FALLBACK_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Array<Record<string, any>>;
  } catch {
    return [];
  }
}

export function restoreTraceFallbackBackup(traces: Array<Record<string, any>>): void {
  if (!Array.isArray(traces)) return;
  try {
    const sliced = traces.slice(-TRACE_FALLBACK_MAX);
    localStorage.setItem(TRACE_FALLBACK_KEY, JSON.stringify(sliced));
    logInfo(`R9: 从备份恢复 ${sliced.length} 条轨迹降级缓存`);
  } catch (err) {
    logWarn(`R9: 恢复轨迹降级缓存失败: ${(err as Error).message}`);
  }
}

export async function saveTrace(trace: Record<string, any>): Promise<void> {
  _traceBuffer.push(trace);
  if (!_traceFlushTimer) {
    _traceFlushTimer = setTimeout(() => {
      _traceFlushTimer = null;
      void flushTraces();
    }, TRACE_FLUSH_INTERVAL);
  }
  if (_traceBuffer.length >= 20) {
    if (_traceFlushTimer) {
      clearTimeout(_traceFlushTimer);
      _traceFlushTimer = null;
    }
    void flushTraces();
  }
}

export async function flushAllTraces(): Promise<void> {
  if (_traceFlushTimer) {
    clearTimeout(_traceFlushTimer);
    _traceFlushTimer = null;
  }
  await flushTraces();
}
