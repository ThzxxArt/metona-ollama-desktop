/**
 * SecretStore：Ollama API Key 使用 Electron safeStorage 加密落盘。
 * 渲染进程永远拿不到明文，只能拿到 hasApiKey。
 * 0.18.0 使用 Electron 45 的异步 safeStorage API。
 */

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const SECRET_FILE = 'ollama-secret.bin';

class OllamaSecretStore {
  private _key: string | null = null;
  private _loaded = false;
  private _available = false;

  private get filePath(): string {
    return path.join(app.getPath('userData'), SECRET_FILE);
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
    try {
      if (!fs.existsSync(this.filePath)) return;
      const encrypted = fs.readFileSync(this.filePath);
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      this._key = decrypted.result || null;
      if (decrypted.shouldReEncrypt && this._key) {
        await this.persist(this._key);
      }
    } catch {
      this._key = null;
    }
  }

  isEncryptionAvailable(): boolean {
    return this._available;
  }

  has(): boolean {
    return Boolean(this._key);
  }

  get(): string | null {
    return this._key;
  }

  /** 返回是否真正落盘（safeStorage 不可用时仅内存有效） */
  async set(key: string): Promise<{ success: boolean; persisted: boolean; error?: string }> {
    const value = key.trim();
    if (!value) {
      this.clear();
      return { success: true, persisted: false };
    }
    this._key = value;
    if (!this._available) {
      return { success: true, persisted: false, error: '系统安全存储不可用，Key 仅在本次运行期间有效' };
    }
    try {
      await this.persist(value);
      return { success: true, persisted: true };
    } catch (err) {
      return { success: false, persisted: false, error: (err as Error).message };
    }
  }

  private async persist(value: string): Promise<void> {
    const encrypted = await safeStorage.encryptStringAsync(value);
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  clear(): void {
    this._key = null;
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
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
