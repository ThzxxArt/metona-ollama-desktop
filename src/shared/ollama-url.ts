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
  // 只保留 origin + pathname：丢弃 query / hash，避免拼出 /api/chat?x=1/api/chat
  let basePath = parsed.pathname.replace(/\/+$/, '');
  // 允许用户粘贴 https://ollama.com/api，避免拼成 /api/api/chat
  if (/\/api$/i.test(basePath)) basePath = basePath.slice(0, -4);
  return `${parsed.origin}${basePath}`;
}

export function buildApiUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * 第三方 LLM 基地址归一化。
 * 与 Ollama 不同，不能把 /api 后缀当作 Ollama 前缀删除，否则
 * OpenRouter 的 https://openrouter.ai/api/v1 会被破坏。
 */
export function normalizeProviderBaseUrl(rawUrl: string): string {
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
  let basePath = parsed.pathname.replace(/\/+$/, '');
  // 允许用户直接粘贴完整 endpoint，自动回退到 API 根路径。
  basePath = basePath.replace(/\/(chat\/completions|messages|models|embeddings)$/i, '');
  return `${parsed.origin}${basePath}`;
}

/**
 * 拼接第三方 API 路径。
 * 已带 /v1 或 /api/v1 的基地址不会重复追加版本段。
 */
export function buildProviderApiUrl(baseUrl: string, endpoint: string): string {
  const base = normalizeProviderBaseUrl(baseUrl);
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (/\/v1$/i.test(base)) return `${base}${suffix}`;
  return `${base}/v1${suffix}`;
}

export function isCloudHost(rawUrl: string): boolean {
  try {
    const u = new URL(normalizeBaseUrl(rawUrl));
    return u.hostname === 'ollama.com' || u.hostname.endsWith('.ollama.com');
  } catch {
    return false;
  }
}
