/**
 * Harness Hook 系统
 * Harness Engineering: 可扩展的 Agent 执行钩子架构
 *
 * 钩子阶段：
 * - pre_tool: 工具执行前（安全检查、缓存检查、权限验证）
 * - post_tool: 工具执行后（结果验证、自动 lint、自动测试）
 * - post_iteration: 每轮迭代后（记忆提取、上下文裁剪）
 * - pre_completion: 最终输出前（完成门控、质量检查）
 *
 * 设计原则：
 * - 异步并行执行，失败不阻塞主流程
 * - 优先级排序，高优先级先执行
 * - 可动态注册/移除
 * - MCP 工具可注册自定义 Hook
 */

import { logInfo, logWarn, logDebug } from './log-service.js';
import type { HarnessHook, HookPhase, HookResult, HookData, LoopContext } from '../types.js';

// ═══════════════════════════════════════════════════════════════
// Hook 注册表
// ═══════════════════════════════════════════════════════════════

const hookRegistry = new Map<string, HarnessHook>();
const phaseIndex = new Map<HookPhase, HarnessHook[]>();

function ensurePhaseIndex(phase: HookPhase): void {
  if (!phaseIndex.has(phase)) {
    phaseIndex.set(phase, []);
  }
}

/** 注册 Hook */
export function registerHook(hook: HarnessHook): void {
  hookRegistry.set(hook.name, hook);
  ensurePhaseIndex(hook.phase);
  phaseIndex.get(hook.phase)!.push(hook);
  // 按优先级降序排列
  phaseIndex.get(hook.phase)!.sort((a, b) => b.priority - a.priority);
  logDebug(`Hook 已注册: "${hook.name}" phase=${hook.phase} priority=${hook.priority}`);
}

/** 移除 Hook */
export function unregisterHook(name: string): void {
  const hook = hookRegistry.get(name);
  if (!hook) return;
  hookRegistry.delete(name);
  const list = phaseIndex.get(hook.phase);
  if (list) {
    const idx = list.findIndex(h => h.name === name);
    if (idx !== -1) list.splice(idx, 1);
  }
}

/** 启用/禁用 Hook */
export function setHookEnabled(name: string, enabled: boolean): void {
  const hook = hookRegistry.get(name);
  if (hook) {
    hook.enabled = enabled;
    logDebug(`Hook "${name}" ${enabled ? '已启用' : '已禁用'}`);
  }
}

/** 获取所有已注册 Hook */
export function getRegisteredHooks(): HarnessHook[] {
  return Array.from(hookRegistry.values());
}

/** 获取指定阶段已启用的 Hook */
export function getPhaseHooks(phase: HookPhase): HarnessHook[] {
  return (phaseIndex.get(phase) || []).filter(h => h.enabled);
}

// ═══════════════════════════════════════════════════════════════
// Hook 执行引擎
// ═══════════════════════════════════════════════════════════════

/**
 * 并行执行指定阶段的所有 Hook
 * @returns 所有 Hook 的执行结果汇总
 */
export async function executeHooks(
  phase: HookPhase,
  ctx: LoopContext,
  data: HookData = {}
): Promise<{ results: HookResult[]; allPassed: boolean }> {
  const hooks = getPhaseHooks(phase);
  if (hooks.length === 0) {
    return { results: [], allPassed: true };
  }

  const results = await Promise.all(
    hooks.map(async (hook) => {
      try {
        const result = await hook.handler(ctx, data);
        if (!result.passed) {
          logWarn(`Hook "${hook.name}" 未通过: ${result.message}`);
        }
        return result;
      } catch (err) {
        logWarn(`Hook "${hook.name}" 执行异常: ${(err as Error).message}`);
        return { passed: true, message: `Hook 异常（已忽略）: ${(err as Error).message}` };
      }
    })
  );

  const allPassed = results.every(r => r.passed);
  return { results, allPassed };
}

// ═══════════════════════════════════════════════════════════════
// 内置 Hook
// ═══════════════════════════════════════════════════════════════

/**
 * SecurityCheckHook — 工具执行前安全检查
 * 检查命令和路径是否在黑名单内
 */
export const securityCheckHook: HarnessHook = {
  name: 'SecurityCheck',
  phase: 'pre_tool',
  priority: 100, // 最高优先级
  enabled: true,
  handler: async (_ctx: LoopContext, data: HookData) => {
    const { toolName, toolArgs } = data;
    if (toolName === 'run_command' && typeof toolArgs?.command === 'string') {
      const cmd = toolArgs.command as string;
      // 快速黑名单检查
      const dangerous = ['rm -rf /', 'mkfs', 'dd if=', 'shutdown', 'reboot', ':(){', 'chmod 777 /'];
      for (const d of dangerous) {
        if (cmd.toLowerCase().includes(d.toLowerCase())) {
          return { passed: false, message: `危险命令被拦截: ${cmd.slice(0, 100)}` };
        }
      }
      // 管道执行 shell 检测
      if (/(\||>|<)\s*(sh|bash|zsh|powershell|cmd)/i.test(cmd)) {
        return { passed: false, message: `禁止通过管道执行 shell: ${cmd.slice(0, 100)}` };
      }
    }
    if (toolName === 'delete_file' && typeof toolArgs?.path === 'string') {
      const p = (toolArgs.path as string).toLowerCase();
      const protectedPaths = ['/etc', '/sys', '/proc', '/dev', '/boot', 'c:\\windows', '.ssh', '.gnupg'];
      for (const pp of protectedPaths) {
        if (p.includes(pp)) {
          return { passed: false, message: `受保护路径不可删除: ${p}` };
        }
      }
    }
    return { passed: true, message: '' };
  },
};

