/**
 * Crypto — Metona .metona 备份加解密（v3）
 * - PBKDF2-SHA256 + AES-256-GCM
 * - 支持可选密码；无密码模式仅防误读，不是安全边界
 * - 0.18.0 只接受 v3；v1/v2 直接拒绝
 */

const MAGIC = new TextEncoder().encode('METONA3\0');
const VERSION = 3;
const DEFAULT_ITERATIONS = 210_000;
const MAX_ITERATIONS = 2_000_000;
const NO_PASSWORD_PASSPHRASE = 'metona-ollama-v3-no-password';

function toUint32BE(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function fromUint32BE(bytes: Uint8Array): number {
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const passBytes = new TextEncoder().encode(passphrase);
  const keyMaterial = await crypto.subtle.importKey('raw', passBytes, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptData(data: unknown, password = ''): Promise<Blob> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const hasPassword = password.length > 0;
  const passphrase = hasPassword ? password : NO_PASSWORD_PASSPHRASE;
  const iterations = hasPassword ? DEFAULT_ITERATIONS : 100_000;
  const key = await deriveKey(passphrase, salt, iterations);

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, json);
  const header = new Uint8Array(8 + 1 + 1 + 16 + 12 + 4);
  let offset = 0;
  header.set(MAGIC, offset); offset += 8;
  header[offset++] = VERSION;
  header[offset++] = hasPassword ? 1 : 0;
  header.set(salt, offset); offset += 16;
  header.set(iv, offset); offset += 12;
  header.set(toUint32BE(iterations), offset);

  return new Blob([header, new Uint8Array(ciphertext)]);
}

export async function decryptData(buffer: ArrayBuffer, password = ''): Promise<unknown> {
  const data = new Uint8Array(buffer);
  if (data.length < 42) throw new Error('不是有效的 .metona v3 文件');
  for (let i = 0; i < 8; i++) {
    if (data[i] !== MAGIC[i]) {
      throw new Error('仅支持 0.18.0 的 .metona v3 备份；旧版 v1/v2 备份不可导入');
    }
  }
  let offset = 8;
  const version = data[offset++];
  if (version !== VERSION) throw new Error(`不支持的备份版本: ${version}`);
  const mode = data[offset++];
  const salt = data.slice(offset, offset + 16); offset += 16;
  const iv = data.slice(offset, offset + 12); offset += 12;
  const iterations = fromUint32BE(data.slice(offset, offset + 4)); offset += 4;
  // 迭代次数来自文件头，必须有上限，避免恶意备份用超大 PBKDF2 迭代拖死渲染进程。
  if (iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new Error('备份文件参数非法');
  }
  const payload = data.slice(offset);

  if (mode === 1 && !password) {
    throw new Error('该备份已设置密码，请输入密码后重试');
  }
  const passphrase = mode === 1 ? password : NO_PASSWORD_PASSPHRASE;

  try {
    const key = await deriveKey(passphrase, salt, iterations);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    throw new Error(mode === 1 ? '密码错误或备份文件已损坏' : '备份文件已损坏');
  }
}
