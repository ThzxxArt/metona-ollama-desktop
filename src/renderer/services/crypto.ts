/**
 * Crypto — Metona 会话加密模块
 * Electron 环境下 crypto.subtle 始终可用，无需 JS 回退实现
 */

const MAGIC = new TextEncoder().encode('METONA1\0');
const PASSPHRASE = 'metona-ollama-v2';
const PBKDF2_ITERATIONS = 100000;

async function deriveKeyBytes(salt: Uint8Array): Promise<Uint8Array> {
  const passBytes = new TextEncoder().encode(PASSPHRASE);
  const keyMaterial = await (crypto.subtle as any).importKey('raw', passBytes, 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as any, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

export async function encryptData(data: unknown): Promise<Blob> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = await deriveKeyBytes(salt);

  const key = await crypto.subtle.importKey('raw', keyBytes as any, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, json);
  const payload = new Uint8Array(ciphertext);

  const flag = new Uint8Array([1]); // mode=1: AES-GCM
  return new Blob([MAGIC, salt, iv, flag, payload]);
}

export async function decryptData(buffer: ArrayBuffer): Promise<unknown> {
  const data = new Uint8Array(buffer);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== MAGIC[i]) throw new Error('不是有效的 .metona 文件');
  }

  const salt = data.slice(8, 24);
  const iv = data.slice(24, 36);
  const mode = data[36];
  const payload = data.slice(37);
  const keyBytes = await deriveKeyBytes(salt);

  if (mode !== 1) {
    throw new Error('不支持的加密格式，请使用最新版本重新导出');
  }

  const key = await crypto.subtle.importKey('raw', keyBytes as any, 'AES-GCM', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload);
  const jsonBytes = new Uint8Array(decrypted);

  return JSON.parse(new TextDecoder().decode(jsonBytes));
}
