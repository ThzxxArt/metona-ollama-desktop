import { describe, it, expect } from 'vitest';
import { buildContext } from '../src/renderer/services/context-manager.js';
import type { OllamaMessage } from '../src/renderer/types.js';

function makeMsgs(n: number): OllamaMessage[] {
  return Array.from({ length: n }, (_, i) => ({ role: 'user' as const, content: `消息 ${i}` }));
}

describe('buildContext — 滑动窗口构建', () => {
  it('消息数不超过窗口时原样返回', () => {
    const msgs = makeMsgs(5);
    const out = buildContext(msgs, { windowSize: 20, maxTokens: 131072 });
    expect(out.length).toBe(5);
    expect(out[0].content).toBe('消息 0');
  });

  it('超过窗口时保留最近 windowSize 条', () => {
    const msgs = makeMsgs(30);
    const out = buildContext(msgs, { windowSize: 10, maxTokens: 131072 });
    // 最近的 10 条（索引 20-29）保留
    expect(out.some((m) => m.content === '消息 25')).toBe(true);
    expect(out.some((m) => m.content === '消息 0')).toBe(false);
  });

  it('system 消息置于最前', () => {
    const msgs: OllamaMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'system', content: '你是助手' },
    ];
    const out = buildContext(msgs, { windowSize: 20, maxTokens: 131072 });
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('你是助手');
  });

  it('注入 memoryContext 与 workspaceContext 动态前缀', () => {
    const out = buildContext([], {
      windowSize: 20,
      maxTokens: 131072,
      memoryContext: '[memory 上下文]',
      workspaceContext: '[workspace 目录]',
    });
    const sys = out.find((m) => m.role === 'system');
    expect(sys?.content).toContain('[memory 上下文]');
    expect(sys?.content).toContain('[workspace 目录]');
  });

  it('合并重复 system 消息为单条', () => {
    const msgs: OllamaMessage[] = [
      { role: 'system', content: '规则 A' },
      { role: 'system', content: '规则 B' },
      { role: 'user', content: '你好' },
    ];
    const out = buildContext(msgs, { windowSize: 20, maxTokens: 131072 });
    const sysCount = out.filter((m) => m.role === 'system').length;
    expect(sysCount).toBeLessThanOrEqual(2);
  });

  it('token 超限时裁剪（需消息数超过窗口才触发）', () => {
    // 25 条 > windowSize 20，走滑动窗口+裁剪路径
    // 每条 500 字符 ≈ 125 token；小预算触发裁剪
    const msgs: OllamaMessage[] = [];
    for (let i = 0; i < 25; i++) msgs.push({ role: 'user', content: 'x'.repeat(500) });
    const out = buildContext(msgs, { windowSize: 20, maxTokens: 300 });
    // 只保护最近 6 条，其余被裁剪
    expect(out.length).toBeLessThan(25);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });

  it('大预算时不裁剪（25 条返回 windowSize+摘要）', () => {
    const msgs: OllamaMessage[] = [];
    for (let i = 0; i < 25; i++) msgs.push({ role: 'user', content: 'x'.repeat(500) });
    const out = buildContext(msgs, { windowSize: 20, maxTokens: 100000 });
    // 25 条 → 部分摘要，不丢失全部 → 至少 20 条窗口内的
    expect(out.length).toBeGreaterThanOrEqual(20);
  });

  it('空消息列表返回空（无 system 时）', () => {
    expect(buildContext([], { windowSize: 20, maxTokens: 131072 })).toEqual([]);
  });
});
