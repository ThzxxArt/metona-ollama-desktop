// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isStableSystemMessage,
  reorderSystemMessagesForPrefixCaching,
  extractStructuredSummary,
  mergeSummaries,
  buildContext,
  shouldAutoCompress,
} from '../src/renderer/services/context/builder.js';
import { compressWithLLM } from '../src/renderer/services/context/compressor.js';
import {
  calculateContextStats,
  mergeConsecutiveMessages,
  chooseCompressionStrategy,
  generateTokenReport,
  formatTokenReport,
  recordBudgetUsage,
  setTokenBudgetNumCtx,
  getTokenBudgetStatus,
  resetTokenBudget,
} from '../src/renderer/services/context/metrics.js';
import {
  resetTokenUsageTrend,
  recordTokenUsage,
  recordCompressionMetrics,
  predictContextOverflow,
  getCompressionHistory,
  isAlreadyCompressed,
  markAsCompressed,
  recordActualTokens,
  getAverageCompressionRatio,
} from '../src/renderer/services/context/tokenizer.js';
import type { OllamaMessage } from '../src/renderer/types.js';

function msg(role: OllamaMessage['role'], content: string, extra: Partial<OllamaMessage> = {}): OllamaMessage {
  return { role, content, ...extra };
}

beforeEach(() => {
  resetTokenUsageTrend();
  resetTokenBudget();
});

describe('tokenizer 边界', () => {
  it('压缩哈希空数组、标记与 LRU 淘汰', () => {
    expect(isAlreadyCompressed([])).toBe(true);
    for (let i = 0; i < 101; i++) {
      markAsCompressed([{ role: 'user', content: `hash-${i}` }]);
    }
    expect(isAlreadyCompressed([{ role: 'user', content: 'hash-100' }])).toBe(true);
  });

  it('趋势超过上限时滚动，并在已溢出时把轮次钳制为 0', () => {
    for (let i = 0; i < 105; i++) recordTokenUsage(i, 1000);
    recordTokenUsage(2000, 1000);
    recordTokenUsage(2100, 1000);
    recordTokenUsage(2200, 1000);
    const prediction = predictContextOverflow(1000);
    expect(prediction.turnsToOverflow).toBe(0);
    expect(prediction.level).toBe('critical');
  });

  it('实际 token 校准参数非法时直接返回，空压缩历史平均值为 1', () => {
    expect(() => recordActualTokens(0, 0, 0, 'm')).not.toThrow();
    expect(() => recordActualTokens(10, 0, 0, 'm')).not.toThrow();
    expect(getAverageCompressionRatio()).toBe(1);
  });
});

