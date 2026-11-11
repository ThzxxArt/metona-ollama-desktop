/**
 * SecretStore：Ollama / OpenAI / Anthropic API Key 使用 Electron safeStorage 加密落盘。
 * 每个提供商独立文件，渲染进程永远拿不到明文，只能拿到 hasApiKey。
 * 0.18.0 使用 Electron 45 的异步 safeStorage API。
 */

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { LlmProvider } from '../../shared/contracts/ollama.js';

const SECRET_FILE = 'ollama-secret.bin';
type ThirdPartyProvider = Exclude<LlmProvider, 'ollama'>;
const PROVIDER_SECRET_FILES: Record<ThirdPartyProvider, string> = {
  openai: 'llm-openai-secret.bin',
  anthropic: 'llm-anthropic-secret.bin',
};

class OllamaSecretStore {
  private _key: string | null = null;
  private _providerKeys: Partial<Record<ThirdPartyProvider, string>> = {};
  private _loaded = false;
  private _available = false;

  private get filePath(): string {
    return path.join(app.getPath('userData'), SECRET_FILE);
  }

  private providerFilePath(provider: ThirdPartyProvider): string {
    return path.join(app.getPath('userData'), PROVIDER_SECRET_FILES[provider]);
  }

  /** 必须在 app ready 之后调用一次 */
  async init(): Promise<void> {
    if (this._loaded) return;
    this._loaded = true;
    try {
      this._available = await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      this._available = false;
    }
    if (!this._available) return;
    this._key = await this.loadFrom(this.filePath, true);
    for (const provider of Object.keys(PROVIDER_SECRET_FILES) as ThirdPartyProvider[]) {
      const value = await this.loadFrom(this.providerFilePath(provider), true);
      if (value) this._providerKeys[provider] = value;
    }
  }

  private async loadFrom(filePath: string, reEncrypt: boolean): Promise<string | null> {
    try {
      if (!fs.existsSync(filePath)) return null;
      const encrypted = fs.readFileSync(filePath);
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      const value = decrypted.result || null;
      if (reEncrypt && decrypted.shouldReEncrypt && value) {
        await this.persistTo(filePath, value);
      }
      return value;
    } catch {
      return null;
    }
  }

  isEncryptionAvailable(): boolean {
    return this._available;
  }

  has(provider: LlmProvider = 'ollama'): boolean {
    return Boolean(this.get(provider));
  }

  get(provider: LlmProvider = 'ollama'): string | null {
    if (provider === 'ollama') return this._key;
    return this._providerKeys[provider] ?? null;
  }

  /** 返回是否真正落盘（safeStorage 不可用时仅内存有效） */
  async set(
    key: string,
    provider: LlmProvider = 'ollama',
  ): Promise<{ success: boolean; persisted: boolean; error?: string }> {
    const value = key.trim();
    if (!value) {
      this.clear(provider);
      return { success: true, persisted: false };
    }

    if (provider === 'ollama') this._key = value;
    else this._providerKeys[provider] = value;

    if (!this._available) {
      return { success: true, persisted: false, error: '系统安全存储不可用，Key 仅在本次运行期间有效' };
    }
    try {
      await this.persistTo(provider === 'ollama' ? this.filePath : this.providerFilePath(provider), value);
      return { success: true, persisted: true };
    } catch (err) {
      // Key 已载入内存，本次运行仍可用；只是无法安全落盘。
      return {
        success: true,
        persisted: false,
        error: `API Key 已载入内存，但加密保存失败：${(err as Error).message}`,
      };
    }
  }

  private async persistTo(filePath: string, value: string): Promise<void> {
    const encrypted = await safeStorage.encryptStringAsync(value);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  clear(provider: LlmProvider = 'ollama'): void {
    if (provider === 'ollama') this._key = null;
    else delete this._providerKeys[provider];

    const filePath = provider === 'ollama' ? this.filePath : this.providerFilePath(provider);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // 删除失败不阻塞
    }
  }
}

let instance: OllamaSecretStore | null = null;

export function getOllamaSecretStore(): OllamaSecretStore {
  if (!instance) instance = new OllamaSecretStore();
  return instance;
}

export type { OllamaSecretStore };
