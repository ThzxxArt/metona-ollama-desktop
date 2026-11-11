import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  key: null as string | null,
  settings: {
    mode: 'local' as 'local' | 'remote',
    remoteKind: 'self-hosted' as 'cloud' | 'self-hosted',
    remoteAutoUnload: true,
    requestTimeoutMs: 900_000,
  },
  baseUrl: 'http://127.0.0.1:11434',
}));

vi.mock('../src/main/ollama/config.js', () => ({
  getEffectiveBaseUrl: () => hoisted.baseUrl,
  buildApiUrl: (base: string, path: string) => `${base}${path}`,
  getEffectiveRemoteKind: (s: { remoteKind: 'cloud' | 'self-hosted' }) => s.remoteKind,
  isCloudConnection: (s: { mode: string; remoteKind: string }) => s.mode === 'remote' && s.remoteKind === 'cloud',
  loadOllamaSettings: () => hoisted.settings,
}));

vi.mock('../src/main/ollama/secret-store.js', () => ({
  getOllamaSecretStore: () => ({ get: () => hoisted.key }),
}));

import {
  getVersion,
  listModels,
  psModels,
  showModel,
  embed,
  chat,
  generate,
  testConnection,
  chatStream,
  unloadModels,
  unloadModelsOnExit,
} from '../src/main/ollama/client.js';

const fetchMock = vi.fn();

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  hoisted.key = null;
  hoisted.baseUrl = 'http://127.0.0.1:11434';
  hoisted.settings = {
    mode: 'local',
    remoteKind: 'self-hosted',
    remoteAutoUnload: true,
    requestTimeoutMs: 900_000,
  };
});

describe('Ollama 客户端请求与认证', () => {
  it('无 Key 时不发送 Authorization', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: '0.40.16' }));
    await expect(getVersion()).resolves.toEqual({ version: '0.40.16' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/version');
  });

  it('有 Key 时所有请求带 Bearer', async () => {
    hoisted.key = 'sk-test';
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [] }));
    await listModels();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('模型/运行/详情/embed 接口路径正确', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ capabilities: ['tools'] }))
      .mockResolvedValueOnce(jsonResponse({ embedding: [1, 2] }));
    await psModels();
    await showModel('qwen3');
    await expect(embed('nomic', 'hello')).resolves.toEqual({ embedding: [1, 2] });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'http://127.0.0.1:11434/api/ps',
      'http://127.0.0.1:11434/api/show',
      'http://127.0.0.1:11434/api/embed',
    ]);
  });

  it('非流式 chat 强制 stream:false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: { content: 'ok' } }));
    await chat({ model: 'qwen3', messages: [] });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).stream).toBe(false);
  });

  it('generate 支持自定义超时选项', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ done: true }));
    await generate({ model: 'qwen3', keep_alive: 0 }, { timeoutMs: 10_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTTP 错误映射为 auth/not-found/rate-limit/server', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad key', { status: 401 }));
    await expect(getVersion()).rejects.toMatchObject({ kind: 'auth' });
    fetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(getVersion()).rejects.toMatchObject({ kind: 'not-found' });
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    await expect(getVersion()).rejects.toMatchObject({ kind: 'rate-limit' });
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(getVersion()).rejects.toMatchObject({ kind: 'server' });
  });

  it('网络错误映射为 network', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(getVersion()).rejects.toMatchObject({ kind: 'network' });
  });

  it('错误响应体读取失败时仍按状态码分类', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('body read failed');
      },
    } as unknown as Response);
    await expect(getVersion()).rejects.toMatchObject({ kind: 'server', status: 500 });
  });

  it('请求超时映射为 network 超时', async () => {
    hoisted.settings.requestTimeoutMs = 5;
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    await expect(chat({ model: 'qwen3', messages: [] })).rejects.toThrow('超时');
  });

  it('外部 abort 映射为 aborted', async () => {
    const ac = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const promise = chat({ model: 'qwen3', messages: [] }, ac.signal);
    ac.abort();
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('testConnection 成功与失败', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ version: '0.40.16' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'a' }] }));
    await expect(testConnection()).resolves.toMatchObject({ ok: true, version: '0.40.16', modelCount: 1 });

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(testConnection()).resolves.toMatchObject({ ok: false, errorKind: 'network' });

    // 200 但响应不是 JSON → 非 OllamaRequestError，走 unknown 分支
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(testConnection()).resolves.toMatchObject({ ok: false, errorKind: 'unknown' });
  });
});

