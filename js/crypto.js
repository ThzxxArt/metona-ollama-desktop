/**
 * Crypto - Metona 会话加密模块
 *
 * 文件格式: [8B magic "METONA1\0"][16B salt][12B IV][AES-256-GCM ciphertext]
 * 后缀: .metona
 */

const MAGIC = new TextEncoder().encode('METONA1\0');
const PASSPHRASE = 'metona-ollama-v2';
const PBKDF2_ITERATIONS = 100000;

/**
 * 导入派生密钥
 */
async function deriveKey(salt) {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(PASSPHRASE),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * 加密 JSON 数据 → .metona 二进制格式
 * @param {object} data - 要加密的对象
 * @returns {Blob} .metona 文件内容
 */
export async function encryptData(data) {
    const json = new TextEncoder().encode(JSON.stringify(data));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(salt);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, json);

    // 拼接: magic + salt + iv + ciphertext
    const blob = new Blob([MAGIC, salt, iv, ciphertext]);
    return blob;
}

/**
 * 解密 .metona 文件 → JSON 对象
 * @param {ArrayBuffer} buffer - .metona 文件内容
 * @returns {object} 解密后的对象
 */
export async function decryptData(buffer) {
    const data = new Uint8Array(buffer);

    // 校验 magic
    const magic = data.slice(0, 8);
    for (let i = 0; i < MAGIC.length; i++) {
        if (magic[i] !== MAGIC[i]) {
            throw new Error('不是有效的 .metona 文件');
        }
    }

    const salt = data.slice(8, 24);
    const iv = data.slice(24, 36);
    const ciphertext = data.slice(36);

    const key = await deriveKey(salt);
    let decrypted;
    try {
        decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    } catch {
        throw new Error('文件已损坏或格式不正确');
    }

    const json = new TextDecoder().decode(decrypted);
    return JSON.parse(json);
}

/**
 * 检查文件是否为 .metona 格式
 */
export function isMetonaFile(file) {
    return file.name.endsWith('.metona');
}
