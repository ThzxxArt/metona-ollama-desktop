/**
 * LLM 连接配置：Ollama / OpenAI 兼容 / Anthropic 兼容的 URL、模式与持久化。
 * 设置键仍为 `ollama.connection`，新增 provider 字段向后兼容旧配置。
 */

import {
  ANTHROPIC_DEFAULT_URL,
  DEFAULT_OLLAMA_CONNECTION,
  LOCAL_DEFAULT_URL,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  OPENAI_DEFAULT_URL,
  REMOTE_CLOUD_URL,
  type LlmProvider,
  type OllamaConnectionSettings,
  type OllamaConnectionView,
  type OllamaMode,
  type RemoteKind,
} from '../../shared/contracts/ollama.js';
import { normalizeBaseUrl, normalizeProviderBaseUrl, isCloudHost } from '../../shared/ollama-url.js';
import { clampContextLength } from '../../shared/context-length.js';
import { getSetting, saveSetting } from '../db/sqlite.js';
import { getOllamaSecretStore } from './secret-store.js';

const SETTINGS_KEY = 'ollama.connection';

export { normalizeBaseUrl, buildApiUrl } from '../../shared/ollama-url.js';
export { isCloudHost };

export function getEffectiveBaseUrl(settings: OllamaConnectionSettings): string {
  if (settings.provider === 'openai') return settings.openaiUrl;
  if (settings.provider === 'anthropic') return settings.anthropicUrl;
  return settings.mode === 'local' ? settings.localUrl : settings.remoteUrl;
}

export function getEffectiveRemoteKind(settings: OllamaConnectionSettings): RemoteKind {
  if (settings.provider && settings.provider !== 'ollama') return 'self-hosted';
  if (settings.mode === 'local') return 'self-hosted';
  if (settings.remoteKind === 'cloud' || isCloudHost(settings.remoteUrl)) return 'cloud';
  return 'self-hosted';
}

export function isCloudConnection(settings: OllamaConnectionSettings): boolean {
  return (
    (!settings.provider || settings.provider === 'ollama') &&
    settings.mode === 'remote' &&
    getEffectiveRemoteKind(settings) === 'cloud'
  );
}

function clampContextLengthLocal(value: unknown, fallback: number): number {
  return clampContextLength(value, fallback);
}

function clampMaxOutputTokens(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, Math.round(parsed)));
}

function normalizeSettings(raw: Partial<OllamaConnectionSettings> | null | undefined): OllamaConnectionSettings {
  const source = raw ?? {};
  const provider: LlmProvider =
    source.provider === 'openai' || source.provider === 'anthropic' ? source.provider : 'ollama';
  const mode: OllamaMode = source.mode === 'remote' ? 'remote' : 'local';
  const localUrl = safeNormalize(source.localUrl, LOCAL_DEFAULT_URL);
  const remoteUrl = safeNormalize(source.remoteUrl, REMOTE_CLOUD_URL);
  const openaiUrl = safeNormalizeProvider(source.openaiUrl, OPENAI_DEFAULT_URL);
  const anthropicUrl = safeNormalizeProvider(source.anthropicUrl, ANTHROPIC_DEFAULT_URL);
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
    provider,
    mode,
    localUrl,
    remoteUrl,
    openaiUrl,
    anthropicUrl,
    remoteKind,
    contextLength: clampContextLengthLocal(source.contextLength, DEFAULT_OLLAMA_CONNECTION.contextLength),
    maxOutputTokens: clampMaxOutputTokens(source.maxOutputTokens, DEFAULT_OLLAMA_CONNECTION.maxOutputTokens),
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

function safeNormalizeProvider(url: unknown, fallback: string): string {
  if (typeof url !== 'string' || !url.trim()) return fallback;
  try {
    return normalizeProviderBaseUrl(url);
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
  if (patch.openaiUrl !== undefined) merged.openaiUrl = normalizeProviderBaseUrl(patch.openaiUrl);
  if (patch.anthropicUrl !== undefined) merged.anthropicUrl = normalizeProviderBaseUrl(patch.anthropicUrl);
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
    hasApiKey: secrets.has(settings.provider),
    keyStorageAvailable: secrets.isEncryptionAvailable(),
  };
}

/** 测试/内部使用：清空缓存，强制从数据库重读 */
export function invalidateOllamaSettingsCache(): void {
  cached = null;
}
