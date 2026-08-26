import { describe, it, expect, beforeEach } from 'vitest';
import {
  estimateTokens,
  recordActualTokens,
  scoreMessageImportance,
  mergeConsecutiveMessages,
  chooseCompressionStrategy,
  getAdaptiveCompressThreshold,
  shouldAutoCompress,
  calculateContextStats,
} from '../src/renderer/services/context-manager.js';
import type { OllamaMessage } from '../src/renderer/types.js';

describe('estimateTokens', () => {
  it('空文本为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('估算中文与英文差异', () => {
    const zh = estimateTokens('你好世界');
    const en = estimateTokens('hello world');
    expect(zh).toBeGreaterThan(0);
    expect(en).toBeGreaterThan(0);
    // 中文按 1.5 字/token，4 字约 2-3 token
    expect(zh).toBeLessThanOrEqual(3);
  });

  it('校准样本不足时不应用比例（保持原始估算）', () => {
    // 未调 recordActualTokens 前，校准样本为 0，原始估算
    expect(estimateTokens('abc')).toBe(Math.ceil(3 / 4));
  });
});

describe('getAdaptiveCompressThreshold', () => {
  it('小上下文模型更早触发', () => {
    expect(getAdaptiveCompressThreshold(4096)).toBe(0.55);
  });
  it('中上下文使用标准阈值', () => {
    expect(getAdaptiveCompressThreshold(16384)).toBe(0.5);
  });
  it('大上下文稍晚触发', () => {
    expect(getAdaptiveCompressThreshold(65536)).toBe(0.45);
  });
});

describe('scoreMessageImportance', () => {
  it('SOUL.md 与参考数据不可压缩（满 10 分）', () => {
    const m: OllamaMessage = { role: 'system', content: '[SOUL.md]\nxxx' };
    expect(scoreMessageImportance(m)).toBe(10);
  });

  it('含 REFERENCE_DATA 标记的满 10 分', () => {
    const m: OllamaMessage = { role: 'system', content: '<<<REFERENCE_DATA_START>>>' };
    expect(scoreMessageImportance(m)).toBe(10);
  });

  it('日期/环境消息满 10 分', () => {
    expect(scoreMessageImportance({ role: 'system', content: '[日期] 2026年' })).toBe(10);
    expect(scoreMessageImportance({ role: 'system', content: '[环境] 运行环境' })).toBe(10);
  });

  it('ephemeral 消息权重为 0（优先丢弃）', () => {
    const m: OllamaMessage = { role: 'user', content: '临时提醒', ephemeral: true };
    expect(scoreMessageImportance(m)).toBe(0);
  });

  it('用户消息高于默认权重', () => {
    const user = scoreMessageImportance({ role: 'user', content: '普通用户消息' });
    const assistant = scoreMessageImportance({ role: 'assistant', content: '普通助手消息' });
    expect(user).toBeGreaterThan(assistant);
  });

  it('工具调用消息加分', () => {
    const m: OllamaMessage = { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: {} } }] };
    const base = scoreMessageImportance({ role: 'assistant', content: 'hello' });
    expect(scoreMessageImportance(m)).toBeGreaterThan(base);
  });
});

describe('mergeConsecutiveMessages', () => {
  it('合并连续 user 消息', () => {
    const msgs: OllamaMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 's' },
    ];
    const out = mergeConsecutiveMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain('a');
    expect(out[0].content).toContain('b');
  });

  it('不合并 tool / system / ephemeral / compressed 消息', () => {
    const msgs: OllamaMessage[] = [
      { role: 'tool', content: 't1', tool_name: 'read_file' },
      { role: 'tool', content: 't2', tool_name: 'read_file' },
    ];
    expect(mergeConsecutiveMessages(msgs)).toHaveLength(2);
  });

  it('超过 3000 字符限制时不合并', () => {
    const long = 'x'.repeat(2000);
    const msgs: OllamaMessage[] = [
      { role: 'user', content: long },
      { role: 'user', content: long },
    ];
    expect(mergeConsecutiveMessages(msgs)).toHaveLength(2);
  });

  it('空/单消息原样返回', () => {
    expect(mergeConsecutiveMessages([])).toEqual([]);
    expect(mergeConsecutiveMessages([{ role: 'user', content: 'a' }])).toHaveLength(1);
  });
});

describe('chooseCompressionStrategy', () => {
  const numCtx = 131072;

  it('压力低且消息少时跳过压缩', () => {
    const d = chooseCompressionStrategy([], numCtx, 'low');
    expect(d.strategy).toBe('skip');
  });

  it('工具结果占比高且非 critical 时用 fast', () => {
    const msgs: OllamaMessage[] = [
      { role: 'tool', content: 'x'.repeat(50), tool_name: 'read_file' },
      { role: 'tool', content: 'y'.repeat(50), tool_name: 'read_file' },
      { role: 'user', content: 'q' },
    ];
    const d = chooseCompressionStrategy(msgs, numCtx, 'high');
    expect(d.strategy).toBe('fast');
  });

  it('critical 压力用 llm', () => {
    const d = chooseCompressionStrategy([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }], numCtx, 'critical');
    expect(d.strategy).toBe('llm');
  });

  it('中等压力用 medium', () => {
    const d = chooseCompressionStrategy([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], numCtx, 'medium');
    expect(d.strategy).toBe('medium');
  });
});

describe('shouldAutoCompress', () => {
  it('超阈值触发', () => {
    // 构造大量内容使 token 超 50% numCtx
    const msgs: OllamaMessage[] = [];
    for (let i = 0; i < 50; i++) msgs.push({ role: 'assistant', content: '内容'.repeat(400) });
    expect(shouldAutoCompress(msgs, 8192)).toBe(true);
  });

  it('少量消息不触发', () => {
    const msgs: OllamaMessage[] = [{ role: 'user', content: 'hello' }];
    expect(shouldAutoCompress(msgs, 131072)).toBe(false);
  });
});

describe('calculateContextStats', () => {
  it('计算总 token 与使用率', () => {
    const msgs: OllamaMessage[] = [{ role: 'user', content: 'hello world' }];
    const stats = calculateContextStats(msgs, 131072);
    expect(stats.totalTokens).toBeGreaterThan(0);
    expect(stats.usageRatio).toBeGreaterThan(0);
    expect(stats.usageRatio).toBeLessThan(0.01);
    expect(stats.messageCount).toBe(1);
  });

  it('空消息列表给出低压力', () => {
    const stats = calculateContextStats([], 131072);
    expect(stats.pressureInfo.level).toBe('low');
    expect(stats.compressDecision.shouldCompress).toBe(false);
  });
});

// 校准记录后的估算比例（重置校准状态：通过重新导入不可行，这里仅验证不抛错）
describe('recordActualTokens', () => {
  it('记录实际 token 不抛错', () => {
    expect(() => recordActualTokens(100, 50, 90, 'test-model')).not.toThrow();
  });
});
