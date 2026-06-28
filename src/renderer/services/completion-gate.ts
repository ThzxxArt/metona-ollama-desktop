/**
 * Completion Gate — 完成门控模块
 * Harness Engineering: 在 Agent 输出最终答案前进行结构化检查
 *
 * 设计理念：
 * - 计算性反馈优先（规则驱动、毫秒级、100% 可靠）
 * - 推理性反馈补充（AI 判断、秒级、非确定）
 * - 所有检查项可独立开关
 */

import { logWarn, logInfo } from './log-service.js';
import { estimateTokens } from './context-manager.js';
import type { LoopContext, CompletionCheck } from '../types.js';

// ═══════════════════════════════════════════════════════════════
// 内置检查项
// ═══════════════════════════════════════════════════════════════

/** 内容质量检查：回复不应过短或不完整 */
const contentQualityCheck: CompletionCheck = {
  name: 'contentQuality',
  description: '检查回复长度和质量是否达到最低标准',
  check: async (ctx: LoopContext) => {
    if (ctx.content.length < 50) {
      return { passed: false, reason: '回复内容过短（<50字），可能不完整。请给出更详细的最终回答。' };
    }
    return { passed: true, reason: '' };
  },
};

/** 工具结果审查：是否存在未处理的工具错误 */
const toolResultReviewCheck: CompletionCheck = {
  name: 'toolResultReview',
  description: '检查是否存在未处理的工具执行错误',
  check: async (ctx: LoopContext) => {
    const errorRecords = ctx.allToolRecords.filter(r => r.status === 'error');
    if (errorRecords.length === 0) return { passed: true, reason: '' };

    // 检查这些错误是否在最近的上下文中被讨论过
    const recentContent = ctx.messages.slice(-5).map(m => m.content || '').join(' ');
    const unresolvedErrors = errorRecords.filter(r => {
      const errorName = r.name;
      return !recentContent.includes(errorName + ' 失败')
        && !recentContent.includes(errorName + ' error')
        && !recentContent.includes(errorName + ' 错误');
    });

    if (unresolvedErrors.length > 0) {
      return {
        passed: false,
        reason: `存在 ${unresolvedErrors.length} 个未处理的工具错误: ${unresolvedErrors.map(r => r.name).join(', ')}。请说明这些错误的影响或提供替代方案。`
      };
    }
    return { passed: true, reason: '' };
  },
};

/** 思考阶段检测：回复不应仍在"思考中"状态 */
const notThinkingCheck: CompletionCheck = {
  name: 'notThinking',
  description: '检查回复是否已从思考阶段过渡到结论阶段',
  check: async (ctx: LoopContext) => {
    // 仅检查短回复（<200字）——长回复几乎肯定是完整回答
    if (ctx.content.length > 200) return { passed: true, reason: '' };

    const contentLower = ctx.content.slice(0, 100).toLowerCase();
    const thinkingMarkers = ['让我看看', '观察一下', '先检查一下', '我需要先', '正在分析', '让我再'];
    const continuationSignals = ctx.content.endsWith('...') || ctx.content.endsWith('等等') || ctx.content.endsWith('…');
    const conclusionMarkers = [
      /Final\s*Answer/i, /最终答案/, /最终回答/, /总结/, /任务完成/, /以上就是/,
      /以上[是为]/, /我的能力/, /可以帮你/, /能够/, /我是/, /以下[是为]/,
    ];

    const hasConclusion = conclusionMarkers.some(p => p.test(ctx.content));
    if (hasConclusion) return { passed: true, reason: '' };

    const thinkingCount = thinkingMarkers.filter(m => contentLower.includes(m)).length;
    const isClearlyThinking = thinkingCount >= 2 || (thinkingCount >= 1 && continuationSignals);

    if (isClearlyThinking) {
      return {
        passed: false,
        reason: '回复看起来仍在思考阶段（短回复 + 思考动词 + 无结论标志），请基于已有结果给出明确的结论。'
      };
    }
    return { passed: true, reason: '' };
  },
};

