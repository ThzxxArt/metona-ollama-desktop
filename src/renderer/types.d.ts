// ── Ollama API 类型 ──

export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: string[];
  thinking?: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
  /** 标记此消息为 LLM 压缩摘要生成 */
  compressed?: boolean;
  /** 标记此消息为临时性消息（预算警告等），上下文裁剪时优先丢弃 */
  ephemeral?: boolean;
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
  prompt_eval_count?: number;
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
  model_info?: Record<string, any>;
  [key: string]: unknown;
}

export interface ModelCaps {
  think: boolean;
  vision: boolean;
  tools: boolean;
  completion: boolean;
  contextLength: number;
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

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
  think?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  total_duration?: number;
  images?: string[];
  files?: ChatFile[];
  _fileContents?: FileContent[];
  /** 视频帧数据（用于消息卡片渲染，不走 images 缩略图） */
  _videoFrames?: Array<{ name: string; base64: string; timestampSeconds: number }>;
  _videoMeta?: { fileName: string; duration: number; frameCount: number };
  stopped?: boolean;
  toolCalls?: ToolCallRecord[];
  /** 标记此消息为 LLM 压缩摘要生成 */
  compressed?: boolean;
  /** 实际发送给模型的完整系统提示词（调试用） */
  _systemPrompt?: string;
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

export type MemoryType = 'fact' | 'preference' | 'rule';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  importance: number;      // 1-10，越高越重要
  tags: string[];          // 用于快速匹配
  source?: string;         // 来源描述（如会话标题）
  sessionId?: string;      // 关联的会话 ID
  embedding?: number[];    // 向量嵌入
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

// ── 向量存储类型（用于记忆向量索引）──

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
  sys: {
    homeDir: string;
    tmpDir: string;
    shell: string;
    arch: string;
    platform: string;
    hostname: string;
    username: string;
  };
  dialog: {
    openFile: (options?: FileFilterOptions) => Promise<string[] | null>;
    saveFile: (options?: SaveFileOptions) => Promise<string | null>;
  };
  fs: {
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; name?: string; error?: string }>;
    readFileBase64: (filePath: string) => Promise<{ success: boolean; content?: string; size?: number; name?: string; error?: string }>;
    writeFile: (filePath: string, content: string, encoding?: string) => Promise<{ success: boolean; error?: string }>;
  };
  tool: {
    execute: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
    getConfig: () => Promise<{ allowedDirs: string[]; blockedDirs: string[] }>;
    setAllowedDirs: (dirs: string[]) => Promise<void>;
    setTimeouts: (timeouts: { http?: number; mcp?: number }) => Promise<{ success: boolean }>;
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
  db: DBAPI;
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
    execTool: (command: string, cwd?: string) => Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number | null; duration: number }>;
    /** AI 命令实时输出推送到工作空间终端 */
    onCmdOutput: (callback: (data: { command: string; type: 'stdout' | 'stderr'; data: string }) => void) => void;
    /** AI 命令执行完毕 */
    onCmdDone: (callback: (data: { command: string; exitCode: number | null }) => void) => void;
    /** 终止当前 AI 命令 */
    cmdKill: () => Promise<{ killed: boolean }>;
  };
  mcp: {
    startServer: (config: { name: string; command: string; args: string[]; enabled: boolean; description?: string }) => Promise<{ success: boolean; error?: string }>;
    stopServer: (name: string) => Promise<{ success: boolean }>;
    stopAll: () => Promise<{ success: boolean }>;
    callTool: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>;
    getTools: () => Promise<Array<{ serverName: string; name: string; fullName: string; description: string; inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] } }>>;
    getStatuses: () => Promise<Array<{ name: string; running: boolean; toolCount: number }>>;
    refreshTools: (name: string) => Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>>;
  };
  video: {
    extractFrames: (filePath: string, options?: { maxFrames?: number; maxWidth?: number; maxSize?: number }) => Promise<{
      success: boolean;
      frames?: Array<{ name: string; base64: string; timestampSeconds: number }>;
      videoInfo?: { duration: number; width: number; height: number };
      error?: string;
    }>;
    onProgress: (callback: (data: { current: number }) => void) => void;
    removeProgressListener: () => void;
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
  | 'numCtx'
  | 'historyPage'
  | 'historySearchQuery'
  | 'temperature'
  | 'thinkEnabled'
  | 'toolCallingEnabled'
  | 'runCommandMode'
  | 'memoryEnabled'
  | 'memoryEntries'
  | 'embeddingModel';

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

// ═══════════════════════════════════════════════════════════
// ReAct Trace 类型 (v4.0)
// ═══════════════════════════════════════════════════════════

export interface TraceEntry {
  id: string;
  sessionId: string;
  stepIndex: number;
  thought: string;
  action: string;
  actionInput: string;
  observation: string;
  loopCount: number;
  createdAt: number;
}

// ═══════════════════════════════════════════════════════════
// SQLite DB IPC 接口 (v4.0)
// ═══════════════════════════════════════════════════════════

export interface SessionRow {
  id: string;
  title: string;
  model: string;
  system_prompt: string | null;
  parent_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string | null;
  thinking: string | null;
  images: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  eval_count: number | null;
  total_duration: number | null;
  created_at: number;
}

export interface MemoryRow {
  id: string;
  type: string;
  content: string;
  importance: number;
  tags: string | null;
  source: string | null;
  session_id: string | null;
  use_count: number;
  embedding: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number;
}

export interface DBAPI {
  saveSession: (session: SessionRow) => Promise<{ success: boolean; id?: string; error?: string }>;
  getSession: (id: string) => Promise<SessionRow | null>;
  getAllSessions: () => Promise<SessionRow[]>;
  deleteSession: (id: string) => Promise<{ success: boolean; error?: string }>;
  clearAllSessions: () => Promise<{ success: boolean; error?: string }>;
  saveMessage: (msg: MessageRow) => Promise<{ success: boolean; id?: string; error?: string }>;
  getMessages: (sessionId: string) => Promise<MessageRow[]>;
  saveMemory: (entry: MemoryRow) => Promise<{ success: boolean; id?: string; error?: string }>;
  getMemory: (id: string) => Promise<MemoryRow | null>;
  getAllMemories: () => Promise<MemoryRow[]>;
  getMemoriesByType: (type: string) => Promise<MemoryRow[]>;
  deleteMemory: (id: string) => Promise<{ success: boolean; error?: string }>;
  clearAllMemories: () => Promise<{ success: boolean; error?: string }>;
  searchMemories: (query: string, limit?: number) => Promise<MemoryRow[]>;
  saveSetting: (key: string, value: unknown) => Promise<{ success: boolean; error?: string }>;
  getSetting: <T = unknown>(key: string, defaultValue?: T) => Promise<T>;
  saveToolCall: (tc: unknown) => Promise<{ success: boolean; id?: string; error?: string }>;
  getToolCalls: (sessionId: string) => Promise<unknown[]>;
  saveTrace: (trace: unknown) => Promise<{ success: boolean; id?: string; error?: string }>;
  getTraces: (sessionId: string) => Promise<TraceEntry[]>;
  exportSessions: () => Promise<unknown>;
  importSessions: (data: unknown) => Promise<{ imported: number; skipped: number }>;
  // v4.2 Skills
  saveSkill: (skill: unknown) => Promise<{ success: boolean; id?: string; error?: string }>;
  getAllSkills: () => Promise<unknown[]>;
  deleteSkill: (id: string) => Promise<{ success: boolean; error?: string }>;
  clearAllSkills: () => Promise<{ success: boolean; error?: string }>;
  searchSkills: (query: string, limit?: number) => Promise<unknown[]>;
  incrementSkillUsage: (id: string, success: boolean, durationMs: number) => Promise<{ success: boolean; error?: string }>;
  getAllTokenStats(): Promise<{
    sessions: Array<{
      session_id: string;
      title: string;
      model: string;
      created_at: number;
      total_input: number;
      total_output: number;
      total_duration: number;
      round_count: number;
    }>;
    totals: {
      total_input: number;
      total_output: number;
      total_duration: number;
      total_rounds: number;
      session_count: number;
    };
  } | null>;
}

// ── Window global 声明 ──

declare global {
  interface Window {
    metonaDesktop?: MetonaDesktopAPI;
  }
}

export {};
