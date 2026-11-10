import { describe, it, expect } from 'vitest';
import { normalizeBaseUrl, buildApiUrl, isCloudHost } from '../src/shared/ollama-url.js';

describe('normalizeBaseUrl', () => {
  it('去掉尾部斜杠', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:11434///')).toBe('http://127.0.0.1:11434');
  });

  it('去掉 /api 后缀，避免 /api/api', () => {
    expect(normalizeBaseUrl('https://ollama.com/api')).toBe('https://ollama.com');
    expect(normalizeBaseUrl('https://ollama.com/api/')).toBe('https://ollama.com');
  });

  it('拒绝非 http/https', () => {
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrow('http/https');
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow('http/https');
  });

  it('拒绝内嵌账号密码', () => {
    expect(() => normalizeBaseUrl('https://user:pass@example.com')).toThrow('用户名或密码');
  });

  it('拒绝空地址与非法 URL', () => {
    expect(() => normalizeBaseUrl('')).toThrow('不能为空');
    expect(() => normalizeBaseUrl('not a url')).toThrow('格式无效');
  });
});

describe('buildApiUrl', () => {
  it('基础地址 + API 路径', () => {
    expect(buildApiUrl('http://127.0.0.1:11434', '/api/chat')).toBe('http://127.0.0.1:11434/api/chat');
    expect(buildApiUrl('https://ollama.com/api', '/api/tags')).toBe('https://ollama.com/api/tags');
  });
});

describe('isCloudHost', () => {
  it('识别 ollama.com 与子域', () => {
    expect(isCloudHost('https://ollama.com')).toBe(true);
    expect(isCloudHost('https://api.ollama.com/api')).toBe(true);
  });

  it('自建地址不是云', () => {
    expect(isCloudHost('https://ollama.example.com')).toBe(false);
    expect(isCloudHost('http://127.0.0.1:11434')).toBe(false);
  });
});
