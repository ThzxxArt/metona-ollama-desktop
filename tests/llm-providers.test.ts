import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  settings: {
    provider: 'openai' as 'openai' | 'anthropic' | 'ollama',
    openaiUrl: 'https://api.openai.com',
    anthropicUrl: 'https://api.anthropic.com',
    contextLength: 131072,
    maxOutputTokens: 4096,
    requestTimeoutMs: 900_000,
  },
  key: 'sk-test' as string | null,
}));

vi.mock('../src/main/ollama/config.js', () => ({
  loadOllamaSettings: () => hoisted.settings,
}));
vi.mock('../src/main/ollama/secret-store.js', () => ({
  getOllamaSecretStore: () => ({ get: () => hoisted.key }),
}));

import * as openai from '../src/main/llm/openai.js';
import * as anthropic from '../src/main/llm/anthropic.js';
import {
  inferProviderCapabilities,
  normalizeMessages,
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAIMessages,
} from '../src/main/llm/shared.js';

const fetchMock = vi.fn();

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  hoisted.key = 'sk-test';
  hoisted.settings = {
    provider: 'openai',
    openaiUrl: 'https://api.openai.com',
    anthropicUrl: 'https://api.anthropic.com',
    contextLength: 131072,
    maxOutputTokens: 4096,
    requestTimeoutMs: 900_000,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI 兼容适配器', () => {
  it('列出模型并携带 Bearer Key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, {}] }));
    await expect(openai.listModels()).resolves.toEqual({
      models: [{ name: 'gpt-4o' }, { name: 'text-embedding-3-small' }],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect((init.headers as Record<string, string>)['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('Metona-Ollama-Desktop');
  });

  it('测试连接成功与鉴权失败', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'gpt-4o' }] }));
    await expect(openai.testConnection()).resolves.toMatchObject({
      ok: true,
      provider: 'openai',
      modelCount: 1,
    });

    fetchMock.mockResolvedValueOnce(new Response('bad key', { status: 401 }));
    await expect(openai.testConnection()).resolves.toMatchObject({
      ok: false,
      provider: 'openai',
      errorKind: 'auth',
    });
  });

  it('模型能力推断与上下文展示', async () => {
    await expect(openai.showModel('gpt-4o')).resolves.toMatchObject({
      capabilities: expect.arrayContaining(['completion', 'tools', 'vision', 'thinking']),
      model_info: { 'provider.context_length': 131072 },
    });
  });

  it('非流式聊天转换工具调用与用量', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        model: 'gpt-4o',
        choices: [
          {
            message: {
              content: '好的',
              reasoning_content: '先思考',
              tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
      }),
    );

    const result = await openai.chat({
      model: 'gpt-4o',
      session_id: 'session-123',
      system: 'sys',
      messages: [
        { role: 'user', content: '看文件' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
        },
        { role: 'tool', content: '内容', tool_name: 'read_file' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
        },
      ],
    });

    expect(result).toMatchObject({
      model: 'gpt-4o',
      done: true,
      done_reason: 'tool_calls',
      eval_count: 5,
      prompt_eval_count: 10,
      prompt_eval_cached_count: 2,
      message: {
        content: '好的',
        thinking: '先思考',
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
      },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-opencode-session']).toBe('session-123');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o');
    expect(body.max_tokens).toBe(4096);
    expect(body.tools).toHaveLength(1);
    expect((body.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
      role: 'system',
      content: 'sys',
    });
  });

  it('流式聊天合并文本、思考、工具参数与用量', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":4}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const chunks: Array<Record<string, unknown>> = [];
    await openai.chatStream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, (chunk) =>
      chunks.push(chunk as unknown as Record<string, unknown>),
    );

    expect(chunks.some((chunk) => (chunk.message as Record<string, unknown>)?.content === '你')).toBe(true);
    expect(chunks.some((chunk) => (chunk.message as Record<string, unknown>)?.thinking === '想')).toBe(true);
    const final = chunks[chunks.length - 1];
    expect(final).toMatchObject({
      done: true,
      done_reason: 'tool_calls',
      eval_count: 4,
      prompt_eval_count: 8,
      message: {
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
      },
    });
  });

  it('推理模型使用 max_completion_tokens 与 reasoning_effort', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await openai.chat({
      model: 'o3-mini',
      think: 'max',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe('high');
  });

  it('embeddings 解析', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: [1, 2, 3] }] }));
    await expect(openai.embed('text-embedding-3-small', 'hi')).resolves.toEqual({
      embedding: [1, 2, 3],
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
  });
});

