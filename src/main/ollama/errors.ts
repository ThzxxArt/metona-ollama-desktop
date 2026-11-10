/**
 * Ollama 错误分类：把 HTTP / TLS / 网络错误归一化为可展示的信息。
 */

import type { OllamaErrorKind, OllamaProxyError } from '../../shared/contracts/ollama.js';

export class OllamaRequestError extends Error {
  readonly kind: OllamaErrorKind;
  readonly status?: number;

  constructor(message: string, kind: OllamaErrorKind, status?: number) {
    super(message);
    this.name = 'OllamaRequestError';
    this.kind = kind;
    this.status = status;
  }
}

export function classifyHttpError(status: number, body: string): OllamaRequestError {
  const detail = body.trim().slice(0, 500);
  switch (true) {
    case status === 401 || status === 403:
      return new OllamaRequestError(`API Key 无效或权限不足${detail ? `：${detail}` : ''}`, 'auth', status);
    case status === 404:
      return new OllamaRequestError(`模型不存在或接口路径错误${detail ? `：${detail}` : ''}`, 'not-found', status);
    case status === 429:
      return new OllamaRequestError('请求频率过高，请稍后重试', 'rate-limit', status);
    case status >= 500:
      return new OllamaRequestError(
        `Ollama 服务异常（HTTP ${status}）${detail ? `：${detail}` : ''}`,
        'server',
        status,
      );
    default:
      return new OllamaRequestError(
        `Ollama 请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`,
        'unknown',
        status,
      );
  }
}

export function classifyNetworkError(err: unknown, aborted = false): OllamaRequestError {
  if (aborted || (err as { name?: string })?.name === 'AbortError') {
    return new OllamaRequestError('请求已取消', 'aborted');
  }
  const causes = collectErrorCodes(err);
  const message = err instanceof Error ? err.message : String(err);
  if (causes.some((c) => /CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(c))) {
    return new OllamaRequestError('TLS 证书校验失败，请检查 HTTPS 地址或证书配置', 'tls');
  }
  if (causes.some((c) => /ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ETIMEDOUT/i.test(c))) {
    return new OllamaRequestError('无法连接 Ollama，请检查地址、网络或代理设置', 'network');
  }
  return new OllamaRequestError(`无法连接 Ollama：${message}`, 'network');
}

function collectErrorCodes(err: unknown, depth = 0): string[] {
  if (!err || depth > 4 || typeof err !== 'object') return [];
  const out: string[] = [];
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === 'string') out.push(e.code);
  if (typeof e.message === 'string') out.push(e.message);
  if (e.cause) out.push(...collectErrorCodes(e.cause, depth + 1));
  return out;
}

export function toProxyError(err: unknown): OllamaProxyError {
  if (err instanceof OllamaRequestError) {
    return { kind: err.kind, status: err.status, message: err.message };
  }
  if (err instanceof Error) {
    return { kind: 'unknown', message: err.message };
  }
  return { kind: 'unknown', message: String(err) };
}
