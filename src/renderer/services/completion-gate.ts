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

/** 系统提示词注入检测：防止模型在回复中尝试注入 prompt */
const promptInjectionCheck: CompletionCheck = {
  name: 'promptInjection',
  description: '检测回复中是否包含疑似 prompt injection 内容',
  check: async (ctx: LoopContext) => {
    const injectionPatterns = [
      /ignore\s+(all\s+)?(previous|above)\s+instructions/i,
      /you\s+are\s+now\s+(a|an)\s+/i,
      /new\s+system\s*prompt/i,
      /forget\s+(all\s+)?(previous|above)/i,
      /\[SOUL\.md\]/,
      /\[AGENT\.md\]/,
    ];
    for (const pattern of injectionPatterns) {
      if (pattern.test(ctx.content)) {
        return {
          passed: false,
          reason: '回复中包含疑似 prompt injection 内容（试图覆盖系统提示词）。请移除相关内容后重新回答。'
        };
      }
    }
    return { passed: true, reason: '' };
  },
};

/** 工具幻觉检测：模型声称完成了某操作但该工具从未被调用 */
const toolHallucinationCheck: CompletionCheck = {
  name: 'toolHallucination',
  description: '检测模型是否编造了工具调用结果',
  check: async (ctx: LoopContext) => {
    const calledTools = new Set(ctx.allToolRecords.map(r => r.name));
    const content = ctx.content;

    // ── 统一的"声称 → 必需工具"映射表（覆盖全部 40 个工具）──
    const CLAIM_RULES: Array<{ patterns: RegExp[]; requiredTools: string[]; label: string }> = [
      // 文件写入
      { patterns: [/已写入文件/, /已创建文件/, /文件已生成/, /已保存到/, /已成功创建/, /成功写入/,
                   /文件.*已.*创建/, /文件.*已.*写入/, /生成.*文件/, /写入.*工作空间/],
        requiredTools: ['write_file'], label: '写入/创建文件' },
      // 文件读取（仅匹配明确声称调用了 read_file 工具的场景）
      { patterns: [/用read_file读取了/, /调用read_file.*读取/, /通过read_file工具/,
                   /使用read_file.*查看了/, /read_file.*工具.*读取了/],
        requiredTools: ['read_file', 'read_multiple_files'], label: '读取文件' },
      // 文件编辑
      { patterns: [/已修改文件/, /已编辑文件/, /文件已更新/, /已替换.*内容/,
                   /修改了.*文件/, /更新了.*文件/],
        requiredTools: ['edit_file', 'write_file'], label: '编辑/修改文件' },
      // 文件删除
      { patterns: [/已删除文件/, /已移除文件/, /文件已清除/, /删除了.*文件/],
        requiredTools: ['delete_file'], label: '删除文件' },
      // 文件移动/复制/重命名
      { patterns: [/已移动文件/, /已复制文件/, /已重命名/, /文件.*已.*移动/, /文件.*已.*复制/],
        requiredTools: ['move_file', 'copy_file'], label: '移动/复制文件' },
      // 目录浏览
      { patterns: [/目录包含/, /列出.*目录/, /目录.*结构/, /文件列表.*如下/, /目录.*内容/],
        requiredTools: ['list_directory', 'tree'], label: '列出目录' },
      // 文件搜索
      { patterns: [/搜索到.*文件/, /找到.*匹配/, /搜索.*结果.*文件/],
        requiredTools: ['search_files'], label: '搜索文件' },
      // 搜索/抓取
      { patterns: [/搜索结果显示/, /根据搜索/, /抓取了.*网页/, /从.*搜索.*得到/,
                   /查询到/, /检索到/, /搜索到/, /网络.*显示/, /实时.*数据.*显示/],
        requiredTools: ['web_search', 'web_fetch'], label: '搜索/抓取网页' },
      // 浏览器
      { patterns: [/浏览器截图显示/, /打开网页.*看到/, /页面显示/, /浏览器.*打开/,
                   /点击了.*按钮/, /输入了.*文本/, /页面.*截图/],
        requiredTools: ['browser_open', 'browser_screenshot', 'browser_extract', 'browser_click', 'browser_type'], label: '浏览器操作' },
      // 命令执行
      { patterns: [/运行.*命令/, /执行.*脚本/, /命令.*输出/, /运行结果/, /命令.*返回/,
                   /执行.*结果/, /终端.*显示/],
        requiredTools: ['run_command'], label: '执行命令' },
      // Git 操作
      { patterns: [/已提交/, /已推送/, /已暂存/, /已创建分支/, /已合并/, /已克隆/,
                   /git.*commit/, /git.*push/, /git.*add/, /提交了.*代码/],
        requiredTools: ['git'], label: 'Git 操作' },
      // 下载文件
      { patterns: [/已下载文件/, /下载完成/, /文件.*已.*下载/, /从.*下载/],
        requiredTools: ['download_file'], label: '下载文件' },
      // 压缩/解压
      { patterns: [/已压缩/, /已解压/, /压缩完成/, /解压完成/, /归档.*已.*创建/],
        requiredTools: ['compress'], label: '压缩/解压' },
      // 文件信息
      { patterns: [/文件.*大小.*字节/, /文件.*权限.*为/, /文件.*修改日期/],
        requiredTools: ['get_file_info'], label: '获取文件信息' },
      // 内存/记忆操作
      { patterns: [/已记住/, /已添加记忆/, /记忆已保存/, /已更新记忆/, /已删除记忆/],
        requiredTools: ['memory'], label: '记忆操作' },
      // 会话操作
      { patterns: [/历史会话.*显示/, /已读取.*会话/, /会话.*内容.*如下/],
        requiredTools: ['session_list', 'session_read'], label: '会话操作' },
      // 子代理
      { patterns: [/子代理.*完成/, /子任务.*已.*执行/, /spawn.*task.*完成/],
        requiredTools: ['spawn_task'], label: '子代理委派' },
      // 系统工具
      { patterns: [/计算.*结果.*为/, /哈希.*值.*为/, /UUID.*生成/, /随机.*生成.*为/],
        requiredTools: ['calculator', 'hash', 'uuid', 'random'], label: '系统工具' },
    ];

    for (const rule of CLAIM_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(content)) {
          const anyCalled = rule.requiredTools.some(t => calledTools.has(t));
          if (!anyCalled) {
            // 写后读豁免：write_file 已调用时，read_file 的声称通常是读取写入结果的自然表述，不阻断
            if (rule.label === '读取文件' && calledTools.has('write_file')) {
              return { passed: true, reason: '' };
            }
            const toolList = rule.requiredTools.join(' / ');
            return {
              passed: false,
              reason: `回复声称进行了"${rule.label}"操作，但 ${toolList} 工具从未被调用。请实际调用 ${toolList} 来完成任务，不要编造结果。`
            };
          }
          break; // 该类别匹配到了且工具已调用，跳出
        }
      }
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
  'promptInjection',
  'toolHallucination',
]);

