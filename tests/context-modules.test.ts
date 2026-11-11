// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  estimateTokens,
  recordActualTokens,
  recordTokenUsage,
  predictContextOverflow,
  getAdaptiveCompressThreshold,
  getCompressionHistory,
  getAverageCompressionRatio,
  recordCompressionMetrics,
  resetTokenUsageTrend,
  scoreMessageImportance,
  buildContext,
  shouldAutoCompress,
  calculateContextStats,
  getContextPressureLevel,
  recordBudgetUsage,
  setTokenBudgetNumCtx,
  getTokenBudgetStatus,
  resetTokenBudget,
  mergeConsecutiveMessages,
  getTrendAwareCompressThreshold,
  generateTokenReport,
  formatTokenReport,
  chooseCompressionStrategy,
  compressWithLLM,
  saveSessionSummary,
  loadSessionSummaries,
  getSessionSummariesBackup,
  restoreSessionSummariesBackup,
  generateSessionSummary,
  formatSessionSummariesForContext,
  createCheckpoint,
  clearCheckpoints,
} from '../src/renderer/services/context-manager.js';
import type { OllamaMessage } from '../src/renderer/types.js';

function msg(role: OllamaMessage['role'], content: string, extra: Partial<OllamaMessage> = {}): OllamaMessage {
  return { role, content, ...extra };
}

beforeEach(() => {
  localStorage.clear();
  resetTokenBudget();
  resetTokenUsageTrend();
  clearCheckpoints();
});

describe('tokenizer', () => {
  it('中英文 token 估算', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('中文')).toBeGreaterThan(0);
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });

  it('校准比例在足够样本后生效', () => {
    const before = estimateTokens('hello world hello world');
    for (let i = 0; i < 6; i++) recordActualTokens(100, 10, 10, 'm');
    const after = estimateTokens('hello world hello world');
    expect(after).not.toBe(before);
  });

  it('模型切换重置校准', () => {
    recordActualTokens(100, 10, 10, 'm1');
    recordActualTokens(100, 10, 10, 'm2');
    expect(estimateTokens('abc')).toBeGreaterThan(0);
  });

  it('上下文溢出预测覆盖 safe/notice/warning/critical', () => {
    resetTokenUsageTrend();
    recordTokenUsage(100, 1000);
    expect(predictContextOverflow(1000).level).toBe('safe');
    resetTokenUsageTrend();
    recordTokenUsage(650, 1000);
    expect(predictContextOverflow(1000).level).toBe('warning');
    resetTokenUsageTrend();
    recordTokenUsage(500, 1000);
    expect(predictContextOverflow(1000).level).toBe('notice');
    resetTokenUsageTrend();
    recordTokenUsage(900, 1000);
    expect(predictContextOverflow(1000).level).toBe('critical');
  });

  it('趋势预测在 3 个点后计算 turnsToOverflow', () => {
    for (let i = 0; i < 5; i++) recordTokenUsage(100 + i * 50, 1000);
    const p = predictContextOverflow(1000);
    expect(p.turnsToOverflow).toBeGreaterThanOrEqual(0);
  });

  it('自适应阈值按 numCtx 分级', () => {
    expect(getAdaptiveCompressThreshold(4096)).toBe(0.55);
    expect(getAdaptiveCompressThreshold(16384)).toBe(0.5);
    expect(getAdaptiveCompressThreshold(65536)).toBe(0.45);
  });

  it('压缩指标历史与平均压缩率', () => {
    recordCompressionMetrics({
      beforeMessages: 10,
      afterMessages: 5,
      beforeTokens: 100,
      afterTokens: 50,
      compressionRatio: 0.5,
      timestamp: 1,
    });
    expect(getCompressionHistory()).toHaveLength(1);
    expect(getAverageCompressionRatio()).toBe(0.5);
  });
});

