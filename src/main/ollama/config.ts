/**
 * Ollama 连接配置：URL 归一化、模式解析、持久化。
 * 0.18.0 使用全新设置键 `ollama.connection`，不读取旧 serverUrl。
 */

import {
  DEFAULT_OLLAMA_CONNECTION,
  LOCAL_DEFAULT_URL,
  REMOTE_CLOUD_URL,
  type OllamaConnectionSettings,
  type OllamaConnectionView,
  type OllamaMode,
  type RemoteKind,
} from '../../shared/contracts/ollama.js';
import { normalizeBaseUrl, isCloudHost } from '../../shared/ollama-url.js';
import { clampContextLength } from '../../shared/context-length.js';
import { getSetting, saveSetting } from '../db/sqlite.js';
import { getOllamaSecretStore } from './secret-store.js';

const SETTINGS_KEY = 'ollama.connection';

export { normalizeBaseUrl, buildApiUrl } from '../../shared/ollama-url.js';
export { isCloudHost };

export function getEffectiveBaseUrl(settings: OllamaConnectionSettings): string {
  return settings.mode === 'local' ? settings.localUrl : settings.remoteUrl;
}

export function getEffectiveRemoteKind(settings: OllamaConnectionSettings): RemoteKind {
  if (settings.mode === 'local') return 'self-hosted';
  if (settings.remoteKind === 'cloud' || isCloudHost(settings.remoteUrl)) return 'cloud';
  return 'self-hosted';
}

export function isCloudConnection(settings: OllamaConnectionSettings): boolean {
  return settings.mode === 'remote' && getEffectiveRemoteKind(settings) === 'cloud';
}

function clampContextLengthLocal(value: unknown, fallback: number): number {
  return clampContextLength(value, fallback);
}

function normalizeSettings(raw: Partial<OllamaConnectionSettings> | null | undefined): OllamaConnectionSettings {
  const source = raw ?? {};
  const mode: OllamaMode = source.mode === 'remote' ? 'remote' : 'local';
  const localUrl = safeNormalize(source.localUrl, LOCAL_DEFAULT_URL);
  const remoteUrl = safeNormalize(source.remoteUrl, REMOTE_CLOUD_URL);
  // 根因修复：remoteKind 缺失时不能默认 cloud。
  // - 地址是 ollama.com：强制 cloud
  // - 地址是自建：默认 self-hosted（否则自建远程会被误判为云，自动/手动卸载全部失效）
  // - 用户显式选择 cloud：保留 cloud（允许通过反代访问云端）
  const remoteKind: RemoteKind = isCloudHost(remoteUrl)
    ? 'cloud'
    : source.remoteKind === 'cloud'
      ? 'cloud'
      : 'self-hosted';
  return {
    mode,
    localUrl,
    remoteUrl,
    remoteKind,
    contextLength: clampContextLengthLocal(source.contextLength, DEFAULT_OLLAMA_CONNECTION.contextLength),
    remoteAutoUnload: source.remoteAutoUnload !== false,
    requestTimeoutMs:
      typeof source.requestTimeoutMs === 'number' && source.requestTimeoutMs > 0
        ? Math.round(source.requestTimeoutMs)
        : DEFAULT_OLLAMA_CONNECTION.requestTimeoutMs,
  };
}

function safeNormalize(url: unknown, fallback: string): string {
  if (typeof url !== 'string' || !url.trim()) return fallback;
  try {
    return normalizeBaseUrl(url);
  } catch {
    return fallback;
  }
}

let cached: OllamaConnectionSettings | null = null;

export function loadOllamaSettings(): OllamaConnectionSettings {
  if (cached) return cached;
  // 只读取 0.18.0 新键；旧 serverUrl 不读取、不迁移
  const raw = getSetting<Partial<OllamaConnectionSettings> | null>(SETTINGS_KEY, null);
  cached = normalizeSettings(raw);
  return cached;
}

export function saveOllamaSettings(patch: Partial<OllamaConnectionSettings>): OllamaConnectionSettings {
  const current = loadOllamaSettings();
  const merged = { ...current, ...patch };
  // 用户主动保存时，非法 URL 必须报错，不能静默回退到默认地址。
  if (patch.localUrl !== undefined) merged.localUrl = normalizeBaseUrl(patch.localUrl);
  if (patch.remoteUrl !== undefined) merged.remoteUrl = normalizeBaseUrl(patch.remoteUrl);
  const next = normalizeSettings(merged);
  // 远程地址若指向 ollama.com，强制标记为 cloud
  if (next.mode === 'remote' && isCloudHost(next.remoteUrl)) {
    next.remoteKind = 'cloud';
  }
  cached = next;
  saveSetting(SETTINGS_KEY, next);
  return next;
}

export function getOllamaConnectionView(): OllamaConnectionView {
  const settings = loadOllamaSettings();
  const secrets = getOllamaSecretStore();
  return {
    ...settings,
    hasApiKey: secrets.has(),
    keyStorageAvailable: secrets.isEncryptionAvailable(),
  };
}

/** 测试/内部使用：清空缓存，强制从数据库重读 */
export function invalidateOllamaSettingsCache(): void {
  cached = null;
}
