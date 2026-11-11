import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  hasKey: false,
  available: true,
}));

vi.mock('../src/main/db/sqlite.js', () => ({
  getSetting: (key: string, fallback: unknown) => (hoisted.settings.has(key) ? hoisted.settings.get(key) : fallback),
  saveSetting: (key: string, value: unknown) => {
    hoisted.settings.set(key, value);
  },
}));

vi.mock('../src/main/ollama/secret-store.js', () => ({
  getOllamaSecretStore: () => ({
    has: () => hoisted.hasKey,
    isEncryptionAvailable: () => hoisted.available,
  }),
}));

import {
  loadOllamaSettings,
  saveOllamaSettings,
  getOllamaConnectionView,
  getEffectiveRemoteKind,
  isCloudConnection,
  getEffectiveBaseUrl,
  invalidateOllamaSettingsCache,
  normalizeBaseUrl,
  buildApiUrl,
} from '../src/main/ollama/config.js';
import { DEFAULT_OLLAMA_CONNECTION, LOCAL_DEFAULT_URL, REMOTE_CLOUD_URL } from '../src/shared/contracts/ollama.js';

beforeEach(() => {
  hoisted.settings.clear();
  hoisted.hasKey = false;
  hoisted.available = true;
  invalidateOllamaSettingsCache();
});

describe('Ollama 连接配置', () => {
  it('空设置返回默认值', () => {
    const settings = loadOllamaSettings();
    expect(settings.provider).toBe('ollama');
    expect(settings.mode).toBe('local');
    expect(settings.localUrl).toBe(LOCAL_DEFAULT_URL);
    expect(settings.remoteUrl).toBe(REMOTE_CLOUD_URL);
    expect(settings.openaiUrl).toBe('https://api.openai.com');
    expect(settings.anthropicUrl).toBe('https://api.anthropic.com');
    expect(settings.remoteKind).toBe('cloud');
    expect(settings.contextLength).toBe(DEFAULT_OLLAMA_CONNECTION.contextLength);
    expect(settings.maxOutputTokens).toBe(DEFAULT_OLLAMA_CONNECTION.maxOutputTokens);
    expect(settings.remoteAutoUnload).toBe(true);
  });

  it('最大输出 Token 保存并钳制到 256–131072', () => {
    expect(saveOllamaSettings({ maxOutputTokens: 128 }).maxOutputTokens).toBe(256);
    expect(saveOllamaSettings({ maxOutputTokens: 999_999 }).maxOutputTokens).toBe(131072);
    expect(saveOllamaSettings({ maxOutputTokens: 8192 }).maxOutputTokens).toBe(8192);
  });

  it('第三方 provider 使用独立地址且不判定为 Cloud', () => {
    const openai = saveOllamaSettings({
      provider: 'openai',
      openaiUrl: 'https://openrouter.ai/api/v1',
    });
    expect(openai.provider).toBe('openai');
    expect(getEffectiveBaseUrl(openai)).toBe('https://openrouter.ai/api/v1');
    expect(getEffectiveRemoteKind(openai)).toBe('self-hosted');
    expect(isCloudConnection(openai)).toBe(false);

    const anthropic = saveOllamaSettings({
      provider: 'anthropic',
      anthropicUrl: 'https://api.anthropic.com',
    });
    expect(anthropic.provider).toBe('anthropic');
    expect(getEffectiveBaseUrl(anthropic)).toBe('https://api.anthropic.com');
  });

  it('第三方地址非法时保存抛错', () => {
    expect(() => saveOllamaSettings({ openaiUrl: 'not a url' })).toThrow('格式无效');
    expect(() => saveOllamaSettings({ anthropicUrl: 'ftp://example.com' })).toThrow('http/https');
  });

  it('自建远程 URL 默认 self-hosted，不误判为 Cloud', () => {
    hoisted.settings.set('ollama.connection', { mode: 'remote', remoteUrl: 'https://ollama.example.com' });
    const settings = loadOllamaSettings();
    expect(settings.remoteKind).toBe('self-hosted');
    expect(isCloudConnection(settings)).toBe(false);
  });

  it('ollama.com 强制 cloud', () => {
    hoisted.settings.set('ollama.connection', { mode: 'remote', remoteUrl: 'https://api.ollama.com/api' });
    expect(loadOllamaSettings().remoteKind).toBe('cloud');
  });

  it('保存本地地址只更新本地字段', () => {
    const saved = saveOllamaSettings({ mode: 'local', localUrl: 'http://localhost:1234/' });
    expect(saved.localUrl).toBe('http://localhost:1234');
    expect(saved.remoteUrl).toBe(REMOTE_CLOUD_URL);
    expect(getEffectiveBaseUrl(saved)).toBe('http://localhost:1234');
  });

  it('保存自建远程保留 cloud 偏好之外的类型', () => {
    const saved = saveOllamaSettings({
      mode: 'remote',
      remoteUrl: 'https://ollama.example.com',
      remoteKind: 'self-hosted',
      remoteAutoUnload: false,
    });
    expect(saved.remoteKind).toBe('self-hosted');
    expect(saved.remoteAutoUnload).toBe(false);
    expect(getEffectiveRemoteKind(saved)).toBe('self-hosted');
  });

  it('保存 ollama.com 时强制 cloud', () => {
    const saved = saveOllamaSettings({
      mode: 'remote',
      remoteUrl: 'https://ollama.com/api',
      remoteKind: 'self-hosted',
    });
    expect(saved.remoteUrl).toBe('https://ollama.com');
    expect(saved.remoteKind).toBe('cloud');
  });

  it('非法 URL 保存时抛错而不是静默回退', () => {
    expect(() => saveOllamaSettings({ localUrl: 'ftp://example.com' })).toThrow('http/https');
    expect(() => saveOllamaSettings({ localUrl: 'https://user:pass@example.com' })).toThrow('用户名或密码');
    expect(() => saveOllamaSettings({ localUrl: 'not a url' })).toThrow('格式无效');
  });

  it('连接视图包含 Key 状态与存储可用性', () => {
    hoisted.hasKey = true;
    hoisted.available = false;
    const view = getOllamaConnectionView();
    expect(view.hasApiKey).toBe(true);
    expect(view.keyStorageAvailable).toBe(false);
  });

  it('local 模式的 effective remote kind 恒为 self-hosted', () => {
    const settings = loadOllamaSettings();
    expect(getEffectiveRemoteKind(settings)).toBe('self-hosted');
  });

  it('URL 归一化与 API 拼接', () => {
    expect(normalizeBaseUrl('https://example.com/ollama/api?x=1#y')).toBe('https://example.com/ollama');
    expect(buildApiUrl('https://example.com/ollama/', '/api/tags')).toBe('https://example.com/ollama/api/tags');
  });
});