describe('builder 分支', () => {
  it('稳定 system 消息识别', () => {
    expect(isStableSystemMessage('[SOUL.md]')).toBe(true);
    expect(isStableSystemMessage('[AGENTS.md]')).toBe(true);
    expect(isStableSystemMessage('[USER.md]')).toBe(true);
    expect(isStableSystemMessage('[日期] x')).toBe(true);
    expect(isStableSystemMessage('[环境] x')).toBe(true);
    expect(isStableSystemMessage('安全规则')).toBe(true);
    expect(isStableSystemMessage('系统提示')).toBe(true);
    expect(isStableSystemMessage('You are')).toBe(true);
    expect(isStableSystemMessage('[相关记忆] x')).toBe(false);
    expect(isStableSystemMessage('[历史会话摘要] x')).toBe(false);
    expect(isStableSystemMessage('dynamic')).toBe(false);
  });

  it('system 分区重排：多 system / 单 system / 全稳定 / 全动态', () => {
    const multi = [msg('system', '[SOUL.md]'), msg('system', 'dynamic'), msg('user', 'u')];
    reorderSystemMessagesForPrefixCaching(multi);
    expect(multi[0].content).toContain('[SOUL.md]');

    const single = [msg('system', 'dynamic'), msg('user', 'u')];
    reorderSystemMessagesForPrefixCaching(single);
    expect(single[0].content).toBe('dynamic');

    const allStable = [msg('system', '[SOUL.md]'), msg('system', '[日期]')];
    reorderSystemMessagesForPrefixCaching(allStable);
    expect(allStable[0].content).toContain('[SOUL.md]');

    const allDynamic = [msg('system', 'a'), msg('system', 'b')];
    reorderSystemMessagesForPrefixCaching(allDynamic);
    expect(allDynamic[0].content).toBe('a');
  });

  it('buildContext 无 system / 仅 system / 窗口内', () => {
    expect(buildContext([msg('user', 'u')])[0].role).toBe('user');
    const onlySystem = buildContext([msg('system', 's')]);
    expect(onlySystem).toHaveLength(1);
    const within = buildContext([msg('system', 's'), msg('user', 'u')], { windowSize: 10 });
    expect(within).toHaveLength(2);
  });

  it('buildContext 保留已压缩消息并摘要未压缩消息', () => {
    const messages = [
      msg('system', 's'),
      ...Array.from({ length: 20 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`)),
      msg('user', 'compressed', { compressed: true }),
      ...Array.from({ length: 10 }, (_, i) => msg('user', `recent${i}`)),
    ];
    const out = buildContext(messages, { windowSize: 10, summaryBatchSize: 5, maxTokens: 100000 });
    expect(out.some((m) => m.compressed)).toBe(true);
  });

  it('shouldAutoCompress 计算 tool_calls 与 images 开销', () => {
    const messages = [
      msg('assistant', 'x'.repeat(5000), {
        tool_calls: [{ function: { name: 'read_file', arguments: { path: '/a' } } }] as never,
        images: ['x'],
      }),
    ];
    expect(shouldAutoCompress(messages, 1000)).toBe(true);
  });

  it('extractStructuredSummary / mergeSummaries', () => {
    const summary = extractStructuredSummary([
      msg('user', '📌 主题: a；b\n✅ 决策: c\n⏳ 待办: d\n📏 约束: e\n🧠 知识点: f\n🔧 工具结果: g'),
    ]);
    expect(summary.topics).toEqual(['a', 'b']);
    expect(summary.decisions).toEqual(['c']);
    expect(summary.pendingTasks).toEqual(['d']);
    expect(summary.constraints).toEqual(['e']);
    expect(summary.knowledge).toEqual(['f']);
    expect(summary.toolResults).toEqual(['g']);
    const merged = mergeSummaries(summary, { ...summary, topics: ['h'] });
    expect(merged.topics[0]).toBe('h');
  });

  it('trimByTokenLimit 覆盖工具组、图片、压缩与可用预算不足', () => {
    const messages: OllamaMessage[] = [msg('system', 'system')];
    for (let i = 0; i < 20; i++) {
      messages.push(
        msg('assistant', `a${i}`, {
          tool_calls: [{ function: { name: 'read_file', arguments: { path: '/a' } } }] as never,
          images: ['img'],
        }),
      );
      messages.push(msg('tool', 't'.repeat(100), { tool_name: 'read_file' }));
    }
    messages.push(msg('user', 'compressed', { compressed: true }));
    const out = buildContext(messages, { windowSize: 5, maxTokens: 100 });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].role).toBe('system');

    const out2 = buildContext(messages, { windowSize: 5, maxTokens: 100000 });
    expect(out2.length).toBeGreaterThan(0);
  });

  it('buildContext 仅动态 system 与空 system', () => {
    const out = buildContext([msg('system', 'dynamic'), msg('user', 'u')], { windowSize: 10 });
    expect(out[0].content).toBe('dynamic');
    expect(buildContext([], {})).toEqual([]);
  });
});

describe('compressor 分支', () => {
  function apiReturning(content: string) {
    return {
      chatStream: async (_p: unknown, onChunk: (c: { message: { content: string } }) => void) =>
        onChunk({ message: { content } }),
    };
  }

  const fullSummary = JSON.stringify({
    topics: ['t'],
    decisions: ['d'],
    pendingTasks: ['p'],
    constraints: ['c'],
    knowledge: ['k'],
    toolResults: ['r'],
  });

  it('system 消息分可压缩/不可压缩', async () => {
    const messages = [
      msg('system', '[SOUL.md] soul'),
      msg('system', 'dynamic system'),
      ...Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`)),
    ];
    const out = await compressWithLLM(
      messages,
      apiReturning(
        JSON.stringify({
          topics: ['t'],
          decisions: ['d'],
          pendingTasks: [],
          constraints: [],
          knowledge: [],
          toolResults: [],
        }),
      ) as never,
      'm',
    );
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('soul');
  });

  it('head 以 tool_calls 结尾时把后续 tool 消息并入 head', async () => {
    const messages = [
      msg('assistant', 'head', { tool_calls: [{ function: { name: 'x', arguments: {} } }] as never }),
      msg('tool', 'tool result', { tool_name: 'x' }),
      ...Array.from({ length: 20 }, (_, i) => msg('user', `m${i}`)),
    ];
    const out = await compressWithLLM(messages, apiReturning(fullSummary) as never, 'm');
    expect(out.length).toBeGreaterThan(0);
  });

  it('tail 以 tool 开头时回退到最近 assistant', async () => {
    const messages = [
      ...Array.from({ length: 20 }, (_, i) => msg('user', `m${i}`)),
      msg('assistant', 'a'),
      msg('tool', 't'),
      ...Array.from({ length: 7 }, (_, i) => msg('user', `t${i}`)),
    ];
    const out = await compressWithLLM(messages, apiReturning(fullSummary) as never, 'm');
    expect(out.length).toBeGreaterThan(0);
  });

  it('摘要质量不足时回退文本摘要', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg('user', `m${i}`));
    const out = await compressWithLLM(
      messages,
      apiReturning(
        JSON.stringify({
          topics: [],
          decisions: [],
          pendingTasks: [],
          constraints: [],
          knowledge: [],
          toolResults: [],
        }),
      ) as never,
      'm',
    );
    expect(out.some((m) => m.compressed && m.content.includes('📌 主题'))).toBe(true);
  });

  it('空摘要返回原消息', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg('user', `m${i}`));
    await expect(compressWithLLM(messages, apiReturning('') as never, 'm')).resolves.toBe(messages);
  });

  it('已全部压缩时跳过', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg('user', `m${i}`, { compressed: true }));
    await expect(compressWithLLM(messages, apiReturning('{}') as never, 'm')).resolves.toBe(messages);
  });

  it('head 中压缩的 tool_calls/tool 消息被清理', async () => {
    const messages = [
      msg('assistant', 'head', {
        compressed: true,
        tool_calls: [{ function: { name: 'x', arguments: {} } }] as never,
      }),
      msg('tool', 'tool', { compressed: true, tool_name: 'x' }),
      ...Array.from({ length: 20 }, (_, i) => msg('user', `m${i}`)),
    ];
    const out = await compressWithLLM(messages, apiReturning(fullSummary) as never, 'm');
    expect(out.some((m) => m.compressed)).toBe(true);
  });

  it('tail 以 tool 开头且无 assistant 时丢弃该 tool', async () => {
    const messages = [
      ...Array.from({ length: 20 }, (_, i) => msg('user', `m${i}`)),
      msg('tool', 'orphan', { tool_name: 'x' }),
    ];
    const out = await compressWithLLM(messages, apiReturning(fullSummary) as never, 'm');
    expect(out.length).toBeGreaterThan(0);
  });

  it('已有压缩摘要时合并', async () => {
    const messages = [
      msg('user', '📌 主题: old', { compressed: true }),
      ...Array.from({ length: 20 }, (_, i) => msg('user', `m${i}`)),
    ];
    const out = await compressWithLLM(messages, apiReturning(fullSummary) as never, 'm');
    expect(out.some((m) => m.compressed)).toBe(true);
  });
});

