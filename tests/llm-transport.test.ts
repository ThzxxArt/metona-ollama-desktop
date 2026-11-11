import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/main/ollama/config.js', () => ({
  loadOllamaSettings: () => ({ requestTimeoutMs: 50 }),
}));

import { providerFetch, providerJson } from '../src/main/llm/transport.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('第三方 LLM 传输', () => {
  it('网络错误分类', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }));
    await expect(providerFetch('https://x.test', {}, { service: 'Test' })).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('HTTP 错误分类', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await expect(providerFetch('https://x.test', {}, { service: 'Test' })).rejects.toMatchObject({
      kind: 'server',
      status: 500,
    });
  });

  it('非 JSON 响应', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(providerJson('https://x.test', {}, { service: 'Test' })).rejects.toThrow('非 JSON');
  });

  it('超时分类', async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    await expect(providerFetch('https://x.test', {}, { service: 'Test', timeoutMs: 5 })).rejects.toThrow('超时');
  });

  it('外部已中止时按 aborted 分类', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      expect(init.signal?.aborted).toBe(true);
      throw new Error('AbortError');
    });
    await expect(
      providerFetch('https://x.test', {}, { service: 'Test', signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });
});
