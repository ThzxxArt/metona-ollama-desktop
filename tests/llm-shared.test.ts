import { describe, it, expect } from 'vitest';
import {
  inferProviderCapabilities,
  normalizeMessages,
  parseToolArguments,
  providerHeaders,
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAIMessages,
} from '../src/main/llm/shared.js';

describe('LLM 共享转换边界', () => {
  it('工具参数解析容错', () => {
    expect(parseToolArguments('not-json')).toEqual({});
    expect(parseToolArguments('[1,2]')).toEqual({});
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments({ b: 2 })).toEqual({ b: 2 });
  });

  it('消息归一化过滤非法字段', () => {
    const normalized = normalizeMessages([
      null,
      { role: 'invalid', content: 'x' },
      { role: 'user', content: 1, images: [1, 'img'], tool_calls: [null, { function: {} }], thinking: 1, tool_name: 2 },
    ]);
    expect(normalized).toEqual([
      {
        role: 'user',
        content: '',
        images: ['img'],
      },
    ]);
  });

  it('OpenAI 转换覆盖无图片、无 tool_calls 与孤立 tool 消息', () => {
    const converted = toOpenAIMessages(
      normalizeMessages([
        { role: 'assistant', content: 'plain' },
        { role: 'user', content: 'hello' },
        { role: 'tool', content: 'orphan', tool_name: 'missing' },
      ]),
    );
    expect(converted[0]).toEqual({ role: 'assistant', content: 'plain' });
    expect(converted[1]).toEqual({ role: 'user', content: 'hello' });
    expect(converted[2].role).toBe('tool');
    expect(converted[2].tool_call_id).toMatch(/^call_/);
  });

  it('Anthropic 转换覆盖空 system、空用户消息、连续同角色与孤立 tool', () => {
    const converted = toAnthropicMessages(
      normalizeMessages([
        { role: 'system', content: '' },
        { role: 'user', content: '' },
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'answer' },
        { role: 'tool', content: 'orphan', tool_name: 'missing' },
      ]),
    );
    expect(converted.system).toBe('');
    expect(converted.messages[0].role).toBe('user');
    expect(converted.messages[0].content).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
    expect(converted.messages[1]).toMatchObject({ role: 'assistant' });
    expect(converted.messages[2].content[0]).toMatchObject({ type: 'tool_result' });
  });

  it('Anthropic 工具转换过滤非法定义', () => {
    expect(toAnthropicTools([])).toBeUndefined();
    expect(
      toAnthropicTools([null, {}, { function: {} }, { function: { name: 'ok', description: 1, parameters: null } }]),
    ).toEqual([{ name: 'ok', description: '', input_schema: { type: 'object', properties: {} } }]);
  });

  it('认证头与能力推断', () => {
    expect(providerHeaders('openai', null)).toEqual({ 'Content-Type': 'application/json' });
    expect(providerHeaders('openai', 'key')).toMatchObject({ Authorization: 'Bearer key' });
    expect(providerHeaders('anthropic', 'key')).toMatchObject({
      'x-api-key': 'key',
      'anthropic-version': '2023-06-01',
      Authorization: 'Bearer key',
    });
    expect(inferProviderCapabilities('claude-4-sonnet')).toEqual(['completion', 'tools', 'vision', 'thinking']);
    expect(inferProviderCapabilities('unknown-model')).toEqual(['completion', 'tools', 'vision', 'thinking']);
  });
});
