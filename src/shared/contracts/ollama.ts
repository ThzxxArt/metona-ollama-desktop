/**
 * LLM 连接契约（主进程 / preload / 渲染进程共享）
 * 支持 Ollama、OpenAI Chat Completions 兼容、Anthropic Messages 兼容。
 */

export type OllamaMode = 'local' | 'remote';
export type RemoteKind = 'cloud' | 'self-hosted';
export type LlmProvider = 'ollama' | 'openai' | 'anthropic';

export const LOCAL_DEFAULT_URL = 'http://127.0.0.1:11434';
export const REMOTE_CLOUD_URL = 'https://ollama.com';
export const OPENAI_DEFAULT_URL = 'https://api.openai.com';
export const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com';

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
};
export const DEFAULT_CONTEXT_LENGTH = 131072;
export const MIN_CONTEXT_LENGTH = 1024;
export const MAX_CONTEXT_LENGTH = 4194304;
export const DEFAULT_REQUEST_TIMEOUT_MS = 900_000;
export const DEFAULT_UNLOAD_TIMEOUT_MS = 5_000;

export interface OllamaConnectionSettings {
  provider: LlmProvider;
  mode: OllamaMode;
  localUrl: string;
  remoteUrl: string;
  openaiUrl: string;
  anthropicUrl: string;
  remoteKind: RemoteKind;
  contextLength: number;
  remoteAutoUnload: boolean;
  requestTimeoutMs: number;
}

export interface OllamaConnectionView extends OllamaConnectionSettings {
  hasApiKey: boolean;
  /** safeStorage 不可用时为 false（Key 仅当前会话有效） */
  keyStorageAvailable: boolean;
}

export const DEFAULT_OLLAMA_CONNECTION: OllamaConnectionSettings = {
  provider: 'ollama',
  mode: 'local',
  localUrl: LOCAL_DEFAULT_URL,
  remoteUrl: REMOTE_CLOUD_URL,
  openaiUrl: OPENAI_DEFAULT_URL,
  anthropicUrl: ANTHROPIC_DEFAULT_URL,
  remoteKind: 'cloud',
  contextLength: DEFAULT_CONTEXT_LENGTH,
  remoteAutoUnload: true,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
};

export interface OllamaChatRequestBody {
  model: string;
  messages: unknown[];
  stream?: boolean;
  think?: boolean | 'low' | 'medium' | 'high';
  system?: string;
  tools?: unknown[];
  keep_alive?: number | string;
  format?: unknown;
  options?: Record<string, unknown>;
}

export interface OllamaTestResult {
  ok: boolean;
  provider?: LlmProvider;
  version?: string;
  modelCount?: number;
  latencyMs?: number;
  error?: string;
  errorKind?: OllamaErrorKind;
}

export type OllamaErrorKind =
  'auth' | 'not-found' | 'rate-limit' | 'server' | 'tls' | 'network' | 'invalid-url' | 'aborted' | 'unknown';

export interface OllamaProxyError {
  kind: OllamaErrorKind;
  status?: number;
  message: string;
}

export interface OllamaStreamChunk {
  model?: string;
  message?: {
    role: string;
    content?: string;
    thinking?: string;
    reasoning_content?: string;
    tool_calls?: unknown[];
  };
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  total_duration?: number;
  error?: string;
}

export interface OllamaModelInfo {
  name: string;
  size?: number;
  digest?: string;
  modified_at?: string;
  remote_model?: string;
  remote_host?: string;
}

export interface OllamaModelsResponse {
  models: OllamaModelInfo[];
}

export interface OllamaPsModel {
  name: string;
  size_vram?: number;
  context_length?: number;
  [key: string]: unknown;
}

export interface OllamaPsResponse {
  models?: OllamaPsModel[];
}

export interface OllamaVersionResponse {
  version: string;
  provider?: LlmProvider;
}

export interface OllamaEmbedResponse {
  embedding?: number[];
  embeddings?: number[][];
}

export interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OllamaStreamEvent {
  streamId: string;
  chunk: OllamaStreamChunk;
}

export interface OllamaStreamDoneEvent {
  streamId: string;
  error?: OllamaProxyError;
}

/** 渲染进程可见的 Ollama 桥（preload 暴露） */
export interface OllamaBridgeAPI {
  getConfig: () => Promise<OllamaConnectionView>;
  setConfig: (patch: Partial<OllamaConnectionSettings>) => Promise<OllamaConnectionView>;
  setApiKey: (key: string, provider?: LlmProvider) => Promise<{ success: boolean; hasApiKey: boolean; error?: string }>;
  clearApiKey: (provider?: LlmProvider) => Promise<{ success: boolean; hasApiKey: boolean }>;
  test: () => Promise<OllamaTestResult>;
  models: () => Promise<OllamaModelsResponse>;
  show: (model: string) => Promise<OllamaShowResponse>;
  ps: () => Promise<OllamaPsResponse>;
  /**
   * 非流式聊天。requestId 由渲染进程生成，用于通过 abortRequest 取消。
   * 不能传 AbortSignal：contextBridge 无法保留 AbortSignal 的方法。
   */
  chat: (body: OllamaChatRequestBody, requestId?: string) => Promise<unknown>;
  /** 流式聊天。requestId 用于通过 abortStream 取消。 */
  chatStream: (
    body: OllamaChatRequestBody,
    onChunk: (chunk: OllamaStreamChunk) => void,
    requestId?: string,
  ) => Promise<void>;
  abortRequest: (requestId: string) => Promise<{ success: boolean }>;
  abortStream: (streamId: string) => Promise<{ success: boolean }>;
  embed: (model: string, input: string) => Promise<OllamaEmbedResponse>;
  unload: (options?: { manual?: boolean }) => Promise<{ success: boolean; unloaded: number; error?: string }>;
  onStreamChunk: (callback: (event: OllamaStreamEvent) => void) => () => void;
  onStreamDone: (callback: (event: OllamaStreamDoneEvent) => void) => () => void;
}
