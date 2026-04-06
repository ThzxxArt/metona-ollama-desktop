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

  private async _json<T = unknown>(path: string, body: unknown = null): Promise<T> {
    const options: RequestInit = body ? { method: 'POST', body: JSON.stringify(body) } : {};
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

  async chat(params: Omit<OllamaChatParams, 'stream'>): Promise<unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream: false,
    };
    if (params.think !== undefined) body.think = params.think;
    if (params.system) body.system = params.system;
    if (params.keep_alive !== undefined) body.keep_alive = params.keep_alive;
    if (params.options) body.options = params.options;
    return this._json('/api/chat', body);
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk: OllamaStreamChunk = JSON.parse(line);
          if (onChunk) onChunk(chunk);
          if (chunk.done) {
            reader.cancel();
            return;
          }
        } catch (err) {
          console.warn('[OllamaAPI] 流式数据解析警告:', (err as Error).message);
        }
      }
    }

    if (buffer.trim()) {
      try {
        const chunk: OllamaStreamChunk = JSON.parse(buffer);
        if (onChunk) onChunk(chunk);
      } catch { /* ignore */ }
    }
  }

  async embed(model: string, input: string): Promise<OllamaEmbedResponse> {
    return this._json('/api/embed', { model, input });
  }
}
