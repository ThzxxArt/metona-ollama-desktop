/**
 * Ollama API 客户端（渲染进程薄封装）
 * 0.18.0 起所有请求统一走主进程代理，API Key 不进入渲染进程。
 */

import type {
  OllamaChatParams,
  OllamaStreamChunk,
  OllamaModelsResponse,
  OllamaPsResponse,
  OllamaVersionResponse,
  OllamaModelDetail,
  OllamaEmbedResponse,
  ToolDefinition,
} from '../types.js';
import type { OllamaBridgeAPI, OllamaChatRequestBody } from '../../shared/contracts/ollama.js';

function bridge(): OllamaBridgeAPI {
  const api = window.metonaDesktop?.ollama;
  if (!api) {
    throw new Error('Ollama 代理不可用：请在桌面端运行 Metona');
  }
  return api;
}

export class OllamaAPI {
  /** 仅用于 UI 展示当前服务地址；真实请求由主进程配置决定 */
  baseUrl: string;
  private _configLoaded = false;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  /** 从主进程同步连接配置（模式 / 地址 / 上下文） */
  async refreshConfig(): Promise<void> {
    try {
      const cfg = await bridge().getConfig();
      this.baseUrl = cfg.mode === 'local' ? cfg.localUrl : cfg.remoteUrl;
      this._configLoaded = true;
    } catch {
      // 保持构造时的地址，UI 会显示未连接
    }
  }

  private async _ensureConfig(): Promise<void> {
    if (!this._configLoaded) await this.refreshConfig();
  }

  private _body(params: OllamaChatParams & { tools?: ToolDefinition[] }): OllamaChatRequestBody {
    const body: OllamaChatRequestBody = {
      model: params.model,
      messages: params.messages,
    };
    if (params.think !== undefined) body.think = params.think;
    if (params.system) body.system = params.system;
    if (params.keep_alive !== undefined) body.keep_alive = params.keep_alive;
    if (params.format !== undefined) body.format = params.format;
    if (params.options) body.options = params.options;
    if (params.tools?.length) body.tools = params.tools;
    return body;
  }

  async listModels(): Promise<OllamaModelsResponse> {
    await this._ensureConfig();
    return bridge().models();
  }

  async psModels(): Promise<OllamaPsResponse> {
    await this._ensureConfig();
    return bridge().ps();
  }

  async getVersion(): Promise<OllamaVersionResponse> {
    const result = await this.testConnection();
    if (!result.ok || !result.version) {
      throw new Error(result.error || '无法连接 Ollama');
    }
    return { version: result.version };
  }

  async testConnection(): Promise<{
    ok: boolean;
    version?: string;
    modelCount?: number;
    latencyMs?: number;
    error?: string;
  }> {
    await this.refreshConfig();
    return bridge().test();
  }

  async showModel(model: string): Promise<OllamaModelDetail> {
    await this._ensureConfig();
    return (await bridge().show(model)) as OllamaModelDetail;
  }

  async chat(params: Omit<OllamaChatParams, 'stream'> & { signal?: AbortSignal }): Promise<unknown> {
    await this._ensureConfig();
    return bridge().chat(this._body(params as OllamaChatParams), params.signal);
  }

  async chatStream(
    params: OllamaChatParams & { tools?: ToolDefinition[] },
    onChunk: (chunk: OllamaStreamChunk) => void,
    abortController?: AbortController,
  ): Promise<void> {
    await this._ensureConfig();
    await bridge().chatStream(
      this._body(params),
      onChunk as (chunk: import('../../shared/contracts/ollama.js').OllamaStreamChunk) => void,
      abortController?.signal,
    );
  }

  async embed(model: string, input: string): Promise<OllamaEmbedResponse> {
    await this._ensureConfig();
    return bridge().embed(model, input);
  }

  /** 手动释放显存（本地 / 自建远程；云服务禁用） */
  async unloadModels(manual = true): Promise<{ success: boolean; unloaded: number; error?: string }> {
    return bridge().unload({ manual });
  }
}
