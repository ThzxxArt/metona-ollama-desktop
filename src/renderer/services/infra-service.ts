/**
 * Infrastructure Service - 基础设施服务 (R41-R50)
 * 内存泄漏防护、全局错误处理、性能监控、配置验证、健康检查
 */

import { logInfo, logWarn, logError } from './log-service.js';

// ══════════════════════════════════════════════
// R41: 内存泄漏防护 — 事件监听器管理
// ══════════════════════════════════════════════

/** R41: 已注册的事件监听器追踪表 */
const _trackedListeners = new Map<string, { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }>();

let _listenerIdCounter = 0;

/**
 * R41: 注册并追踪事件监听器，便于统一清理
 * @returns 监听器 ID，可用于单独移除
 */
export function trackEventListener(
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): string {
  const id = `listener_${++_listenerIdCounter}`;
  _trackedListeners.set(id, { target, type, listener, options });
  target.addEventListener(type, listener, options);
  return id;
}

/** R41: 移除单个事件监听器 */
export function removeTrackedListener(id: string): void {
  const entry = _trackedListeners.get(id);
  if (entry) {
    entry.target.removeEventListener(entry.type, entry.listener, entry.options);
    _trackedListeners.delete(id);
  }
}

/** R41: 清理所有已追踪的事件监听器（用于页面卸载或会话切换时） */
export function cleanupAllListeners(): void {
  let count = 0;
  for (const [id, entry] of _trackedListeners) {
    try {
      entry.target.removeEventListener(entry.type, entry.listener, entry.options);
      count++;
    } catch { /* ignore */ }
    _trackedListeners.delete(id);
  }
  if (count > 0) {
    logInfo(`R41: 已清理 ${count} 个事件监听器`);
  }
}

/** R41: 获取当前追踪的监听器数量（供调试用） */
export function getTrackedListenerCount(): number {
  return _trackedListeners.size;
}

// ══════════════════════════════════════════════
// R42: 全局错误边界 — 捕获未处理的异常
// ══════════════════════════════════════════════

/** R42: 初始化全局错误处理 */
export function initGlobalErrorHandler(): void {
  // 捕获未处理的 JS 错误
  window.addEventListener('error', (e) => {
    logError('R42: 未捕获错误', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
    // 阻止默认的错误处理（避免弹出丑陋的错误对话框）
    e.preventDefault();
  });

  // 捕获未处理的 Promise rejection
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    logError('R42: 未处理的 Promise Rejection', msg);
    e.preventDefault();
  });

  logInfo('R42: 全局错误处理器已初始化');
}

// ══════════════════════════════════════════════
// R43: 性能监控 — 关键操作耗时追踪
// ══════════════════════════════════════════════

export interface PerfMetric {
  name: string;
  duration: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

const _perfMetrics: PerfMetric[] = [];
const MAX_PERF_METRICS = 200;
const _perfTimers = new Map<string, number>();

/** R43: 开始性能计时 */
export function perfStart(name: string): void {
  _perfTimers.set(name, performance.now());
}

/** R43: 结束性能计时并记录 */
export function perfEnd(name: string, metadata?: Record<string, unknown>): number {
  const startTime = _perfTimers.get(name);
  if (startTime === undefined) {
    logWarn(`R43: perfEnd 未找到对应的 perfStart: ${name}`);
    return 0;
  }
  const duration = performance.now() - startTime;
  _perfTimers.delete(name);

  _perfMetrics.push({ name, duration, timestamp: Date.now(), metadata });

  // 超过上限时移除最早的
  if (_perfMetrics.length > MAX_PERF_METRICS) {
    _perfMetrics.shift();
  }

  // 慢操作警告（超过 1 秒）
  if (duration > 1000) {
    logWarn(`R43: 慢操作: ${name} 耗时 ${duration.toFixed(0)}ms`);
  }

  return duration;
}

/** R43: 获取性能指标 */
export function getPerfMetrics(): PerfMetric[] {
  return [..._perfMetrics];
}

/** R43: 获取平均性能指标 */
export function getAvgPerfMetric(name: string): number {
  const metrics = _perfMetrics.filter(m => m.name === name);
  if (metrics.length === 0) return 0;
  return metrics.reduce((sum, m) => sum + m.duration, 0) / metrics.length;
}

/** R43: 清空性能指标 */
export function clearPerfMetrics(): void {
  _perfMetrics.length = 0;
  _perfTimers.clear();
}

// ══════════════════════════════════════════════
// R48: 配置验证 — 启动时验证关键配置
// ══════════════════════════════════════════════

export interface ConfigValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

/** R48: 验证应用配置 */
export function validateConfig(config: Record<string, unknown>): ConfigValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // 验证 numCtx
  const numCtx = config.numCtx as number;
  if (numCtx !== undefined) {
    if (numCtx < 2048) {
      warnings.push(`numCtx=${numCtx} 过小，可能导致上下文截断。建议至少 4096。`);
    }
    if (numCtx > 131072) {
      warnings.push(`numCtx=${numCtx} 过大，可能导致内存不足。建议不超过 131072。`);
    }
  }