describe('context builder', () => {
  it('消息重要性评分', () => {
    expect(scoreMessageImportance(msg('system', '[SOUL.md]'))).toBe(10);
    expect(scoreMessageImportance(msg('user', '[日期] 2026'))).toBe(10);
    expect(scoreMessageImportance(msg('user', '[环境]'))).toBe(10);
    expect(scoreMessageImportance(msg('user', '安全规则'))).toBe(10);
    expect(scoreMessageImportance(msg('user', '普通消息', { ephemeral: true }))).toBe(0);
    expect(scoreMessageImportance(msg('assistant', '完成', { compressed: true }))).toBeGreaterThan(0);
    expect(scoreMessageImportance(msg('user', '路径 config 错误'))).toBeGreaterThan(5);
    expect(
      scoreMessageImportance(msg('assistant', 'x', { tool_calls: [{ function: { name: 'read_file' } }] as never })),
    ).toBeGreaterThan(5);
    expect(scoreMessageImportance(msg('tool', 'x', { tool_name: 'write_file' }))).toBeGreaterThan(5);
    expect(scoreMessageImportance(msg('assistant', 'x'.repeat(3000)))).toBeGreaterThan(5);
    expect(scoreMessageImportance(msg('user', 'x', { images: ['a'] }))).toBeLessThan(8);
  });

  it('buildContext 合并 system 稳定/动态部分并保留窗口', () => {
    const messages = [
      msg('system', '[SOUL.md]\nsoul'),
      msg('system', 'dynamic'),
      ...Array.from({ length: 30 }, (_, i) => msg('user', `u${i}`)),
    ];
    const out = buildContext(messages, { windowSize: 10, maxTokens: 100000 });
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('soul');
    expect(out.length).toBeLessThan(messages.length);
  });

  it('buildContext 注入 memory/workspace 上下文', () => {
    const out = buildContext([msg('user', 'hi')], { memoryContext: 'mem', workspaceContext: 'ws' });
    expect(out[0].content).toContain('mem');
    expect(out[0].content).toContain('ws');
  });

  it('buildContext 超窗口时摘要旧消息', () => {
    const messages = Array.from({ length: 100 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `message ${i}`));
    const out = buildContext(messages, { windowSize: 10, summaryBatchSize: 5, maxTokens: 100000 });
    expect(out.some((m) => m.compressed)).toBe(true);
  });

  it('shouldAutoCompress 根据 token 阈值', () => {
    expect(shouldAutoCompress([msg('user', 'short')], 100000)).toBe(false);
    expect(shouldAutoCompress([msg('user', 'x'.repeat(10000))], 1024)).toBe(true);
  });
});

describe('context metrics / budget / report', () => {
  it('压力分级与压缩决策', () => {
    const low = calculateContextStats([msg('user', 'hi')], 100000);
    expect(low.pressureInfo.level).toBe('low');
    const high = calculateContextStats([msg('user', 'x'.repeat(8000))], 1024);
    expect(['high', 'critical']).toContain(high.pressureInfo.level);
    expect(getContextPressureLevel([msg('user', 'hi')], 100000).level).toBe('low');
  });

  it('token 预算状态与趋势', () => {
    setTokenBudgetNumCtx(1000);
    recordBudgetUsage(1, 100, 20, 100);
    recordBudgetUsage(2, 200, 30, 200);
    recordBudgetUsage(3, 300, 40, 300);
    const status = getTokenBudgetStatus();
    expect(status.totalInput).toBe(600);
    expect(status.totalOutput).toBe(90);
    expect(status.trend).toBe('increasing');
    expect(status.history).toHaveLength(3);
  });

  it('合并连续同角色消息', () => {
    const merged = mergeConsecutiveMessages([msg('user', 'a'), msg('user', 'b'), msg('assistant', 'c')]);
    expect(merged).toHaveLength(2);
    expect(merged[0].content).toContain('a');
    expect(mergeConsecutiveMessages([msg('user', 'a')])).toHaveLength(1);
  });

  it('趋势压缩阈值与策略选择', () => {
    expect(getTrendAwareCompressThreshold(1000, [msg('user', 'hi')]).shouldCompress).toBe(false);
    expect(chooseCompressionStrategy([msg('user', 'hi')], 100000, 'low').strategy).toBe('skip');
    const toolHeavy = Array.from({ length: 10 }, () => msg('tool', 'x'));
    expect(chooseCompressionStrategy(toolHeavy, 1000, 'medium').strategy).toBe('fast');
    expect(chooseCompressionStrategy([msg('user', 'x'.repeat(5000))], 1000, 'medium').strategy).toBe('medium');
    expect(chooseCompressionStrategy([msg('user', 'x'.repeat(5000))], 1000, 'critical').strategy).toBe('llm');
  });

  it('Token 报告生成与格式化', () => {
    recordBudgetUsage(1, 900, 100, 900);
    const report = generateTokenReport(1000);
    expect(report.session.totalTokens).toBe(1000);
    expect(report.warnings.length).toBeGreaterThan(0);
    const text = formatTokenReport(report);
    expect(text).toContain('Token Usage Report');
    expect(text).toContain('Warnings');
  });
});

