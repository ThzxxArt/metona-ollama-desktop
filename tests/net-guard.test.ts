import { describe, it, expect } from 'vitest';
import { isPrivateIp, checkPublicHttpUrl } from '../src/main/net-guard.js';

describe('isPrivateIp', () => {
  it('环回与未指定地址', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('0.0.0.0')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('私网 IPv4 段', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true); // 云元数据端点
  });

  it('172 段边界：15/32 是公网，16-31 是私网', () => {
    expect(isPrivateIp('172.15.255.255')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
  });

  it('公网地址放行', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('172.100.0.1')).toBe(false);
  });

  it('IPv6 ULA 与链路本地', () => {
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('fc12::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
  });
});

describe('checkPublicHttpUrl', () => {
  it('拒绝非 http/https 协议（file:// 读取本地文件）', async () => {
    const r = await checkPublicHttpUrl('file:///C:/Windows/win.ini');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('协议');
  });

  it('拒绝 localhost 与本地域名后缀', async () => {
    expect((await checkPublicHttpUrl('http://localhost:11434/api/tags')).ok).toBe(false);
    expect((await checkPublicHttpUrl('http://foo.internal/x')).ok).toBe(false);
    expect((await checkPublicHttpUrl('http://bar.local/x')).ok).toBe(false);
  });

  it('拒绝字面量内网 IP', async () => {
    expect((await checkPublicHttpUrl('http://127.0.0.1:11434/')).ok).toBe(false);
    expect((await checkPublicHttpUrl('http://192.168.1.1/admin')).ok).toBe(false);
    expect((await checkPublicHttpUrl('http://169.254.169.254/latest/meta-data')).ok).toBe(false);
  });

  it('公网域名放行', async () => {
    const r = await checkPublicHttpUrl('https://www.baidu.com/');
    expect(r.ok).toBe(true);
  });

  it('无效 URL 拒绝', async () => {
    expect((await checkPublicHttpUrl('not a url')).ok).toBe(false);
  });
});
