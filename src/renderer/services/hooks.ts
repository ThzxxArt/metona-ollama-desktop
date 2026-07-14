/**
 * Harness Hook 系统
 * 可扩展的 Agent 执行钩子架构
 *
 * 钩子阶段：
 * - pre_tool: 工具执行前（安全检查、文件去重）
 * - post_tool: 工具执行后
 * - post_iteration: 每轮迭代后
 * - pre_completion: 最终输出前
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

export function registerHook(hook: HarnessHook): void {
  hookRegistry.set(hook.name, hook);
  ensurePhaseIndex(hook.phase);
  phaseIndex.get(hook.phase)!.push(hook);
  phaseIndex.get(hook.phase)!.sort((a, b) => b.priority - a.priority);
  logDebug(`Hook 已注册: "${hook.name}" phase=${hook.phase} priority=${hook.priority}`);
}

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

export function setHookEnabled(name: string, enabled: boolean): void {
  const hook = hookRegistry.get(name);
  if (hook) {
    hook.enabled = enabled;
    logDebug(`Hook "${name}" ${enabled ? '已启用' : '已禁用'}`);
  }
}

export function getRegisteredHooks(): HarnessHook[] {
  return Array.from(hookRegistry.values());
}

export function getPhaseHooks(phase: HookPhase): HarnessHook[] {
  return (phaseIndex.get(phase) || []).filter(h => h.enabled);
}

// ═══════════════════════════════════════════════════════════════
// Hook 执行引擎
// ═══════════════════════════════════════════════════════════════

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
        return await hook.handler(ctx, data);
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
 * 会话级已写入文件路径 → 内容指纹映射
 * P0-2 优化：从 Set<string> 改为 Map<string, string>，支持内容指纹去重
 * 只有内容完全相同时才阻断重复写入，允许不同内容的重写（修复→重写场景）
 */
const _writtenFileFingerprints = new Map<string, string>();

/** 简单内容指纹（djb2 hash，轻量快速，用于去重判断） */
function contentFingerprint(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash) + content.charCodeAt(i);
    hash = hash & 0xffffffff; // 保持32位
  }
  return hash.toString(16);
}

/** 暴露写入记录供 agent-engine 清理 */
export function clearWrittenFiles(): void {
  _writtenFileFingerprints.clear();
}
export function hasWrittenFile(path: string): boolean {
  return _writtenFileFingerprints.has(path);
}
export function addWrittenFile(path: string, content?: string): void {
  _writtenFileFingerprints.set(path, content ? contentFingerprint(content) : '');
}

/**
 * SecurityCheckHook — 工具执行前安全检查（pre_tool 阻断级）
 */
export const securityCheckHook: HarnessHook = {
  name: 'SecurityCheck',
  phase: 'pre_tool',
  priority: 100,
  enabled: true,
  handler: async (_ctx: LoopContext, data: HookData) => {
    const { toolName, toolArgs } = data;

    // 危险命令黑名单
    if (toolName === 'run_command' && typeof toolArgs?.command === 'string') {
      const cmd = toolArgs.command as string;
      const dangerous = ['rm -rf /', 'mkfs', 'dd if=', 'shutdown', 'reboot', ':(){', 'chmod 777 /'];
      for (const d of dangerous) {
        if (cmd.toLowerCase().includes(d.toLowerCase())) {
          return { passed: false, message: `危险命令被拦截: ${cmd.slice(0, 100)}` };
        }
      }
      if (/(\||>|<)\s*(sh|bash|zsh|powershell|cmd)/i.test(cmd)) {
        return { passed: false, message: `禁止通过管道执行 shell: ${cmd.slice(0, 100)}` };
      }
    }

    // 受保护路径不可删除
    if (toolName === 'delete_file') {
      const protectedPaths = ['/etc', '/sys', '/proc', '/dev', '/boot', 'c:\\windows', '.ssh', '.gnupg'];
      // 检查 path 和 paths 数组中的所有路径
      const pathsToCheck: string[] = [];
      if (typeof toolArgs?.path === 'string') pathsToCheck.push(toolArgs.path);
      if (Array.isArray(toolArgs?.paths)) pathsToCheck.push(...(toolArgs.paths as unknown[]).map(p => String(p)));
      for (const p of pathsToCheck) {
        const lower = p.toLowerCase();
        for (const pp of protectedPaths) {
          if (lower.includes(pp)) {
            return { passed: false, message: `受保护路径不可删除: ${p}` };
          }
        }
      }
    }

    return { passed: true, message: '' };
  },
};

/**
 * FileWriteDedupHook — 文件写入去重（pre_tool 阻断级）
 * P0-2 优化：从「同路径一刀切阻断」改为「内容指纹去重」
 * - 内容完全相同的重复写入 → 阻断（真正的浪费）
 * - 内容不同的重写 → 允许（修复→重写、迭代开发场景）
 * 同时记录 write_file 成功路径及内容指纹。
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

    const content = String(data.toolArgs?.content || '');
    const newFingerprint = contentFingerprint(content);
    const existingFingerprint = _writtenFileFingerprints.get(filePath);

    if (existingFingerprint !== undefined && existingFingerprint === newFingerprint) {
      // 内容完全相同 → 真正的重复写入，阻断
      return { passed: false, message: `文件 "${filePath}" 内容未变化，无需重复写入。` };
    }
    // 内容不同或首次写入 → 允许
    return { passed: true, message: '' };
  },
};

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

let hooksInitialized = false;

export function initHarnessHooks(): void {
  if (hooksInitialized) return;
  registerHook(securityCheckHook);
  registerHook(fileWriteDedupHook);
  hooksInitialized = true;
  logInfo('Harness Hook 系统已初始化', `${hookRegistry.size} 个 Hook 已注册`);
}