describe('metrics 分支', () => {
  it('压力等级 low/medium/high/critical', () => {
    expect(calculateContextStats([msg('user', 'x')], 100000).pressureInfo.level).toBe('low');
    expect(calculateContextStats([msg('user', 'x'.repeat(3000))], 2000).pressureInfo.level).toBe('medium');
    expect(calculateContextStats([msg('user', 'x'.repeat(5000))], 2000).pressureInfo.level).toBe('high');
    expect(calculateContextStats([msg('user', 'x'.repeat(6000))], 2000).pressureInfo.level).toBe('critical');
  });

  it('消息条数触发压缩', () => {
    const messages = Array.from({ length: 130 }, (_, i) => msg('user', `m${i}`));
    const stats = calculateContextStats(messages, 100000);
    expect(stats.compressDecision.shouldCompress).toBe(true);
    expect(stats.compressDecision.urgency).toBe('low');
  });

  it('预算趋势 increasing/stable/decreasing', () => {
    setTokenBudgetNumCtx(1000);
    recordBudgetUsage(1, 100, 10, 100);
    recordBudgetUsage(2, 200, 10, 200);
    recordBudgetUsage(3, 300, 10, 300);
    expect(getTokenBudgetStatus().trend).toBe('increasing');
    resetTokenBudget();
    recordBudgetUsage(1, 300, 10, 300);
    recordBudgetUsage(2, 300, 10, 300);
    recordBudgetUsage(3, 300, 10, 300);
    expect(getTokenBudgetStatus().trend).toBe('stable');
    resetTokenBudget();
    recordBudgetUsage(1, 300, 10, 300);
    recordBudgetUsage(2, 200, 10, 200);
    recordBudgetUsage(3, 100, 10, 100);
    expect(getTokenBudgetStatus().trend).toBe('decreasing');
  });

  it('合并消息边界：tool/system/ephemeral/compressed/tool_calls/超长', () => {
    expect(mergeConsecutiveMessages([])).toEqual([]);
    expect(
      mergeConsecutiveMessages([
        msg('user', 'a'),
        msg('tool', 't'),
        msg('system', 's'),
        msg('user', 'b', { ephemeral: true }),
        msg('user', 'c', { compressed: true }),
        msg('assistant', 'd', { tool_calls: [] as never }),
        msg('user', 'e'.repeat(4000)),
        msg('user', 'f'.repeat(4000)),
      ]).length,
    ).toBeGreaterThan(1);
  });

  it('压缩策略所有分支', () => {
    expect(chooseCompressionStrategy([msg('user', 'x')], 1000, 'low').strategy).toBe('skip');
    expect(
      chooseCompressionStrategy(
        Array.from({ length: 10 }, () => msg('tool', 'x')),
        1000,
        'medium',
      ).strategy,
    ).toBe('fast');
    expect(chooseCompressionStrategy([msg('user', 'x')], 1000, 'medium').strategy).toBe('medium');
    expect(chooseCompressionStrategy([msg('user', 'x')], 1000, 'critical').strategy).toBe('llm');
    expect(chooseCompressionStrategy([msg('user', 'x')], 1000, 'low').strategy).toBe('skip');
  });

  it('Token 报告无警告与有警告', () => {
    const clean = generateTokenReport(100000);
    expect(formatTokenReport(clean)).toContain('Token Usage Report');
    recordBudgetUsage(1, 900, 100, 900);
    const warned = generateTokenReport(1000);
    expect(warned.warnings.length).toBeGreaterThan(0);
    expect(warned.budget.peakUtilization).toBeGreaterThan(0);
    expect(warned.budget.currentUtilization).toBeGreaterThan(0);
  });

  it('预算趋势 decreasing 与空历史', () => {
    resetTokenBudget();
    expect(getTokenBudgetStatus().trend).toBe('stable');
    recordBudgetUsage(1, 300, 1, 300);
    recordBudgetUsage(2, 200, 1, 200);
    recordBudgetUsage(3, 100, 1, 100);
    expect(getTokenBudgetStatus().trend).toBe('decreasing');
  });

  it('压缩效率低时报告给出警告', () => {
    recordCompressionMetrics({
      beforeMessages: 10,
      afterMessages: 9,
      beforeTokens: 100,
      afterTokens: 90,
      compressionRatio: 0.9,
      timestamp: 1,
    });
    expect(generateTokenReport(1000).warnings.some((w) => w.includes('压缩效率'))).toBe(true);
  });

  it('趋势下降/持平时不预测溢出', () => {
    resetTokenUsageTrend();
    recordTokenUsage(900, 10000);
    recordTokenUsage(800, 10000);
    recordTokenUsage(700, 10000);
    expect(predictContextOverflow(10000).turnsToOverflow).toBe(-1);
    resetTokenUsageTrend();
    recordTokenUsage(100, 10000);
    recordTokenUsage(100, 10000);
    recordTokenUsage(100, 10000);
    expect(predictContextOverflow(10000).turnsToOverflow).toBe(-1);
  });

  it('压缩历史超过上限时滚动', () => {
    for (let i = 0; i < 25; i++) {
      recordCompressionMetrics({
        beforeMessages: 10,
        afterMessages: 5,
        beforeTokens: 100,
        afterTokens: 50,
        compressionRatio: 0.5,
        timestamp: i,
      });
    }
    expect(getCompressionHistory()).toHaveLength(20);
  });
});
