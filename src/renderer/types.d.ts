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

export interface ModelCaps {
  think: boolean;
  vision: boolean;
  tools: boolean;
  completion: boolean;
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

// ── Agent 记忆系统类型 ──

export type MemoryType = 'fact' | 'preference' | 'rule' | 'episode';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  importance: number;      // 1-10，越高越重要
  tags: string[];          // 用于快速匹配
  source?: string;         // 来源描述（如会话标题）
  sessionId?: string;      // 关联的会话 ID
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;      // 最后一次被回忆的时间
  useCount: number;        // 被回忆的次数
}

export interface MemorySearchResult extends MemoryEntry {
  score: number;           // 相关性得分
}

export interface MemoryExtractionResult {
  entries: Array<{
    type: MemoryType;
    content: string;
    importance: number;
    tags: string[];
  }>;
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

export interface WorkspaceFileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number | null;
  modified: string;
}

export interface WorkspaceDirResult {
  success: boolean;
  entries?: WorkspaceFileEntry[];
  error?: string;
}

export interface MetonaDesktopAPI {
  isDesktop: boolean;
  info: () => Promise<AppInfo>;
  dialog: {
    openFile: (options?: FileFilterOptions) => Promise<string[] | null>;
    saveFile: (options?: SaveFileOptions) => Promise<string | null>;
  };
  fs: {
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; name?: string; error?: string }>;
    writeFile: (filePath: string, content: string, encoding?: string) => Promise<{ success: boolean; error?: string }>;
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
  onAppQuit: (callback: () => void) => void;
  removeAllListeners: (channel: string) => void;
  onMainLog: (callback: (data: { level: string; message: string; detail?: string }) => void) => void;
  workspace: {
    getDir: () => Promise<{ dir: string; defaultDir: string }>;
    setDir: (dir: string) => Promise<{ success: boolean; dir?: string; error?: string }>;
    listDir: (dirPath?: string) => Promise<WorkspaceDirResult>;
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; path?: string; error?: string; truncated?: boolean; lines?: number }>;
    exec: (params: { id: string; command: string; cwd?: string }) => void;
    kill: (id: string) => void;
    onOutput: (callback: (data: { id: string; type: 'stdout' | 'stderr'; data: string }) => void) => void;
    onExit: (callback: (data: { id: string; code: number | null }) => void) => void;
    /** 无超时工具命令执行，用于 AI Tool Calling 集成 */
    execTool: (command: string, cwd?: string) => Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number | null; duration: number; userTerminated: boolean; truncated: boolean }>;
    /** AI Tool Calling 命令输出 → 同步到工作空间终端 */
    onToolOutput: (callback: (data: { command: string; stdout: string; stderr: string; exitCode: number | null }) => void) => void;
  };
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
  | 'toolCallingEnabled'
  | 'runCommandEnabled'
  | 'memoryEnabled'
  | 'memoryEntries';

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
  }
}

export {};
