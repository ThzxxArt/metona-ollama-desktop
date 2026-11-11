// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const bridge = {
  getConfig: vi.fn(async () => ({
    mode: 'local' as const,
    localUrl: 'http://127.0.0.1:11434',
    remoteUrl: 'https://ollama.com',
    remoteKind: 'cloud' as const,
    contextLength: 131072,
    remoteAutoUnload: true,
    requestTimeoutMs: 900000,
    hasApiKey: false,
    keyStorageAvailable: true,
  })),
  models: vi.fn(async () => ({ models: [{ name: 'qwen3' }] })),
  ps: vi.fn(async () => ({ models: [] })),
  test: vi.fn(async () => ({ ok: true, version: '0.40.16', modelCount: 1, latencyMs: 1 })),
  show: vi.fn(async () => ({ capabilities: ['tools'], model_info: {} })),
  chat: vi.fn(async () => ({ message: { content: 'ok' } })),
  chatStream: vi.fn(async () => {}),
  embed: vi.fn(async () => ({ embedding: [1, 2] })),
  unload: vi.fn(async () => ({ success: true, unloaded: 1 })),
};

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { ollama: bridge };
});

import { OllamaAPI } from '../src/renderer/api/ollama.js';

describe('渲染进程 OllamaAPI 薄封装', () => {
  it('refreshConfig 同步模式与地址', async () => {
    const api = new OllamaAPI();
    await api.refreshConfig();
    expect(api.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('refreshConfig 失败时保持构造地址', async () => {
    bridge.getConfig.mockRejectedValueOnce(new Error('no bridge'));
    const api = new OllamaAPI('http://custom');
    await api.refreshConfig();
    expect(api.baseUrl).toBe('http://custom');
  });

  it('listModels/ps/show/embed 走桥接', async () => {
    const api = new OllamaAPI();
    await expect(api.listModels()).resolves.toEqual({ models: [{ name: 'qwen3' }] });
    await expect(api.psModels()).resolves.toEqual({ models: [] });
    await expect(api.showModel('qwen3')).resolves.toMatchObject({ capabilities: ['tools'] });
    await expect(api.embed('nomic', 'hi')).resolves.toEqual({ embedding: [1, 2] });
  });

  it('testConnection 刷新配置并返回结果', async () => {
    const api = new OllamaAPI();
    await expect(api.testConnection()).resolves.toMatchObject({ ok: true, version: '0.40.16' });
  });

  it('getVersion 成功与失败', async () => {
    const api = new OllamaAPI();
    await expect(api.getVersion()).resolves.toEqual({ version: '0.40.16' });
    bridge.test.mockResolvedValueOnce({ ok: false, error: 'down' });
    await expect(api.getVersion()).rejects.toThrow('down');
  });

  it('chat 组装 think/system/keep_alive/format/options/tools', async () => {
    const api = new OllamaAPI();
    await api.chat({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      think: 'high',
      system: 'sys',
      keep_alive: '5m',
      format: { type: 'json' },
      options: { num_ctx: 1024 },
      tools: [{ type: 'function', function: { name: 'x', description: '', parameters: {} } }],
    });
    const body = bridge.chat.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen3',
      think: 'high',
      system: 'sys',
      keep_alive: '5m',
      format: { type: 'json' },
      options: { num_ctx: 1024 },
    });
    expect(body.tools).toHaveLength(1);
  });

  it('chatStream 透传 abort signal', async () => {
    const api = new OllamaAPI();
    const ac = new AbortController();
    await api.chatStream({ model: 'qwen3', messages: [] }, () => {}, ac);
    expect(bridge.chatStream).toHaveBeenCalledWith(expect.anything(), expect.any(Function), ac.signal);
  });

  it('unloadModels 默认 manual=true', async () => {
    const api = new OllamaAPI();
    await expect(api.unloadModels()).resolves.toEqual({ success: true, unloaded: 1 });
    expect(bridge.unload).toHaveBeenCalledWith({ manual: true });
    await api.unloadModels(false);
    expect(bridge.unload).toHaveBeenLastCalledWith({ manual: false });
  });

  it('缺少桌面桥时抛出明确错误', async () => {
    delete (window as unknown as { metonaDesktop?: unknown }).metonaDesktop;
    const api = new OllamaAPI();
    await expect(api.listModels()).rejects.toThrow('Ollama 代理不可用');
  });
});