/** 上下文效率检查：是否存在过度调用工具 */
const contextEfficiencyCheck: CompletionCheck = {
  name: 'contextEfficiency',
  description: '检查工具调用效率是否合理（避免过度调用）',
  check: async (ctx: LoopContext) => {
    const toolMessages = ctx.messages.filter(m => m.role === 'tool');
    const nonToolMessages = ctx.messages.filter(m => m.role !== 'tool' && m.role !== 'system');

    if (toolMessages.length > nonToolMessages.length * 3 && ctx.loopCount > 5) {
      return {
        passed: false,
        reason: `工具调用过多（${toolMessages.length} 次 vs ${nonToolMessages.length} 次非工具消息），可能存在重复或低效的工具调用。请检查是否可以直接基于已有结果给出回答。`
      };
    }
    return { passed: true, reason: '' };
  },
};

// ═══════════════════════════════════════════════════════════════
// 检查项注册与管理
// ═══════════════════════════════════════════════════════════════

/** 默认启用的检查项 */
const DEFAULT_ENABLED_CHECKS = new Set([
  'contentQuality',
  'toolResultReview',
  'notThinking',
]);

/** 注册表 */
const checkRegistry = new Map<string, CompletionCheck>([
  ['contentQuality', contentQualityCheck],
  ['toolResultReview', toolResultReviewCheck],
  ['notThinking', notThinkingCheck],
  ['contextEfficiency', contextEfficiencyCheck],
]);

/** 已启用的检查项 */
const enabledChecks = new Set(DEFAULT_ENABLED_CHECKS);

/** 注册自定义检查项 */
export function registerCompletionCheck(check: CompletionCheck): void {
  checkRegistry.set(check.name, check);
  logInfo(`Completion Gate: 注册检查项 "${check.name}"`);
}

/** 移除检查项 */
export function unregisterCompletionCheck(name: string): void {
  checkRegistry.delete(name);
  enabledChecks.delete(name);
}

/** 启用/禁用检查项 */
export function setCheckEnabled(name: string, enabled: boolean): void {
  if (enabled) {
    if (checkRegistry.has(name)) enabledChecks.add(name);
  } else {
    enabledChecks.delete(name);
  }
}

/** 获取所有已注册检查项 */
export function getRegisteredChecks(): CompletionCheck[] {
  return Array.from(checkRegistry.values());
}

/** 获取已启用的检查项 */
export function getEnabledChecks(): CompletionCheck[] {
  return getRegisteredChecks().filter(c => enabledChecks.has(c.name));
}

// ═══════════════════════════════════════════════════════════════
// 执行门控
// ═══════════════════════════════════════════════════════════════

export interface GateResult {
  passed: boolean;
  reason: string;
  /** 各项检查的详细结果 */
  details: Array<{ name: string; passed: boolean; reason: string; durationMs: number }>;
}

/**
 * 运行完成门控检查
 */
export async function runCompletionGate(ctx: LoopContext): Promise<GateResult> {
  const checks = getEnabledChecks();
  if (checks.length === 0) {
    return { passed: true, reason: '', details: [] };
  }

  const details: GateResult['details'] = [];

  for (const check of checks) {
    const start = Date.now();
    try {
      const result = await check.check(ctx);
      details.push({
        name: check.name,
        passed: result.passed,
        reason: result.reason,
        durationMs: Date.now() - start,
      });
      if (!result.passed) {
        logWarn(`Completion Gate: "${check.name}" — ${result.reason}`);
        return { passed: false, reason: result.reason, details };
      }
    } catch (err) {
      details.push({
        name: check.name,
        passed: true,
        reason: `检查异常: ${(err as Error).message}`,
        durationMs: Date.now() - start,
      });
    }
  }

  return { passed: true, reason: '', details };
}

/**
 * 生成门控报告（供日志/调试使用）
 */
export function formatGateReport(result: GateResult): string {
  const status = result.passed ? '✅ 通过' : '❌ 未通过';
  let report = `Completion Gate ${status}`;
  if (!result.passed) {
    report += ` — ${result.reason}`;
  }
  report += `\n${'─'.repeat(40)}`;
  for (const d of result.details) {
    const icon = d.passed ? '✅' : '❌';
    report += `\n${icon} ${d.name}: ${d.reason || '通过'} (${d.durationMs}ms)`;
  }
  return report;
}
