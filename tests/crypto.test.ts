import { describe, it, expect } from 'vitest';
import { encryptData, decryptData } from '../src/renderer/services/crypto.js';

describe('crypto — AES-256-GCM 备份编码', () => {
  it('加密数据生成带 MAGIC 标志的 Blob', async () => {
    const blob = await encryptData({ hello: 'world' });
    // 读 MAGIC 前 8 字节 = METONA1\0
    const magic = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const expected = new TextEncoder().encode('METONA1\0');
    expect(Array.from(magic)).toEqual(Array.from(expected));
  });

  it('加密解密往返保持一致（对象）', async () => {
    const original = { a: 1, b: 'text', c: [true, false, null] };
    const blob = await encryptData(original);
    const buf = await blob.arrayBuffer();
    const out = await decryptData(buf);
    expect(out).toEqual(original);
  });

  it('加密解密往返保持一致（数组）', async () => {
    const original = ['one', 'two', { three: 3 }];
    const blob = await encryptData(original);
    const out = await decryptData(await blob.arrayBuffer());
    expect(out).toEqual(original);
  });

  it('每次加密生成不同输出（随机 salt/iv）', async () => {
    const blob1 = await encryptData({ k: 'v' });
    const blob2 = await encryptData({ k: 'v' });
    const b1 = new Uint8Array(await blob1.arrayBuffer());
    const b2 = new Uint8Array(await blob2.arrayBuffer());
    expect(b1).not.toEqual(b2);
  });

  it('解密非 .metona 文件抛出错误', async () => {
    const garbage = new TextEncoder().encode('NOTAMETONAFILE').buffer;
    await expect(decryptData(garbage)).rejects.toThrow('不是有效的');
  });

  it('空对象往返', async () => {
    const blob = await encryptData({});
    expect(await decryptData(await blob.arrayBuffer())).toEqual({});
  });
});
