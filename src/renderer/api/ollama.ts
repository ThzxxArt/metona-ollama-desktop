/**
 * Ollama API 客户端封装
 */

import type {
  OllamaChatParams, OllamaStreamChunk, OllamaModelsResponse,
  OllamaPsResponse, OllamaVersionResponse, OllamaModelDetail,
  OllamaEmbedResponse, ToolDefinition
} from '../types.js';

export class OllamaAPI {
  baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:11434') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async _request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const config: RequestInit = {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string> || {}) }
    };
    const response = await fetch(url, config);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Ollama API 错误 ${response.status}: ${errorBody || response.statusText}`);
    }
    return response;
  }

  private async _json<T = unknown>(path: string, body: unknown = null, signal?: AbortSignal): Promise<T> {
    const options: RequestInit = body ? { method: 'POST', body: JSON.stringify(body) } : {};
    if (signal) options.signal = signal;
    const response = await this._request(path, options);
    return response.json() as Promise<T>;
  }

  async listModels(): Promise<OllamaModelsResponse> {
    return this._json('/api/tags');
  }

  async psModels(): Promise<OllamaPsResponse> {
    return this._json('/api/ps');
  }

  async getVersion(): Promise<OllamaVersionResponse> {
    return this._json('/api/version');
  }

  async showModel(model: string): Promise<OllamaModelDetail> {
    return this._json('/api/show', { model });
  }

  async chat(params: Omit<OllamaChatParams, 'stream'> & { signal?: AbortSignal }): Promise<unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream: false,
      keep_alive: '1h',
    };
    if (params.think !== undefined) body.think = params.think;
    if (params.system) body.system = params.system;
    if (params.keep_alive !== undefined) body.keep_alive = params.keep_alive;
    if (params.options) body.options = params.options;
    return this._json('/api/chat', body, params.signal);
  }

  async chatStream(
    params: OllamaChatParams & { tools?: ToolDefinition[] },
    onChunk: (chunk: OllamaStreamChunk) => void,
    abortController?: AbortController
  ): Promise<void> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream: true,
      keep_alive: '1h',
    };
    if (params.think !== undefined) body.think = params.think;
    if (params.system) body.system = params.system;
    if (params.keep_alive !== undefined) body.keep_alive = params.keep_alive;
    if (params.options) body.options = params.options;
    if (params.tools?.length) body.tools = params.tools;

    const fetchOptions: RequestInit = {
      method: 'POST',
      body: JSON.stringify(body)
    };

    if (abortController) {
      fetchOptions.signal = abortController.signal;
    }

    const response = await this._request('/api/chat', fetchOptions);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    if (abortController) {
      abortController.signal.addEventListener('abort', () => {
        reader.cancel();
      }, { once: true });
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk: OllamaStreamChunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue; // 跳过无法解析的行（可能是不完整的 JSON）
          }
          // onChunk 回调错误不再被静默吞掉，而是向上传播给调用方
          if (onChunk) onChunk(chunk);
          if (chunk.done) {
            return;
          }
        }
      }
    } catch (err) {
      // abort 导致 reader.cancel() 会使 reader.read() 抛出异常，属于正常中止流程
      if (abortController?.signal.aborted) return;
      throw err;
    }

    if (buffer.trim()) {
      let chunk: OllamaStreamChunk;
      try {
        chunk = JSON.parse(buffer);
      } catch {
        return; // 末尾 buffer 无法解析，忽略
      }
      if (onChunk) onChunk(chunk);
    }
  }

  async embed(model: string, input: string): Promise<OllamaEmbedResponse> {
    return this._json('/api/embed', { model, input });
  }
}
