/**
 * Ollama 认证头（纯函数，便于测试）
 */

export function buildOllamaHeaders(
  apiKey: string | null | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  const key = String(apiKey || '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}
