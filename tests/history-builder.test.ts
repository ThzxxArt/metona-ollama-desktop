import { describe, it, expect } from 'vitest';
import { buildHistoryMessages } from '../src/renderer/services/history-builder.js';
import type { ChatMessage } from '../src/renderer/types.js';

function userMsg(content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { role: 'user', content, timestamp: Date.now(), ...over };
}

function assistantMsg(content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { role: 'assistant', content, timestamp: Date.now(), ...over };
}

describe('buildHistoryMessages — 历史消息构建', () => {
  it('排除末尾的当前用户消息（防止重复注入）', () => {
    const msgs = [
      userMsg('第一轮问题'),
      assistantMsg('第一轮回答'),
      userMsg('当前轮问题'), // 当前输入，必须被排除
    ];
    const out = buildHistoryMessages(msgs, 30);
    expect(out.some(m => m.role === 'user' && m.content === '当前轮问题')).toBe(false);
    expect(out.some(m => m.content === '第一轮问题')).toBe(true);
    expect(out.some(m => m.content === '第一轮回答')).toBe(true);
  });

  it('当前用户消息之后的孤立消息一并排除', () => {
    const msgs = [
      userMsg('历史'),
      userMsg('当前轮'),
      assistantMsg('当前轮的回复'), // 位于当前输入之后，不属于历史
    ];
    const out = buildHistoryMessages(msgs, 30);
    expect(out.some(m => m.content === '当前轮的回复')).toBe(false);
    expect(out.some(m => m.content === '历史')).toBe(true);
  });

  it('当前用户消息的 _apiContent 不进入历史（由 handleInit 重新注入）', () => {
    const msgs = [
      userMsg('第一轮'),
      assistantMsg('第一轮回答'),
      userMsg('当前轮', { _apiContent: '{"file_name":"a.txt","context":"..."}' } as Partial<ChatMessage>),
    ];
    const out = buildHistoryMessages(msgs, 30);
    expect(JSON.stringify(out)).not.toContain('file_name');
  });

  it('用户消息优先使用 _apiContent（附件结构化数据）', () => {
    const msgs = [
      userMsg('显示文本', { _apiContent: '{"file_name":"a.txt"}' } as Partial<ChatMessage>),
      assistantMsg('回答'),
      userMsg('当前轮'),
    ];
    const out = buildHistoryMessages(msgs, 30);
    const first = out.find(m => m.role === 'user')!;
    expect(first.content).toBe('{"file_name":"a.txt"}');
  });

  it('注入 assistant 的 tool_calls 与 role:tool 结果信封', () => {
    const msgs = [
      userMsg('读一下'),
      assistantMsg('', {
        toolCalls: [{
          name: 'read_file',
          arguments: { path: 'a.txt' },
          result: { success: true, path: 'a.txt', content: 'hello' },
          status: 'success',
          timestamp: Date.now(),
        }],
      }),
      userMsg('当前轮'),
    ];
    const out = buildHistoryMessages(msgs, 30);
    const assistant = out.find(m => m.role === 'assistant')!;
    expect(assistant.tool_calls?.length).toBe(1);
    expect(assistant.tool_calls![0].function.name).toBe('read_file');
    const toolMsg = out.find(m => m.role === 'tool')!;
    expect(toolMsg.content).toContain('<<<TOOL_RESULT_START name="read_file">>>');
    expect(toolMsg.content).toContain('<<<TOOL_RESULT_END>>>');
    expect(toolMsg.tool_name).toBe('read_file');
  });

  it('无结果的 toolCalls 不产生 tool 消息', () => {
    const msgs = [
      userMsg('问'),
      assistantMsg('', {
        toolCalls: [{ name: 'read_file', arguments: { path: 'a' }, result: null, status: 'pending', timestamp: Date.now() }],
      }),
      userMsg('当前轮'),
    ];
    const out = buildHistoryMessages(msgs, 30);
    expect(out.some(m => m.role === 'tool')).toBe(false);
  });

  it('永不注入 system 消息（系统提示词由 handleInit 统一构建）', () => {
    const msgs = [
      { role: 'system', content: '系统提示词' } as ChatMessage,
      userMsg('历史'),
      assistantMsg('回答'),
      userMsg('当前轮'),
    ];
    const out = buildHistoryMessages(msgs, 30);
    expect(out.some(m => m.role === 'system')).toBe(false);
  });

  it('超过 maxCount 从尾部截取', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`问题${i}`));
      msgs.push(assistantMsg(`回答${i}`));
    }
    msgs.push(userMsg('当前轮'));
    const out = buildHistoryMessages(msgs, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    // 保留的是最近的消息
    expect(JSON.stringify(out)).toContain('回答19');
    expect(JSON.stringify(out)).not.toContain('问题0');
  });

  it('裁剪点不落在 tool 消息上（不产生孤立 tool 结果）', () => {
    const msgs: ChatMessage[] = [userMsg('起点')];
    for (let i = 0; i < 5; i++) {
      msgs.push(assistantMsg('', {
        toolCalls: [{
          name: 'read_file', arguments: { path: `f${i}.txt` },
          result: { success: true, content: `内容${i}` }, status: 'success', timestamp: Date.now(),
        }],
      }));
      msgs.push(userMsg(`追问${i}`));
    }
    const out = buildHistoryMessages(msgs, 5);
    expect(out.length).toBeLessThanOrEqual(5);
    // 首条消息不能是孤立 tool 结果
    expect(out[0].role).not.toBe('tool');
    // 若首条是带 tool_calls 的 assistant，其 tool 结果必须紧随其后
    if (out[0].role === 'assistant' && (out[0] as { tool_calls?: unknown[] }).tool_calls?.length) {
      expect(out[1]?.role).toBe('tool');
    }
  });

  it('空消息列表与无用户消息时安全返回', () => {
    expect(buildHistoryMessages([], 30)).toEqual([]);
    const onlyAssistant = [assistantMsg('只有回答')];
    expect(buildHistoryMessages(onlyAssistant, 30).length).toBe(1);
  });

  it('assistant 的 thinking 映射为 thinking 字段', () => {
    const msgs = [
      userMsg('问'),
      assistantMsg('答', { think: '推理过程' }),
      userMsg('当前轮'),
    ];
    const out = buildHistoryMessages(msgs, 30);
    const assistant = out.find(m => m.role === 'assistant')!;
    expect((assistant as { thinking?: string }).thinking).toBe('推理过程');
  });
});
