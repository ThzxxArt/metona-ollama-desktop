/**
 * Ollama URL 归一化（纯函数，主进程/测试共用）
 */

export function normalizeBaseUrl(rawUrl: string): string {
  const raw = String(rawUrl || '').trim();
  if (!raw) throw new Error('服务地址不能为空');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('服务地址格式无效，请填写完整 URL（含 http:// 或 https://）');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议');
  }
  if (parsed.username || parsed.password) {
    throw new Error('服务地址不能包含用户名或密码');
  }
  let base = raw.replace(/\/+$/, '');
  // 允许用户粘贴 https://ollama.com/api，避免拼成 /api/api/chat
  if (/\/api$/i.test(base)) base = base.slice(0, -4);
  return base;
}

export function buildApiUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

export function isCloudHost(rawUrl: string): boolean {
  try {
    const u = new URL(normalizeBaseUrl(rawUrl));
    return u.hostname === 'ollama.com' || u.hostname.endsWith('.ollama.com');
  } catch {
    return false;
  }
}