describe('Anthropic 兼容适配器', () => {
  it('列出模型并携带 Anthropic 头', async () => {
    hoisted.settings.provider = 'anthropic';
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'claude-sonnet-4-5' }] }));
    await expect(anthropic.listModels()).resolves.toEqual({ models: [{ name: 'claude-sonnet-4-5' }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(init.headers).toMatchObject({
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01',
      Authorization: 'Bearer sk-test',
    });
  });

  it('测试连接与能力推断', async () => {
    hoisted.settings.provider = 'anthropic';
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'claude-sonnet-4-5' }] }));
    await expect(anthropic.testConnection()).resolves.toMatchObject({
      ok: true,
      provider: 'anthropic',
      modelCount: 1,
    });
    await expect(anthropic.showModel('claude-sonnet-4-5')).resolves.toMatchObject({
      capabilities: expect.arrayContaining(['completion', 'tools', 'vision', 'thinking']),
    });
  });

  it('非流式聊天转换 system、工具与 thinking', async () => {
    hoisted.settings.provider = 'anthropic';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'thinking', thinking: '推理' },
          { type: 'text', text: '答案' },
          { type: 'tool_use', id: 'tool_1', name: 'read_file', input: { path: 'a.txt' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 9, output_tokens: 6, cache_read_input_tokens: 2 },
      }),
    );

    const result = await anthropic.chat({
      model: 'claude-sonnet-4-5',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
        },
      ],
    });

    expect(result).toMatchObject({
      done: true,
      done_reason: 'tool_calls',
      eval_count: 6,
      prompt_eval_count: 9,
      prompt_eval_cached_count: 2,
      message: {
        content: '答案',
        thinking: '推理',
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
      },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.system).toBe('sys');
    expect(body.max_tokens).toBe(4096);
    expect(body.tools).toEqual([
      { name: 'read_file', description: 'read', input_schema: { type: 'object', properties: {} } },
    ]);
  });

  it('thinking 模型按档位设置 budget_tokens', async () => {
    hoisted.settings.provider = 'anthropic';
    hoisted.settings.maxOutputTokens = 16384;
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [], stop_reason: 'end_turn' }));
    await anthropic.chat({
      model: 'claude-3-7-sonnet',
      think: 'max',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(16384);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  it('流式聊天解析 text/thinking/tool_use 与用量', async () => {
    hoisted.settings.provider = 'anthropic';
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"read_file","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const chunks: Array<Record<string, unknown>> = [];
    await anthropic.chatStream({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }, (chunk) =>
      chunks.push(chunk as unknown as Record<string, unknown>),
    );

    expect(chunks.some((chunk) => (chunk.message as Record<string, unknown>)?.content === '你好')).toBe(true);
    expect(chunks.some((chunk) => (chunk.message as Record<string, unknown>)?.thinking === '想')).toBe(true);
    expect(chunks[chunks.length - 1]).toMatchObject({
      done: true,
      done_reason: 'tool_calls',
      eval_count: 7,
      prompt_eval_count: 12,
      prompt_eval_cached_count: 3,
      message: {
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
      },
    });
  });

  it('embeddings 明确回退', async () => {
    hoisted.settings.provider = 'anthropic';
    await expect(anthropic.embed('claude', 'hi')).rejects.toThrow('不提供 embeddings');
  });
});

