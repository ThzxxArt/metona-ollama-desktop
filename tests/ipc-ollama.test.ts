import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  settings: {
    mode: 'local' as const,
    localUrl: 'http://127.0.0.1:11434',
    remoteUrl: 'https://ollama.com',
    remoteKind: 'cloud' as const,
    contextLength: 131072,
    remoteAutoUnload: true,
    requestTimeoutMs: 900000,
  },
  hasKey: false,
  persisted: true,
  client: {
    testConnection: vi.fn(async () => ({ ok: true })),
    listModels: vi.fn(async () => ({ models: [] })),
    psModels: vi.fn(async () => ({ models: [] })),
    showModel: vi.fn(async () => ({ capabilities: [] })),
    embed: vi.fn(async () => ({ embedding: [1, 2] })),
    chat: vi.fn(async () => ({ message: { content: 'ok' } })),
    chatStream: vi.fn(async () => {}),
    unloadModels: vi.fn(async () => ({ success: true, unloaded: 0 })),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => hoisted.handlers.set(c, f) },
}));
vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { id: 1, send: hoisted.send }, isDestroyed: () => false },
}));
vi.mock('../src/main/ollama/config.js', () => ({
  getOllamaConnectionView: () => ({ ...hoisted.settings, hasApiKey: hoisted.hasKey, keyStorageAvailable: true }),
  loadOllamaSettings: () => hoisted.settings,
  saveOllamaSettings: (patch: Record<string, unknown>) => {
    hoisted.settings = { ...hoisted.settings, ...patch } as typeof hoisted.settings;
    return hoisted.settings;
  },
}));
vi.mock('../src/main/ollama/secret-store.js', () => ({
  getOllamaSecretStore: () => ({
    set: async (key: string) => {
      hoisted.hasKey = Boolean(key);
      return { success: true, persisted: hoisted.persisted };
    },
    clear: () => {
      hoisted.hasKey = false;
    },
    has: () => hoisted.hasKey,
  }),
}));
vi.mock('../src/main/ollama/client.js', () => hoisted.client);

import { registerOllamaIPC, abortAllOllamaStreams } from '../src/main/ipc/ollama.js';

const event = {
  sender: { id: 1, send: hoisted.send, isDestroyed: () => false, getURL: () => 'file:///index.html' },
  senderFrame: { url: 'file:///index.html' },
};

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = hoisted.handlers.get(channel);
  if (!fn) throw new Error(`missing ${channel}`);
  return Promise.resolve(fn(event, ...args));
}

beforeEach(() => {
  hoisted.handlers.clear();
  hoisted.send.mockReset();
  hoisted.persisted = true;
  hoisted.hasKey = false;
  hoisted.settings = {
    mode: 'local',
    localUrl: 'http://127.0.0.1:11434',
    remoteUrl: 'https://ollama.com',
    remoteKind: 'cloud',
    contextLength: 131072,
    remoteAutoUnload: true,
    requestTimeoutMs: 900000,
  };
  vi.clearAllMocks();
  registerOllamaIPC();
});