describe('Ollama 流式解析', () => {
  function streamResponse(lines: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  it('逐行解析 NDJSON 并在 done 停止', async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse([
        '{"message":{"content":"he"}}\n',
        '{"message":{"content":"llo"},"done":false}\n',
        '{"done":true,"done_reason":"stop","prompt_eval_cached_count":5}\n',
      ]),
    );
    const chunks: unknown[] = [];
    await chatStream({ model: 'qwen3', messages: [] }, (c) => chunks.push(c));
    expect(chunks).toHaveLength(3);
    expect(chunks[1]).toMatchObject({ message: { content: 'llo' } });
  });

  it('处理最后一行没有换行的 buffer', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(['{"message":{"content":"tail"}}']));
    const chunks: unknown[] = [];
    await chatStream({ model: 'qwen3', messages: [] }, (c) => chunks.push(c));
    expect(chunks).toHaveLength(1);
  });

  it('忽略非法 JSON 行', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(['not-json\n{"done":true}\n']));
    const chunks: unknown[] = [];
    await chatStream({ model: 'qwen3', messages: [] }, (c) => chunks.push(c));
    expect(chunks).toHaveLength(1);
  });

  it('流内 error 抛 server 错误', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(['{"error":"model not found"}\n']));
    await expect(chatStream({ model: 'qwen3', messages: [] }, () => {})).rejects.toMatchObject({
      kind: 'server',
    });
  });

  it('abort 时 reader 被取消并静默返回', async () => {
    const ac = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode('{"message":{"content":"a"}}\n'));
            // 不 close，等待 abort
          },
          cancel() {
            // 模拟真实网络流被取消：让挂起的 read() 立即结束
            try {
              streamController.error(new Error('cancelled'));
            } catch {
              /* already closed */
            }
          },
        }),
      ),
    );
    const promise = chatStream({ model: 'qwen3', messages: [] }, () => {}, ac.signal);
    // 等 request/reader 建立后再 abort，覆盖已注册的 abort listener
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(promise).resolves.toBeUndefined();
  });

  it('最后一行非法 JSON 被静默忽略', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(['not-json']));
    await expect(chatStream({ model: 'qwen3', messages: [] }, () => {})).resolves.toBeUndefined();
  });

  it('调用前已 abort 时直接取消 reader', async () => {
    const ac = new AbortController();
    ac.abort();
    fetchMock.mockResolvedValueOnce(streamResponse(['{"message":{"content":"a"}}\n']));
    await expect(chatStream({ model: 'qwen3', messages: [] }, () => {}, ac.signal)).resolves.toBeUndefined();
  });
});

describe('Ollama 模型卸载', () => {
  it('本地模式先 ps 再 generate keep_alive:0', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'a' }, { name: 'b' }] }))
      .mockResolvedValueOnce(jsonResponse({ done: true }))
      .mockResolvedValueOnce(jsonResponse({ done: true }));
    await expect(unloadModels()).resolves.toEqual({ success: true, unloaded: 2 });
    const generateBodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/api/generate'))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(generateBodies).toEqual([
      { model: 'a', keep_alive: 0 },
      { model: 'b', keep_alive: 0 },
    ]);
  });

  it('自建远程受 remoteAutoUnload 控制，手动可强制', async () => {
    hoisted.settings = {
      mode: 'remote',
      remoteKind: 'self-hosted',
      remoteAutoUnload: false,
      requestTimeoutMs: 900_000,
    };
    await expect(unloadModels()).resolves.toEqual({ success: true, unloaded: 0 });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'a' }] }))
      .mockResolvedValueOnce(jsonResponse({ done: true }));
    await expect(unloadModels({ manual: true })).resolves.toEqual({ success: true, unloaded: 1 });
  });

  it('Cloud 自动跳过，手动返回错误', async () => {
    hoisted.settings = {
      mode: 'remote',
      remoteKind: 'cloud',
      remoteAutoUnload: true,
      requestTimeoutMs: 900_000,
    };
    await expect(unloadModels()).resolves.toEqual({ success: true, unloaded: 0 });
    await expect(unloadModels({ manual: true })).resolves.toMatchObject({ success: false });
  });

  it('ps 失败返回错误', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(unloadModels()).resolves.toMatchObject({ success: false });
  });

  it('退出卸载在 Cloud 下立即返回，不发起请求', async () => {
    hoisted.settings = {
      mode: 'remote',
      remoteKind: 'cloud',
      remoteAutoUnload: true,
      requestTimeoutMs: 900_000,
    };
    await unloadModelsOnExit(10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('退出卸载本地正常执行', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [] }));
    await unloadModelsOnExit(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('退出卸载超时不阻塞', async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    await expect(unloadModelsOnExit(1)).resolves.toBeUndefined();
  });

  it('退出卸载失败被吞掉，不影响退出', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(unloadModelsOnExit(50)).resolves.toBeUndefined();
  });
});