describe('OpenAI 边界分支', () => {
  it('非数组模型列表、空 choices、null content 与 length 停止原因', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: 'bad' }));
    await expect(openai.listModels()).resolves.toEqual({ models: [] });

    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));
    await expect(openai.chat({ model: 'm', messages: [] })).resolves.toMatchObject({
      message: { content: '' },
      done_reason: 'stop',
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: null, reasoning: 'r' }, finish_reason: 'length' }],
      }),
    );
    await expect(openai.chat({ model: 'm', messages: [] })).resolves.toMatchObject({
      message: { content: '', thinking: 'r' },
      done_reason: 'length',
    });
  });

  it('embedding 非数组与缺少 embedding 时返回空向量', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: 'bad' }));
    await expect(openai.embed('m', 'x')).resolves.toEqual({ embedding: [] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: 'bad' }] }));
    await expect(openai.embed('m', 'x')).resolves.toEqual({ embedding: [] });
  });

  it('已中止的 signal 不发起流式请求', async () => {
    const controller = new AbortController();
    controller.abort();
    await openai.chatStream({ model: 'm', messages: [] }, () => {}, controller.signal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('流式无效行、非对象数据与错误事件', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: not-json\n\n',
        'data: 123\n\n',
        'data: {"choices":[null,{"delta":null,"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":"r","tool_calls":[null,{"function":null},{"index":1,"function":{"name":""}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const chunks: Array<Record<string, unknown>> = [];
    await openai.chatStream({ model: 'm', messages: [] }, (chunk) =>
      chunks.push(chunk as unknown as Record<string, unknown>),
    );
    expect(chunks.some((chunk) => (chunk.message as Record<string, unknown>)?.thinking === 'r')).toBe(true);

    fetchMock.mockResolvedValueOnce(sseResponse(['data: {"error":{"message":"boom"}}\n\n']));
    await expect(openai.chatStream({ model: 'm', messages: [] }, () => {})).rejects.toThrow('boom');
  });
});

describe('Anthropic 边界分支', () => {
  it('非数组模型列表、空 content、max_tokens 停止原因与错误响应', async () => {
    hoisted.settings.provider = 'anthropic';
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: 'bad' }));
    await expect(anthropic.listModels()).resolves.toEqual({ models: [] });

    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [], stop_reason: 'max_tokens' }));
    await expect(anthropic.chat({ model: 'm', messages: [] })).resolves.toMatchObject({
      message: { content: '' },
      done_reason: 'length',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'anthropic boom' } }));
    await expect(anthropic.chat({ model: 'm', messages: [] })).rejects.toThrow('anthropic boom');
  });

  it('流式错误事件、无效行与非 message_stop 结束', async () => {
    hoisted.settings.provider = 'anthropic';
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: not-json\n\n',
        'data: 123\n\n',
        'event: error\ndata: {"type":"error","error":{"message":"stream boom"}}\n\n',
      ]),
    );
    await expect(anthropic.chatStream({ model: 'm', messages: [] }, () => {})).rejects.toThrow('stream boom');

    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"message_start","message":{}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":null}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'data: {"type":"message_delta","delta":null}\n\n',
      ]),
    );
    const chunks: Array<Record<string, unknown>> = [];
    await anthropic.chatStream({ model: 'm', messages: [] }, (chunk) =>
      chunks.push(chunk as unknown as Record<string, unknown>),
    );
    expect(chunks[chunks.length - 1]).toMatchObject({ done: true, done_reason: 'stop' });
  });
});

describe('协议消息转换', () => {
  it('OpenAI 补齐 tool_call_id 并转换图片', () => {
    const converted = toOpenAIMessages(
      normalizeMessages([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '看图', images: ['/9j/abc'] },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
        },
        { role: 'tool', content: '结果', tool_name: 'read_file' },
      ]),
    );

    expect(converted[0]).toEqual({ role: 'system', content: 'sys' });
    expect(converted[1].content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/abc' } },
    ]);
    expect(converted[2].tool_calls?.[0].id).toBe(converted[3].tool_call_id);
  });

  it('Anthropic 转换 system、图片、tool_use 与 tool_result', () => {
    const converted = toAnthropicMessages(
      normalizeMessages([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '看图', images: ['iVBORabc'] },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
        },
        { role: 'tool', content: '结果', tool_name: 'read_file' },
      ]),
    );

    expect(converted.system).toBe('sys');
    expect(converted.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORabc' },
    });
    const toolUse = converted.messages[1].content[0];
    expect(toolUse).toMatchObject({ type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } });
    expect(converted.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: toolUse.type === 'tool_use' ? toolUse.id : '',
    });
  });

  it('工具定义与能力推断', () => {
    expect(
      toAnthropicTools([
        {
          type: 'function',
          function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
        },
      ]),
    ).toEqual([{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: {} } }]);
    expect(inferProviderCapabilities('gpt-4o')).toEqual(['completion', 'tools', 'vision', 'thinking']);
    expect(inferProviderCapabilities('o3-mini')).toEqual(['completion', 'tools', 'vision', 'thinking']);
    expect(inferProviderCapabilities('unknown-model')).toEqual(['completion', 'tools', 'vision', 'thinking']);
  });
});
