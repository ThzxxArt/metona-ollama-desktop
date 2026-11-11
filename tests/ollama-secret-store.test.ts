import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({
  dir: '',
  available: true,
  failEncrypt: false,
  failDecrypt: false,
  shouldReEncrypt: false,
}));

vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dir },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => hoisted.available,
    encryptStringAsync: async (value: string) => {
      if (hoisted.failEncrypt) throw new Error('encrypt failed');
      return Buffer.from(`enc:${value}`, 'utf-8');
    },
    decryptStringAsync: async (buf: Buffer) => {
      if (hoisted.failDecrypt) throw new Error('decrypt failed');
      return { result: buf.toString('utf-8').replace(/^enc:/, ''), shouldReEncrypt: hoisted.shouldReEncrypt };
    },
  },
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metona-secret-'));
  hoisted.dir = tmpDir;
  hoisted.available = true;
  hoisted.failEncrypt = false;
  hoisted.failDecrypt = false;
  hoisted.shouldReEncrypt = false;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function store() {
  const mod = await import('../src/main/ollama/secret-store.js');
  return mod.getOllamaSecretStore();
}

describe('Ollama SecretStore', () => {
  it('safeStorage 不可用时仅内存保存并明确提示', async () => {
    hoisted.available = false;
    const s = await store();
    await s.init();
    expect(s.isEncryptionAvailable()).toBe(false);
    const result = await s.set('sk-test');
    expect(result.success).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.error).toContain('本次运行');
    expect(s.has()).toBe(true);
    expect(s.get()).toBe('sk-test');
  });

  it('可用时加密落盘，新实例可解密读取', async () => {
    const s1 = await store();
    await s1.init();
    const result = await s1.set('sk-secret');
    expect(result.persisted).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'ollama-secret.bin'))).toBe(true);

    vi.resetModules();
    const s2 = await store();
    await s2.init();
    expect(s2.has()).toBe(true);
    expect(s2.get()).toBe('sk-secret');
  });

  it('shouldReEncrypt 时自动重新加密', async () => {
    const s1 = await store();
    await s1.init();
    await s1.set('sk-reencrypt');
    hoisted.shouldReEncrypt = true;
    vi.resetModules();
    const s2 = await store();
    await s2.init();
    expect(s2.get()).toBe('sk-reencrypt');
  });

  it('解密失败时视为无 Key', async () => {
    const s1 = await store();
    await s1.init();
    await s1.set('sk-broken');
    hoisted.failDecrypt = true;
    vi.resetModules();
    const s2 = await store();
    await s2.init();
    expect(s2.has()).toBe(false);
  });

  it('加密保存失败时 Key 仍在内存可用', async () => {
    const s = await store();
    await s.init();
    hoisted.failEncrypt = true;
    const result = await s.set('sk-memory');
    expect(result.success).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.error).toContain('加密保存失败');
    expect(s.get()).toBe('sk-memory');
  });

  it('空字符串清除 Key 与文件', async () => {
    const s = await store();
    await s.init();
    await s.set('sk-clear');
    expect(fs.existsSync(path.join(tmpDir, 'ollama-secret.bin'))).toBe(true);
    const result = await s.set('');
    expect(result.success).toBe(true);
    expect(s.has()).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'ollama-secret.bin'))).toBe(false);
  });

  it('clear 删除文件且重复调用安全', async () => {
    const s = await store();
    await s.init();
    await s.set('sk-clear2');
    s.clear();
    s.clear();
    expect(s.has()).toBe(false);
  });

  it('第三方 provider Key 独立保存、读取与清除', async () => {
    const s1 = await store();
    await s1.init();
    await s1.set('sk-openai', 'openai');
    await s1.set('sk-anthropic', 'anthropic');
    expect(fs.existsSync(path.join(tmpDir, 'llm-openai-secret.bin'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'llm-anthropic-secret.bin'))).toBe(true);
    expect(s1.get('openai')).toBe('sk-openai');
    expect(s1.get('anthropic')).toBe('sk-anthropic');
    expect(s1.has('ollama')).toBe(false);

    vi.resetModules();
    const s2 = await store();
    await s2.init();
    expect(s2.get('openai')).toBe('sk-openai');
    expect(s2.get('anthropic')).toBe('sk-anthropic');

    s2.clear('openai');
    expect(s2.has('openai')).toBe(false);
    expect(s2.has('anthropic')).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'llm-openai-secret.bin'))).toBe(false);
  });
});
