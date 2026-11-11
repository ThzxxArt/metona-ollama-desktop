/**
 * 第三方 LLM HTTP 传输：超时、取消、错误分类与 JSON 解析。
 */

import { loadOllamaSettings } from '../ollama/config.js';
import { classifyHttpError, classifyNetworkError, OllamaRequestError } from '../ollama/errors.js';

export interface ProviderRequestOptions {
  service: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function providerFetch(
  url: string,
  init: RequestInit,
  options: ProviderRequestOptions,
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? loadOllamaSettings().requestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options.signal;
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw classifyHttpError(response.status, body, options.service);
    }
    return response;
  } catch (err) {
    if (err instanceof OllamaRequestError) throw err;
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new OllamaRequestError(`${options.service} 请求超时（${Math.round(timeoutMs / 1000)}s）`, 'network');
    }
    throw classifyNetworkError(err, Boolean(externalSignal?.aborted), options.service);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function providerJson<T>(url: string, init: RequestInit, options: ProviderRequestOptions): Promise<T> {
  const response = await providerFetch(url, init, options);
  try {
    return (await response.json()) as T;
  } catch {
    throw new OllamaRequestError(`${options.service} 返回了非 JSON 响应`, 'server');
  }
}