describe('IPC ollama', () => {
  it('config get/set', async () => {
    await expect(invoke('ollama:config:get')).resolves.toMatchObject({ mode: 'local', hasApiKey: false });
    await expect(invoke('ollama:config:set', { mode: 'remote', remoteUrl: 'https://x.test' })).resolves.toMatchObject({
      mode: 'remote',
    });
    await expect(invoke('ollama:config:set', { unknown: 1 })).rejects.toThrow('参数校验失败');
  });

  it('key set/clear', async () => {
    await expect(invoke('ollama:key:set', 'sk-test')).resolves.toMatchObject({ success: true, hasApiKey: true });
    await expect(invoke('ollama:key:clear')).resolves.toEqual({ success: true, hasApiKey: false });
    await expect(invoke('ollama:key:set', 123)).rejects.toThrow('参数校验失败');
  });

  it('key 支持 provider 参数并拒绝未知 provider', async () => {
    await expect(invoke('ollama:key:set', 'sk-openai', 'openai')).resolves.toMatchObject({
      success: true,
      hasApiKey: true,
    });
    await expect(invoke('ollama:key:clear', 'anthropic')).resolves.toEqual({
      success: true,
      hasApiKey: false,
    });
    await expect(invoke('ollama:key:set', 'sk-bad', 'gemini')).rejects.toThrow('参数校验失败');
    await expect(invoke('ollama:key:clear', 'gemini')).rejects.toThrow('参数校验失败');
  });

  it('key 仅内存保存时仍返回 hasApiKey 与错误提示', async () => {
    hoisted.persisted = false;
    const result = (await invoke('ollama:key:set', 'sk-memory')) as {
      success: boolean;
      hasApiKey: boolean;
      error?: string;
    };
    expect(result.success).toBe(true);
    expect(result.hasApiKey).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('流式 start 未传 streamId 时自动生成，sender 销毁后不发送', async () => {
    hoisted.client.chatStream.mockResolvedValueOnce(undefined);
    const generated = (await invoke('ollama:chat:start', { model: 'qwen3', messages: [] })) as {
      streamId: string;
    };
    expect(generated.streamId).toMatch(/^[0-9a-f-]{36}$/);

    const destroyedEvent = {
      sender: { id: 1, send: hoisted.send, isDestroyed: () => true, getURL: () => 'file:///index.html' },
      senderFrame: { url: 'file:///index.html' },
    };
    const fn = hoisted.handlers.get('ollama:chat:start')!;
    hoisted.send.mockClear();
    await Promise.resolve(fn(destroyedEvent, { model: 'qwen3', messages: [] }, 'destroyed'));
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.send).not.toHaveBeenCalled();
  });

  it('远程模式启动日志与 config set 后视图', async () => {
    hoisted.settings = {
      ...hoisted.settings,
      mode: 'remote',
      remoteUrl: 'https://remote.test',
      remoteKind: 'self-hosted',
    } as typeof hoisted.settings;
    registerOllamaIPC();
    await expect(invoke('ollama:config:get')).resolves.toMatchObject({ mode: 'remote' });
    await expect(invoke('ollama:config:set', { remoteKind: 'cloud' })).resolves.toMatchObject({
      remoteKind: 'cloud',
    });
  });

  it('config:set 空参数、embed 两种向量回退与空向量', async () => {
    await expect(invoke('ollama:config:set')).resolves.toMatchObject({ mode: 'local' });
    hoisted.client.embed.mockResolvedValueOnce({ embeddings: [[3, 4]] });
    await expect(invoke('ollama:embed', { model: 'nomic', input: 'hi' })).resolves.toEqual({ embedding: [3, 4] });
    hoisted.client.embed.mockResolvedValueOnce({});
    await expect(invoke('ollama:embed', { model: 'nomic', input: 'hi' })).resolves.toEqual({ embedding: [] });
  });

  it('非流式 requestId 正常完成时清理 activeRequests', async () => {
    hoisted.client.chat.mockResolvedValueOnce({ message: { content: 'ok' } });
    await expect(invoke('ollama:chat', { model: 'qwen3', messages: [] }, 'normal-request')).resolves.toEqual({
      message: { content: 'ok' },
    });
    await expect(invoke('ollama:chat:abortRequest', 'normal-request')).resolves.toEqual({ success: false });
  });

  it('销毁的 sender 不会收到流式 chunk，abort 后排队 chunk 被丢弃', async () => {
    let onChunk: ((chunk: unknown) => void) | null = null;
    hoisted.client.chatStream.mockImplementationOnce(
      (_body: unknown, cb: (chunk: unknown) => void) =>
        new Promise<void>((resolve) => {
          onChunk = cb;
          resolve();
        }),
    );
    const destroyedEvent = {
      sender: { id: 1, send: hoisted.send, isDestroyed: () => true, getURL: () => 'file:///index.html' },
      senderFrame: { url: 'file:///index.html' },
    };
    const fn = hoisted.handlers.get('ollama:chat:start')!;
    hoisted.send.mockClear();
    await Promise.resolve(fn(destroyedEvent, { model: 'qwen3', messages: [] }, 'destroyed-chunk'));
    onChunk?.({ message: { content: 'x' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(hoisted.send).not.toHaveBeenCalled();

    hoisted.client.chatStream.mockImplementationOnce(
      (_body: unknown, cb: (chunk: unknown) => void, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          cb({ message: { content: 'queued' } });
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    await invoke('ollama:chat:start', { model: 'qwen3', messages: [] }, 'abort-flush');
    await invoke('ollama:chat:abort', 'abort-flush');
    await new Promise((r) => setTimeout(r, 30));
    expect(hoisted.send.mock.calls.some((c) => c[0] === 'ollama:chat:chunk')).toBe(false);
  });

  it('test/models/ps/show/embed', async () => {
    await expect(invoke('ollama:test')).resolves.toEqual({ ok: true });
    await expect(invoke('ollama:models')).resolves.toEqual({ models: [] });
    await expect(invoke('ollama:ps')).resolves.toEqual({ models: [] });
    await expect(invoke('ollama:show', 'qwen3')).resolves.toEqual({ capabilities: [] });
    await expect(invoke('ollama:embed', { model: 'nomic', input: 'hi' })).resolves.toEqual({ embedding: [1, 2] });
    await expect(invoke('ollama:show', '')).rejects.toThrow('参数校验失败');
    await expect(invoke('ollama:embed', { model: '', input: '' })).rejects.toThrow('参数校验失败');
  });

  it('非流式 chat', async () => {
    await expect(invoke('ollama:chat', { model: 'qwen3', messages: [] })).resolves.toEqual({
      message: { content: 'ok' },
    });
    await expect(invoke('ollama:chat', { model: '', messages: [] })).rejects.toThrow('参数校验失败');
  });

  it('非流式 chat 支持 requestId 取消', async () => {
    let signal: AbortSignal | undefined;
    hoisted.client.chat.mockImplementationOnce(
      (_body, s: AbortSignal) =>
        new Promise((resolve, reject) => {
          signal = s;
          s.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const promise = invoke('ollama:chat', { model: 'qwen3', messages: [] }, 'req-1');
    await new Promise((r) => setTimeout(r, 10));
    await expect(invoke('ollama:chat:abortRequest', 'req-1')).resolves.toEqual({ success: true });
    expect(signal?.aborted).toBe(true);
    await expect(promise).rejects.toThrow();
    await expect(invoke('ollama:chat:abortRequest', 'missing')).resolves.toEqual({ success: false });
  });

  it('流式 start 推送 chunk 与 done', async () => {
    hoisted.client.chatStream.mockImplementationOnce(async (_body, onChunk) => {
      onChunk({ message: { content: 'he' } });
      onChunk({ message: { content: 'llo' }, done: true });
    });
    const result = (await invoke('ollama:chat:start', { model: 'qwen3', messages: [] }, 'stream-1')) as {
      streamId: string;
    };
    expect(result.streamId).toBe('stream-1');
    await new Promise((r) => setTimeout(r, 30));
    expect(hoisted.send).toHaveBeenCalledWith('ollama:chat:chunk', {
      streamId: 'stream-1',
      chunk: { message: { content: 'he' } },
    });
    expect(hoisted.send).toHaveBeenCalledWith('ollama:chat:done', { streamId: 'stream-1', error: undefined });
  });

  it('流式重复 streamId 拒绝', async () => {
    hoisted.client.chatStream.mockImplementationOnce(() => new Promise(() => {}));
    await invoke('ollama:chat:start', { model: 'qwen3', messages: [] }, 'dup');
    await expect(invoke('ollama:chat:start', { model: 'qwen3', messages: [] }, 'dup')).rejects.toThrow('已存在');
  });

  it('流式 abort 只发送一次 done 且丢弃后续 chunk', async () => {
    let resolveStream: () => void = () => {};
    hoisted.client.chatStream.mockImplementationOnce(
      (_body, onChunk, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          resolveStream = resolve;
          onChunk({ message: { content: 'queued' } });
          signal.addEventListener('abort', () => {
            onChunk({ message: { content: 'late' } });
            resolve();
          });
        }),
    );
    await invoke('ollama:chat:start', { model: 'qwen3', messages: [] }, 'abort-1');
    await invoke('ollama:chat:abort', 'abort-1');
    resolveStream();
    await new Promise((r) => setTimeout(r, 30));
    const doneCalls = hoisted.send.mock.calls.filter((c) => c[0] === 'ollama:chat:done');
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][1]).toMatchObject({ error: { kind: 'aborted' } });
    expect(hoisted.send.mock.calls.some((c) => c[0] === 'ollama:chat:chunk')).toBe(false);
  });

  it('abortAll 会中止活动流', async () => {
    hoisted.client.chatStream.mockImplementationOnce(
      (_body, _onChunk, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    await invoke('ollama:chat:start', { model: 'qwen3', messages: [] }, 'abort-all-stream');
    abortAllOllamaStreams();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.send).toHaveBeenCalledWith('ollama:chat:done', {
      streamId: 'abort-all-stream',
      error: expect.objectContaining({ kind: 'aborted' }),
    });
  });

  it('流式错误发送 done error', async () => {
    hoisted.client.chatStream.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await invoke('ollama:chat:start', { model: 'qwen3', messages: [] }, 'err-1');
    await new Promise((r) => setTimeout(r, 30));
    expect(hoisted.send).toHaveBeenCalledWith('ollama:chat:done', {
      streamId: 'err-1',
      error: expect.objectContaining({ kind: 'unknown' }),
    });
  });

  it('unload 与 abortAll', async () => {
    await expect(invoke('ollama:unload')).resolves.toMatchObject({ success: true });
    expect(hoisted.client.unloadModels).toHaveBeenCalledWith({ manual: false });
    await expect(invoke('ollama:unload', { manual: true })).resolves.toMatchObject({ success: true });
    expect(hoisted.client.unloadModels).toHaveBeenCalledWith({ manual: true });
    await expect(invoke('ollama:unload', { manual: 'bad' })).rejects.toThrow('参数校验失败');

    let signal: AbortSignal | undefined;
    hoisted.client.chat.mockImplementationOnce(
      (_body, s: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal = s;
          s.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const pending = invoke('ollama:chat', { model: 'qwen3', messages: [] }, 'req-abort-all');
    await new Promise((r) => setTimeout(r, 10));
    abortAllOllamaStreams();
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow();
  });

  it('requestId 重复时拒绝', async () => {
    hoisted.client.chat.mockImplementationOnce(() => new Promise(() => {}));
    void invoke('ollama:chat', { model: 'qwen3', messages: [] }, 'req-dup');
    await new Promise((r) => setTimeout(r, 10));
    await expect(invoke('ollama:chat', { model: 'qwen3', messages: [] }, 'req-dup')).rejects.toThrow('已存在');
  });

  it('abort 不存在的 request/stream 返回 false', async () => {
    await expect(invoke('ollama:chat:abortRequest', 'missing')).resolves.toEqual({ success: false });
    await expect(invoke('ollama:chat:abort', 'missing')).resolves.toEqual({ success: false });
  });
});