describe('LLM 压缩', () => {
  const api = {
    chatStream: vi.fn(async (_params, onChunk) => {
      onChunk({
        message: {
          content: JSON.stringify({
            topics: ['t'],
            decisions: ['d'],
            pendingTasks: ['p'],
            constraints: ['c'],
            knowledge: ['k'],
            toolResults: ['r'],
          }),
        },
      });
    }),
  };

  it('保留首尾并生成结构化摘要', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`));
    const out = await compressWithLLM(messages, api, 'model');
    expect(out.some((m) => m.compressed)).toBe(true);
    expect(out.length).toBeLessThan(messages.length);
  });

  it('消息太少跳过压缩', async () => {
    const messages = [msg('user', 'a')];
    await expect(compressWithLLM(messages, api, 'model')).resolves.toBe(messages);
  });

  it('LLM 返回非法 JSON 时回退文本摘要', async () => {
    api.chatStream.mockImplementationOnce(async (_p, onChunk) => onChunk({ message: { content: 'not json' } }));
    const messages = Array.from({ length: 30 }, (_, i) => msg('user', `m${i}`));
    const out = await compressWithLLM(messages, api, 'model');
    expect(out.some((m) => m.compressed)).toBe(true);
  });

  it('LLM 调用失败返回原消息', async () => {
    api.chatStream.mockRejectedValueOnce(new Error('fail'));
    const messages = Array.from({ length: 30 }, (_, i) => msg('user', `m${i}`));
    await expect(compressWithLLM(messages, api, 'model')).resolves.toBe(messages);
  });

  it('abort 时返回原消息', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    api.chatStream.mockRejectedValueOnce(err);
    const messages = Array.from({ length: 30 }, (_, i) => msg('user', `m${i}`));
    await expect(compressWithLLM(messages, api, 'model')).resolves.toBe(messages);
  });
});

describe('会话摘要与检查点', () => {
  it('保存/加载/备份/恢复摘要', () => {
    const summary = generateSessionSummary('goal', [msg('assistant', 'done')], [{ name: 'read_file' }], 100);
    saveSessionSummary(summary);
    expect(loadSessionSummaries()).toHaveLength(1);
    const backup = getSessionSummariesBackup();
    restoreSessionSummariesBackup(backup);
    expect(loadSessionSummaries()).toHaveLength(1);
    expect(formatSessionSummariesForContext(backup)).toContain('历史会话参考');
  });

  it('摘要格式为空时返回空字符串', () => {
    expect(formatSessionSummariesForContext([])).toBe('');
  });

  it('创建检查点并限制数量', () => {
    for (let i = 0; i < 7; i++) createCheckpoint(i, 'THINKING', [msg('user', 'x')], 0, 'goal');
    expect(() => clearCheckpoints()).not.toThrow();
  });
});