/** 阻断级检查：不通过时强制模型重新回答 */
const CRITICAL_CHECKS = new Set([
  'toolHallucination',
  'promptInjection',
]);

/** 注册表 */
const checkRegistry = new Map<string, CompletionCheck>([
  ['contentQuality', contentQualityCheck],
  ['toolResultReview', toolResultReviewCheck],
  ['notThinking', notThinkingCheck],
  ['contextEfficiency', contextEfficiencyCheck],
  ['promptInjection', promptInjectionCheck],
  ['toolHallucination', toolHallucinationCheck],
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
  /** 是否为阻断级失败（必须重新回答） */
  critical: boolean;
  /** 各项检查的详细结果 */
  details: Array<{ name: string; passed: boolean; reason: string; durationMs: number }>;
}

/**
 * 运行完成门控检查
 */
export async function runCompletionGate(ctx: LoopContext): Promise<GateResult> {
  const checks = getEnabledChecks();
  if (checks.length === 0) {
    return { passed: true, reason: '', critical: false, details: [] };
  }

  const details: GateResult['details'] = [];

  // 关键检查优先（幻觉/注入），咨询检查在后
  const sorted = [...checks].sort((a, b) => {
    const aCrit = CRITICAL_CHECKS.has(a.name) ? 0 : 1;
    const bCrit = CRITICAL_CHECKS.has(b.name) ? 0 : 1;
    return aCrit - bCrit;
  });

  for (const check of sorted) {
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
        const isCritical = CRITICAL_CHECKS.has(check.name);
        logWarn(`Completion Gate: "${check.name}" ${isCritical ? '🔴阻断' : '🟡咨询'} — ${result.reason}`);
        return {
          passed: false,
          reason: result.reason,
          critical: isCritical,
          details,
        };
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

  return { passed: true, reason: '', critical: false, details };
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