/**
 * ResultValidationHook — 工具执行后结果验证
 * 检查工具返回是否有效。注意：此 Hook 为咨询性（post_tool 阶段不阻断执行），
 * 实际的截断由 agent-engine 的 formatToolResultForModel 和 40 条消息硬限制负责。
 */
export const resultValidationHook: HarnessHook = {
  name: 'ResultValidation',
  phase: 'post_tool',
  priority: 90,
  enabled: true,
  handler: async (_ctx: LoopContext, data: HookData) => {
    const { toolName, toolResult } = data;
    if (!toolResult) return { passed: true, message: '' };

    // 检查空结果
    if (!toolResult.success && !toolResult.error) {
      return { passed: false, message: `工具 ${toolName} 执行失败但未提供错误信息` };
    }

    // 检查超大结果。不同工具有不同阈值：
    // web_search 包含自动抓取内容，允许较大结果
    const SIZE_LIMITS: Record<string, number> = {
      web_search: 1_000_000,   // 1MB（含自动抓取的多页内容）
      web_fetch: 500_000,      // 500KB
      read_file: 200_000,      // 200KB
      default: 500_000,        // 默认 500KB
    };
    const limit = SIZE_LIMITS[toolName || ''] || SIZE_LIMITS.default;

    if (toolResult.success && toolResult) {
      const resultStr = JSON.stringify(toolResult);
      if (resultStr.length > limit) {
        // 仅警告，不阻断（实际截断由 agent-engine 负责）
        return {
          passed: true,
          message: `工具 ${toolName} 返回结果较大 (${(resultStr.length / 1024).toFixed(0)}KB)，将由上下文管理器自动截断`,
          data: { oversized: true, size: resultStr.length },
        };
      }
    }

    return { passed: true, message: '' };
  },
};

/**
 * IterationMetricsHook — 迭代度量收集
 * 每轮迭代后记录关键指标
 */
export const iterationMetricsHook: HarnessHook = {
  name: 'IterationMetrics',
  phase: 'post_iteration',
  priority: 50,
  enabled: true,
  handler: async (ctx: LoopContext, _data: HookData) => {
    // 收集本轮迭代统计
    const totalMessages = ctx.messages.length;
    const toolMessages = ctx.messages.filter(m => m.role === 'tool').length;
    logDebug(
      `迭代度量 [第 ${ctx.loopCount} 轮]: ` +
      `${totalMessages} 消息, ${toolMessages} 工具消息, ` +
      `${ctx.totalEvalCount} eval tokens, ${ctx.allToolRecords.length} 总工具调用`
    );
    return { passed: true, message: '' };
  },
};

// ═══════════════════════════════════════════════════════════════
// Harness Hook: 文件写入去重
// ═══════════════════════════════════════════════════════════════

/** 会话级已写入文件路径集合 — 由 FileWriteDedupHook 和 PlanAutoTrackHook 共同维护 */
const _writtenFilesThisSession = new Set<string>();

/**
 * FileWriteDedupHook — write_file 同路径去重（pre_tool 阻断级）
 * 同一文件路径在本会话中已成功写入后，后续写入被拦截，
 * 防止模型在设计迭代中反复覆盖同一文件。
 */
export const fileWriteDedupHook: HarnessHook = {
  name: 'FileWriteDedup',
  phase: 'pre_tool',
  priority: 95,
  enabled: true,
  handler: async (_ctx: LoopContext, data: HookData) => {
    if (data.toolName !== 'write_file') return { passed: true, message: '' };
    const filePath = String(data.toolArgs?.path || '');
    if (!filePath) return { passed: true, message: '' };
    if (_writtenFilesThisSession.has(filePath)) {
      return { passed: false, message: `文件 "${filePath}" 已在本会话中写入，无需重复覆盖。请直接给出最终回答。` };
    }
    return { passed: true, message: '' };
  },
};

/**
 * PlanAutoTrackHook — Plan Mode 步骤追踪（post_tool 非阻断级）
 * 不自动标记步骤（避免模糊匹配误标），仅由 AI 通过 plan_track 工具精确标记。
 * 此处只维护 write_file 路径记录供 FileWriteDedupHook 使用。
 */
export const planAutoTrackHook: HarnessHook = {
  name: 'PlanAutoTrack',
  phase: 'post_tool',
  priority: 80,
  enabled: true,
  handler: async (ctx: LoopContext, data: HookData) => {
    if (ctx.mode !== 'plan') return { passed: true, message: '' };
    const toolName = data.toolName || '';
    const toolResult = data.toolResult as Record<string, unknown> | undefined;

    // write_file 成功后记录文件路径，供 FileWriteDedupHook 拦截
    if (toolName === 'write_file' && toolResult?.success && data.toolArgs?.path) {
      _writtenFilesThisSession.add(String(data.toolArgs.path));
    }

    return { passed: true, message: '' };
  },
};

// ═══════════════════════════════════════════════════════════════
// 初始化：注册所有内置 Hook
// ═══════════════════════════════════════════════════════════════

let hooksInitialized = false;

export function initHarnessHooks(): void {
  if (hooksInitialized) return;
  registerHook(securityCheckHook);
  registerHook(resultValidationHook);
  registerHook(iterationMetricsHook);
  registerHook(fileWriteDedupHook);
  registerHook(planAutoTrackHook);
  hooksInitialized = true;
  logInfo('Harness Hook 系统已初始化', `${hookRegistry.size} 个 Hook 已注册`);
}
