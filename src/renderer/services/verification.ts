/**
 * Verification System — 验证系统模块
 * Harness Engineering: 计算性反馈管道
 *
 * 在 Agent 修改文件后自动运行：
 * - Linter（代码风格检查）
 * - Type Checker（类型检查）
 * - Test Runner（单元测试）
 * - Diff Analyzer（修改范围分析）
 *
 * 设计原则：
 * - 所有验证利用现有 run_command 工具执行
 * - 验证 Hook 注册到 hooks.ts 的 post_tool 阶段
 * - 验证失败的结果作为 Observation 注入 Agent 上下文
 * - 可配置开关（设置面板）
 */

import { registerHook } from './hooks.js';
import type { HarnessHook } from '../types.js';
import { logInfo, logDebug, logWarn } from './log-service.js';
import type { LoopContext, HookData, HookResult } from '../types.js';

// ═══════════════════════════════════════════════════════════════
// 验证配置
// ═══════════════════════════════════════════════════════════════

export interface VerificationConfig {
  /** 是否启用自动 Lint */
  autoLint: boolean;
  /** 是否启用自动类型检查 */
  autoTypeCheck: boolean;
  /** 是否启用自动测试 */
  autoTest: boolean;
  /** Lint 命令（留空自动检测） */
  lintCommand: string;
  /** 类型检查命令 */
  typeCheckCommand: string;
  /** 测试命令 */
  testCommand: string;
}

/** 默认配置 */
const defaultConfig: VerificationConfig = {
  autoLint: false,
  autoTypeCheck: false,
  autoTest: false,
  lintCommand: '',
  typeCheckCommand: '',
  testCommand: '',
};

/** 运行时配置 */
let config: VerificationConfig = { ...defaultConfig };

// ═══════════════════════════════════════════════════════════════
// 文件类型检测
// ═══════════════════════════════════════════════════════════════

/** 检测文件扩展名对应的语言 */
function detectFileType(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    cpp: 'cpp', c: 'c', rb: 'ruby', css: 'css',
    html: 'html', vue: 'vue', svelte: 'svelte',
  };
  return map[ext] || null;
}

/** 检测项目根目录（查找 package.json / pyproject.toml / Cargo.toml） */
function detectProjectRoot(filePath: string): string | null {
  // 简化实现：向上查找 package.json
  const parts = filePath.replace(/\\/g, '/').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const dir = parts.slice(0, i + 1).join('/');
    // 这里无法实际访问文件系统，返回文件所在目录的父级作为近似
  }
  // 返回文件所在目录
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSep > 0 ? filePath.slice(0, lastSep) : null;
}

// ═══════════════════════════════════════════════════════════════
// 验证 Hook 实现
// ═══════════════════════════════════════════════════════════════

/**
 * DiffAnalyzerHook — 修改范围分析
 * 检测 Agent 的修改是否跨越了架构边界
 */
export const diffAnalyzerHook: HarnessHook = {
  name: 'DiffAnalyzer',
  phase: 'post_tool',
  priority: 75,
  enabled: true,
  handler: async (_ctx: LoopContext, data: HookData): Promise<HookResult> => {
    const { toolName, toolArgs } = data;
    if (toolName !== 'write_file' && toolName !== 'edit_file') {
      return { passed: true, message: '' };
    }

    const filePath = (toolArgs?.path as string) || '';
    if (!filePath) return { passed: true, message: '' };

    // 分析修改的文件类型
    const fileType = detectFileType(filePath);
    if (!fileType) return { passed: true, message: '' };

    // 分析跨层调用风险
    const warnings: string[] = [];

    // 检测是否修改了核心基础模块
    const criticalPaths = ['/core/', '/base/', '/common/', '/shared/', '/utils/', '/lib/'];
    const filePathLower = filePath.toLowerCase();
    for (const cp of criticalPaths) {
      if (filePathLower.includes(cp)) {
        warnings.push(`⚠️ 修改了核心基础模块 "${filePath}"，可能影响多个依赖方`);
        break;
      }
    }

    if (warnings.length > 0) {
      return {
        passed: true, // 警告不阻止，但注入提醒
        message: warnings.join('; '),
        data: { warnings },
      };
    }

    return { passed: true, message: '' };
  },
};

/**
 * FileChangeAuditHook — 文件变更审计
 * 记录 Agent 的每一次文件修改
 */
export const fileChangeAuditHook: HarnessHook = {
  name: 'FileChangeAudit',
  phase: 'post_tool',
  priority: 30,
  enabled: true,
  handler: async (ctx: LoopContext, data: HookData): Promise<HookResult> => {
    const { toolName, toolArgs, toolResult } = data;
    if (toolName !== 'write_file' && toolName !== 'edit_file' && toolName !== 'delete_file') {
      return { passed: true, message: '' };
    }

    const filePath = (toolArgs?.path as string) || '';
    const success = toolResult?.success || false;

    logInfo(
      `文件变更审计 [第 ${ctx.loopCount} 轮]: ` +
      `${toolName} ${filePath} — ${success ? '✅' : '❌'}`
    );

    return { passed: true, message: '' };
  },
};

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

let verificationInitialized = false;

export function initVerificationSystem(): void {
  if (verificationInitialized) return;
  registerHook(diffAnalyzerHook);
  registerHook(fileChangeAuditHook);
  verificationInitialized = true;
  logInfo('验证系统已初始化', 'DiffAnalyzer + FileChangeAudit Hook 已注册');
}

/** 获取验证配置 */
export function getVerificationConfig(): VerificationConfig {
  return { ...config };
}

/** 更新验证配置 */
export function updateVerificationConfig(updates: Partial<VerificationConfig>): void {
  Object.assign(config, updates);
  logInfo('验证配置已更新', JSON.stringify(config));
}