  // 验证 temperature
  const temperature = config.temperature as number;
  if (temperature !== undefined) {
    if (temperature < 0 || temperature > 2) {
      errors.push(`temperature=${temperature} 超出有效范围 [0, 2]`);
    }
  }

  // 验证 maxTurns
  const maxTurns = config.maxTurns as number;
  if (maxTurns !== undefined) {
    if (maxTurns < 1) {
      errors.push(`maxTurns=${maxTurns} 不能小于 1`);
    }
    if (maxTurns > 50) {
      warnings.push(`maxTurns=${maxTurns} 过大，可能导致长时间运行。建议不超过 20。`);
    }
  }

  // 验证 streamTimeout
  const streamTimeout = config.streamTimeout as number;
  if (streamTimeout !== undefined) {
    if (streamTimeout < 10000) {
      warnings.push(`streamTimeout=${streamTimeout} 过短，可能导致大模型生成被中断。建议至少 30000ms。`);
    }
  }

  // 验证 subAgentTimeout
  const subAgentTimeout = config.subAgentTimeout as number;
  if (subAgentTimeout !== undefined && subAgentTimeout < 5000) {
    warnings.push(`subAgentTimeout=${subAgentTimeout} 过短，子代理可能无法完成任务。`);
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

// ══════════════════════════════════════════════
// R50: 健康检查 — 系统健康监控
// ══════════════════════════════════════════════

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }>;
  timestamp: number;
}

/** R50: 执行系统健康检查 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
  const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }> = [];

  // 检查 1: 桌面 API 可用性
  const bridge = window.metonaDesktop;
  if (bridge?.isDesktop) {
    checks.push({ name: '桌面 API', status: 'pass', message: '桌面 API 可用' });
  } else {
    checks.push({ name: '桌面 API', status: 'fail', message: '桌面 API 不可用（Web 模式）' });
  }

  // 检查 2: 数据库可用性
  if (bridge?.db) {
    try {
      const sessions = await bridge.db.getAllSessions();
      checks.push({ name: '数据库', status: 'pass', message: `数据库正常（${sessions.length} 个会话）` });
    } catch (err) {
      checks.push({ name: '数据库', status: 'fail', message: `数据库访问失败: ${(err as Error).message}` });
    }
  } else {
    checks.push({ name: '数据库', status: 'warn', message: '数据库 API 不可用' });
  }

  // 检查 3: 内存使用
  const memInfo = (performance as any).memory;
  if (memInfo) {
    const usedMB = (memInfo.usedJSHeapSize / 1024 / 1024).toFixed(0);
    const limitMB = (memInfo.jsHeapSizeLimit / 1024 / 1024).toFixed(0);
    const usageRatio = memInfo.usedJSHeapSize / memInfo.jsHeapSizeLimit;
    if (usageRatio > 0.8) {
      checks.push({ name: '内存', status: 'warn', message: `内存使用较高: ${usedMB}/${limitMB}MB (${(usageRatio * 100).toFixed(0)}%)` });
    } else {
      checks.push({ name: '内存', status: 'pass', message: `内存使用正常: ${usedMB}/${limitMB}MB` });
    }
  } else {
    checks.push({ name: '内存', status: 'pass', message: '内存监控不可用（非 Chromium）' });
  }

  // 检查 4: 工作空间可用性
  if (bridge?.workspace) {
    try {
      const result = await bridge.workspace.getDir();
      if (result.dir) {
        checks.push({ name: '工作空间', status: 'pass', message: `工作空间: ${result.dir}` });
      } else {
        checks.push({ name: '工作空间', status: 'warn', message: '工作空间未设置' });
      }
    } catch {
      checks.push({ name: '工作空间', status: 'warn', message: '工作空间访问失败' });
    }
  }

  // 检查 5: 事件监听器数量（内存泄漏检测）
  const listenerCount = _trackedListeners.size;
  if (listenerCount > 100) {
    checks.push({ name: '事件监听器', status: 'warn', message: `追踪的事件监听器较多: ${listenerCount} 个，可能存在内存泄漏` });
  } else {
    checks.push({ name: '事件监听器', status: 'pass', message: `事件监听器数量正常: ${listenerCount} 个` });
  }

  // 确定整体状态
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  const status: 'healthy' | 'degraded' | 'unhealthy' = hasFail ? 'unhealthy' : hasWarn ? 'degraded' : 'healthy';

  return { status, checks, timestamp: Date.now() };
}

/** R50: 格式化健康检查结果为可读字符串 */
export function formatHealthCheck(result: HealthCheckResult): string {
  const statusIcon = result.status === 'healthy' ? '✅' : result.status === 'degraded' ? '⚠️' : '❌';
  const lines = [`${statusIcon} 系统健康检查 — ${result.status.toUpperCase()}`, ''];
  for (const check of result.checks) {
    const icon = check.status === 'pass' ? '✅' : check.status === 'warn' ? '⚠️' : '❌';
    lines.push(`${icon} ${check.name}: ${check.message}`);
  }
  return lines.join('\n');
}
