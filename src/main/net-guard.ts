/**
 * Net Guard — 内网地址访问防护（SSRF 防御）
 * 阻止工具（web_fetch / download_file / browser_open）访问环回/内网/链路本地地址，
 * 防止网页提示注入诱导 Agent 探测本机服务（如 Ollama API）或内网资源后外传数据。
 *
 * 已知限制：检查在请求前解析 DNS，fetch 时会再次解析，理论上存在 DNS rebinding 窗口。
 */

import * as dns from 'dns';
import * as net from 'net';

/** 判断 IP 是否为环回/内网/链路本地地址 */
export function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // 环回与未指定地址
  if (
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '::' ||
    normalized === '::ffff:127.0.0.1'
  ) {
    return true;
  }
  if (net.isIPv4(normalized)) {
    return (
      normalized.startsWith('10.') ||
      normalized.startsWith('192.168.') ||
      normalized.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
    );
  }
  if (net.isIPv6(normalized)) {
    // IPv6 环回 / ULA（fc00::/7，fd 开头）/ 链路本地（fe80::/10）
    return (
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80')
    );
  }
  return false;
}

/** 本机/内网域名后缀（无需 DNS 解析即可判定） */
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * 校验 URL 是否可被工具访问：
 * - 仅允许 http/https 协议
 * - 拒绝 localhost 及本地域名后缀
 * - 拒绝字面量内网 IP
 * - 域名需 DNS 解析后确认不指向内网地址
 */
export async function checkPublicHttpUrl(rawUrl: string): Promise<{ ok: boolean; reason?: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `无效 URL: ${rawUrl}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `不允许的协议: ${u.protocol}` };
  }

  const host = u.hostname.toLowerCase();
  if (host === 'localhost') {
    return { ok: false, reason: '禁止访问本机地址 localhost' };
  }
  if (LOCAL_HOST_SUFFIXES.some(sfx => host.endsWith(sfx))) {
    return { ok: false, reason: `禁止访问本地域名: ${host}` };
  }

  // 字面量 IP 直接判定
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      return { ok: false, reason: `禁止访问内网/环回地址: ${host}` };
    }
    return { ok: true };
  }

  // 域名：解析后逐个检查结果 IP
  try {
    const records = await dns.promises.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        return { ok: false, reason: `域名 ${host} 解析到内网地址 ${r.address}` };
      }
    }
  } catch {
    return { ok: false, reason: `域名解析失败: ${host}` };
  }
  return { ok: true };
}
