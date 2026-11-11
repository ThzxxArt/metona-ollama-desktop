/**
 * 主进程 Ollama 客户端：所有 Ollama HTTP 请求的唯一出口。
 * - API Key 只在主进程读取，按需注入 Authorization: Bearer
 * - 统一超时、重定向、错误分类、NDJSON 流解析
 */

import {
  buildApiUrl,
  getEffectiveBaseUrl,
  getEffectiveRemoteKind,
  isCloudConnection,
  loadOllamaSettings,
} from './config.js';
import { shouldUnloadModels } from '../../shared/unload-policy.js';
import { buildOllamaHeaders } from '../../shared/ollama-auth.js';
import { getOllamaSecretStore } from './secret-store.js';
import { classifyHttpError, classifyNetworkError, OllamaRequestError } from './errors.js';
import type {
  OllamaChatRequestBody,
  OllamaEmbedResponse,
  OllamaModelsResponse,
  OllamaPsResponse,
  OllamaShowResponse,
  OllamaStreamChunk,
  OllamaTestResult,
  OllamaVersionResponse,
} from '../../shared/contracts/ollama.js';

export interface OllamaClientOptions {
  /** 单次非流式请求超时，默认读取设置 */
  timeoutMs?: number;
}

function authHeaders(): Record<string, string> {
  return buildOllamaHeaders(getOllamaSecretStore().get());
}

export function getOllamaBaseUrl(): string {
  return getEffectiveBaseUrl(loadOllamaSettings());
}

async function request(path: string, init: RequestInit = {}, options: OllamaClientOptions = {}): Promise<Response> {
  const settings = loadOllamaSettings();
  const url = buildApiUrl(getOllamaBaseUrl(), path);
  const timeoutMs = options.timeoutMs ?? settings.requestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const externalSignal = init.signal;
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw classifyHttpError(response.status, body);
    }
    return response;
  } catch (err) {
    if (err instanceof OllamaRequestError) throw err;
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new OllamaRequestError(`Ollama 请求超时（${Math.round(timeoutMs / 1000)}s）`, 'network');
    }
    throw classifyNetworkError(err, Boolean(externalSignal?.aborted));
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function requestJson<T>(
  path: string,
  body?: unknown,
  options: OllamaClientOptions = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await request(
    path,
    body === undefined ? { method: 'GET', signal } : { method: 'POST', body: JSON.stringify(body), signal },
    options,
  );
  return (await response.json()) as T;
}

export async function getVersion(): Promise<OllamaVersionResponse> {
  return requestJson<OllamaVersionResponse>('/api/version');
}

export async function listModels(): Promise<OllamaModelsResponse> {
  return requestJson<OllamaModelsResponse>('/api/tags');
}

export async function psModels(): Promise<OllamaPsResponse> {
  return requestJson<OllamaPsResponse>('/api/ps');
}

export async function showModel(model: string): Promise<OllamaShowResponse> {
  return requestJson<OllamaShowResponse>('/api/show', { model });
}

export async function embed(model: string, input: string): Promise<OllamaEmbedResponse> {
  return requestJson<OllamaEmbedResponse>('/api/embed', { model, input });
}

export async function chat(body: OllamaChatRequestBody, signal?: AbortSignal): Promise<unknown> {
  return requestJson(
    '/api/chat',
    { ...body, stream: false },
    { timeoutMs: loadOllamaSettings().requestTimeoutMs },
    signal,
  );
}

export async function generate(
  body: { model: string; keep_alive?: number | string },
  options: OllamaClientOptions = {},
): Promise<unknown> {
  return requestJson('/api/generate', body, options);
}

export async function testConnection(): Promise<OllamaTestResult> {
  const started = Date.now();
  try {
    const version = await getVersion();
    const tags = await listModels();
    return {
      ok: true,
      version: version.version,
      modelCount: Array.isArray(tags.models) ? tags.models.length : 0,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof OllamaRequestError) {
      return { ok: false, error: err.message, errorKind: err.kind };
    }
    return { ok: false, error: (err as Error).message, errorKind: 'unknown' };
  }
}

/**
 * 流式聊天。解析 NDJSON；每行立即回调。
 * 取消通过 signal 控制，reader 会被释放。
 */
export async function chatStream(
  body: OllamaChatRequestBody,
  onChunk: (chunk: OllamaStreamChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await request(
    '/api/chat',
    { method: 'POST', body: JSON.stringify({ ...body, stream: true }) },
    { timeoutMs: loadOllamaSettings().requestTimeoutMs },
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Ollama 响应没有可读流');

  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = (): void => {
    reader.cancel().catch(() => {});
  };
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: OllamaStreamChunk;
        try {
          chunk = JSON.parse(line) as OllamaStreamChunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          throw new OllamaRequestError(chunk.error, 'server');
        }
        onChunk(chunk);
        if (chunk.done) return;
      }
    }
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer) as OllamaStreamChunk;
        if (chunk.error) throw new OllamaRequestError(chunk.error, 'server');
        onChunk(chunk);
      } catch (err) {
        if (err instanceof OllamaRequestError) throw err;
      }
    }
  } catch (err) {
    if (signal?.aborted) return;
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * 远程模型卸载：
 * - 本地：始终允许（保持原有退出释放显存行为）
 * - 远程自建：受 remoteAutoUnload 控制；手动调用不受开关限制
 * - Ollama Cloud：跳过
 */
export async function unloadModels(
  options: { manual?: boolean } = {},
): Promise<{ success: boolean; unloaded: number; error?: string }> {
  const settings = loadOllamaSettings();
  const effective = { ...settings, remoteKind: getEffectiveRemoteKind(settings) };
  if (!shouldUnloadModels(effective, Boolean(options.manual))) {
    // 自动路径（新建会话 / 退出）对 Cloud 静默跳过；只有用户手动释放才返回错误提示。
    if (isCloudConnection(settings) && options.manual) {
      return { success: false, unloaded: 0, error: 'Ollama Cloud 模型由服务端管理，不支持本地卸载' };
    }
    return { success: true, unloaded: 0 };
  }

  try {
    const ps = await psModels();
    const models = ps.models ?? [];
    const results = await Promise.allSettled(
      models.map(async (m) => {
        await generate({ model: m.name, keep_alive: 0 }, { timeoutMs: 10_000 });
      }),
    );
    const unloaded = results.filter((r) => r.status === 'fulfilled').length;
    return { success: true, unloaded };
  } catch (err) {
    return { success: false, unloaded: 0, error: (err as Error).message };
  }
}

/** 退出时卸载：带超时，绝不阻塞退出 */
export async function unloadModelsOnExit(timeoutMs = 5_000): Promise<void> {
  const settings = loadOllamaSettings();
  if (!shouldUnloadModels(settings, false)) return;
  await Promise.race([
    unloadModels().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
