// ── Ollama API 类型 ──

export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: string[];
  thinking?: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface OllamaChatParams {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  think?: boolean;
  system?: string;
  tools?: ToolDefinition[];
  keep_alive?: number | string;
  options?: {
    num_ctx?: number;
    temperature?: number;
    [key: string]: unknown;
  };
}

export interface OllamaStreamChunk {
  model?: string;
  message?: {
    role: string;
    content?: string;
    thinking?: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  };
  done?: boolean;
  eval_count?: number;
  total_duration?: number;
}

export interface OllamaModelInfo {
  name: string;
  size?: number;
  digest?: string;
  modified_at?: string;
}

export interface OllamaModelDetail {
  capabilities?: string[];
  [key: string]: unknown;
}

export interface OllamaVersionResponse {
  version: string;
}

export interface OllamaModelsResponse {
  models: OllamaModelInfo[];
}

export interface OllamaPsResponse {
  models?: Array<{
    name: string;
    size_vram?: number;
    [key: string]: unknown;
  }>;
}

export interface OllamaEmbedResponse {
  embedding?: number[];
  embeddings?: number[][];
}

// ── 会话类型 ──

export interface ChatFile {
  name: string;
  language?: string;
  size?: number;
}

export interface FileContent {
  language: string;
  content: string;
}

export interface RagSource {
  filename: string;
  score: number;
  text: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  model?: string;
  think?: string;
  eval_count?: number;
  total_duration?: number;
  images?: string[];
  files?: ChatFile[];
  _fileContents?: FileContent[];
  ragSources?: RagSource[];
  stopped?: boolean;
  toolCalls?: ToolCallRecord[];
}

export interface ChatSession {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

// ── 预设类型 ──

export interface Preset {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
  temperature: number;
  numCtx: number;
  think: boolean;
  builtIn?: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── 知识库类型 ──

export interface VectorCollection {
  id: string;
  name: string;
  embeddingModel: string;
  docCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface VectorItem {
  id: string;
  collectionId: string;
  docId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  charCount: number;
  embedding: number[];
}

export interface SearchResult extends VectorItem {
  score: number;
}

export interface DocInfo {
  docId: string;
  filename: string;
  chunkCount: number;
}

// ── 桌面 Bridge 类型 ──

export interface MetonaDesktopAPI {
  isDesktop: boolean;
  info: () => Promise<AppInfo>;
  dialog: {
    openFile: (options?: FileFilterOptions) => Promise<string[] | null>;
    saveFile: (options?: SaveFileOptions) => Promise<string | null>;
  };
  fs: {
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; name?: string; error?: string }>;
    writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
  };
  tool: {
    execute: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
    getConfig: () => Promise<{ allowedDirs: string[]; blockedDirs: string[] }>;
    setAllowedDirs: (dirs: string[]) => Promise<void>;
  };
  notify: (title: string, body: string) => void;
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };
  openExternal: (url: string) => void;
  onMenuAction: (callback: (action: string) => void) => void;
  onTrayAction: (callback: (action: string) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  electronVersion: string;
  userDataPath: string;
}

export interface FileFilterOptions {
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface SaveFileOptions {
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

// ── 桌面 Bridge 接口 ──

export interface DesktopBridge {
  isDesktop: boolean;
  getInfo: () => Promise<{ platform: string; version: string; arch?: string; electronVersion?: string; userDataPath?: string }>;
  openFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string[] | null>;
  saveFile: (options?: SaveFileOptions) => Promise<string | null>;
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; name?: string; error?: string }>;
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
  notify: (title: string, body: string) => void;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  openExternal: (url: string) => void;
  onMenuAction: (callback: (action: string) => void) => void;
  onTrayAction: (callback: (action: string) => void) => void;
  off: (channel: string) => void;
}

// ── State Keys ──

export type StateKey =
  | 'db'
  | 'api'
  | 'currentSession'
  | 'isStreaming'
  | 'isHistoryView'
  | 'pendingImages'
  | 'abortController'
  | 'systemPrompt'
  | 'systemPromptEnabled'
  | 'numCtx'
  | 'historyPage'
  | 'historySearchQuery'
  | 'temperature'
  | 'thinkEnabled'
  | 'presets'
  | 'activePresetId'
  | 'toolCallingEnabled'
  | 'runCommandEnabled';

// ═══════════════════════════════════════════════════════════
// Tool Calling 类型
// ═══════════════════════════════════════════════════════════

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolParameters {
  type: 'object';
  required?: string[];
  properties: Record<string, ToolParameterProperty>;
}

export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}

export interface ToolCall {
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult | null;
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
  confirmed?: boolean;
  timestamp: number;
}

export type AgentState = 'idle' | 'sending' | 'accumulating' | 'executing' | 'confirming' | 'done';

// ── Window global 声明 ──

declare global {
  interface Window {
    metonaDesktop?: MetonaDesktopAPI;
    __metonaBridge?: DesktopBridge;
  }
}

export {};
