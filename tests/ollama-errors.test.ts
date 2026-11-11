import { describe, it, expect } from 'vitest';
import {
  classifyHttpError,
  classifyNetworkError,
  OllamaRequestError,
  toProxyError,
} from '../src/main/ollama/errors.js';

describe('Ollama 错误分类', () => {
  it('HTTP 401/403 → auth', () => {
    expect(classifyHttpError(401, 'bad key').kind).toBe('auth');
    expect(classifyHttpError(403, '').status).toBe(403);
  });

  it('HTTP 404 → not-found', () => {
    expect(classifyHttpError(404, 'missing').kind).toBe('not-found');
  });

  it('HTTP 429 → rate-limit', () => {
    expect(classifyHttpError(429, '').kind).toBe('rate-limit');
  });

  it('HTTP 5xx → server', () => {
    expect(classifyHttpError(500, 'boom').kind).toBe('server');
    expect(classifyHttpError(503, '').message).toContain('503');
  });

  it('其他 HTTP → unknown', () => {
    expect(classifyHttpError(418, 'teapot').kind).toBe('unknown');
  });

  it('网络错误分类为 network', () => {
    expect(classifyNetworkError(new Error('ECONNREFUSED')).kind).toBe('network');
    expect(classifyNetworkError(new Error('ENOTFOUND')).kind).toBe('network');
    expect(classifyNetworkError(new Error('ETIMEDOUT')).kind).toBe('network');
    expect(classifyNetworkError(new Error('random failure')).kind).toBe('network');
  });

  it('TLS 错误分类为 tls', () => {
    expect(classifyNetworkError(new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE')).kind).toBe('tls');
    expect(classifyNetworkError(new Error('CERT_HAS_EXPIRED')).kind).toBe('tls');
  });

  it('abort 分类为 aborted', () => {
    expect(classifyNetworkError(new Error('aborted'), true).kind).toBe('aborted');
    expect(classifyNetworkError({ name: 'AbortError' }).kind).toBe('aborted');
  });

  it('toProxyError 保留 kind/status/message', () => {
    const err = new OllamaRequestError('bad', 'auth', 401);
    expect(toProxyError(err)).toEqual({ kind: 'auth', status: 401, message: 'bad' });
    expect(toProxyError(new Error('x'))).toEqual({ kind: 'unknown', message: 'x' });
    expect(toProxyError('x')).toEqual({ kind: 'unknown', message: 'x' });
  });

  it('嵌套 cause 中的 code 会被识别', () => {
    const err = new Error('outer', { cause: { code: 'ECONNRESET' } });
    expect(classifyNetworkError(err).kind).toBe('network');
  });
});
