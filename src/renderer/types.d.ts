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
  /** 标记此消息为 Plan Mode 约束消息（首轮禁止工具调用），批准后据此精确清理 */
  planConstraint?: boolean;
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
  name: string;
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
  /** 多视频独立指示牌 */
  _videos?: Array<{ fileName: string; frameCount: number; duration: number }>;
  stopped?: boolean;
  interrupted?: boolean;
  toolCalls?: ToolCallRecord[];
  /** 标记此消息为 LLM 压缩摘要生成 */
  compressed?: boolean;
  /** 实际发送给模型的完整系统提示词（调试用） */
  _systemPrompt?: string;
  /** 实际发送给模型的用户消息内容（含文件/图片/视频帧描述，不显示给用户） */
  _apiContent?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
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
    openDirectory: () => Promise<string[] | null>;
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
  memoryAccess?: {
    read: () => Promise<{ success: boolean; content?: string; error?: string }>;
    write: (content: string) => Promise<{ success: boolean; error?: string }>;
    init: () => Promise<{ success: boolean; action: string; existed: boolean; valid: boolean; backedUp?: string; error?: string }>;
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
  | '_defaultModel'
  | '_lastSystemPrompt'
  | '_currentEvalCount'
  | '_abortToolRecords'
  | '_loopState'
  | '_loopContext'
  | 'modelSupportsTools'
  | 'maxTurns'
  | 'streamTimeout'
  | 'subAgentMaxLoops'
  | 'subAgentTimeout'
  | 'subAgentModel'
  | 'agentMode'
  | 'loopWatchdogMs'
  | '_planTracker'
  | '_planResumeData'
  | 'globalToolMode'
  | 'planAutoConfirm';

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
// Harness Engineering: Agent Loop 状态机
// ═══════════════════════════════════════════════════════════

/** Agent Loop 状态枚举 */
export type LoopState =
  | 'INIT'           // 构建系统提示词、准备上下文
  | 'THINKING'       // 调用 LLM 流式
  | 'PARSING'        // 解析输出（tool_calls 提取 + 文本兜底）
  | 'EXECUTING'      // 执行工具（按批次并行）
  | 'OBSERVING'      // 收集工具结果、格式化
  | 'REFLECTING'     // 反思：去重检测、过早停止检测、Final Answer 检测
  | 'COMPRESSING'    // 触发上下文压缩
  | 'TERMINATED';    // 终止

/** Agent Loop 上下文（可序列化，支持暂停/恢复） */
export interface LoopContext {
  /** 状态机当前状态 */
  state: LoopState;
  /** 会话 ID */
  sessionId: string;
  /** 当前循环计数 */
  loopCount: number;
  /** 最大循环次数 */
  maxLoops: number;
  /** 当前轮模型输出内容 */
  content: string;
  /** 当前轮思考内容 */
  thinking: string;
  /** 本轮工具调用列表 */
  toolCalls: ToolCall[];
  /** 所有工具调用记录 */
  allToolRecords: ToolCallRecord[];
  /** 消息列表（Ollama 格式） */
  messages: OllamaMessage[];
  /** 累计 eval tokens */
  totalEvalCount: number;
  /** 累计 prompt_eval tokens */
  totalPromptEvalCount: number;
  /** 累计推理时间（纳秒） */
  totalInferenceNs: number;
  /** 本轮 eval tokens */
  loopEvalCount: number;
  /** 本轮 prompt_eval tokens */
  loopPromptEvalCount: number;
  /** 本轮推理时间 */
  loopInferenceNs: number;
  /** 上一轮成功工具调用的缓存键（用于去重） */
  prevLoopSuccessKeys: string[];
  /** 上一轮工具调用（用于 onNewIteration） */
  prevToolCalls: ToolCall[];
  /** Agent 模式：auto（直接执行）| plan（先规划后执行） */
  mode: AgentMode;
  /** Plan 模式下等待用户确认的 Promise resolve */
  planApproved?: boolean;
  /** Plan Mode 重试计数（防止无限循环） */
  planRetries: number;
  /** 循环开始时间 */
  startTime: number;
  /** 上一轮独立 stats（供 onNewIteration / makeStats 使用，避免累计值导致重复计算） */
  lastLoopStats?: {
    eval_count?: number;
    prompt_eval_count?: number;
    total_duration?: number;
  };
  /** R8 紧急压缩重试计数（防止溢出→压缩→重试无限循环） */
  emergencyCompressCount: number;
  /** 上下文压缩标记 — 防止同一轮重复触发压缩 */
  compressedThisCycle: boolean;
}

/** Agent 运行模式 */
export type AgentMode = 'auto' | 'plan';

/** System Prompt 分区（支持 LLM Prefix Caching） */
export interface SystemPromptZones {
  /** 静态区：SOUL.md + 环境基础 → 利用 LLM Prefix Caching */
  staticZone: string;
  /** 动态区：记忆检索 + 工作空间 + 实时日期 */
  dynamicZone: string;
}

/** Hook 阶段 */
export type HookPhase = 'pre_tool' | 'post_tool' | 'post_iteration' | 'pre_completion';

/** Hook 执行结果 */
export interface HookResult {
  /** 是否通过 */
  passed: boolean;
  /** 消息（通过/失败原因） */
  message: string;
  /** 附加数据 */
  data?: Record<string, unknown>;
}

/** Harness Hook 接口 */
export interface HarnessHook {
  name: string;
  phase: HookPhase;
  priority: number;
  handler: (ctx: LoopContext, data: HookData) => Promise<HookResult>;
  enabled: boolean;
}

/** Hook 上下文数据 */
export interface HookData {
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: ToolResult;
  iterationIndex?: number;
  [key: string]: unknown;
}

/** Agent 度量指标 */
export interface AgentMetrics {
  totalSessions: number;
  avgIterationsPerTask: number;
  toolSuccessRate: number;
  frequentErrors: Array<{ pattern: string; count: number }>;
  tokenEfficiency: number;
  collectedAt: number;
}

/** 渐进式披露：上下文层级 */
export type ContextTier = 'index' | 'interface' | 'implementation';

/** 项目索引摘要 */
export interface ProjectIndex {
  structure: string;
  entryFiles: string[];
  techStack: string[];
  tokenCount: number;
  generatedAt: number;
}

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
  errorPattern?: string;
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
  attachments: string | null;
  eval_count: number | null;
  prompt_eval_count: number | null;
  total_duration: number | null;
  created_at: number;
}

export interface DBAPI {
  saveSession: (session: SessionRow) => Promise<{ success: boolean; id?: string; error?: string }>;
  getSession: (id: string) => Promise<SessionRow | null>;
  getAllSessions: () => Promise<SessionRow[]>;
  deleteSession: (id: string) => Promise<{ success: boolean; error?: string }>;
  clearAllSessions: () => Promise<{ success: boolean; error?: string }>;
  saveMessage: (msg: MessageRow) => Promise<{ success: boolean; id?: string; error?: string }>;
  getMessages: (sessionId: string) => Promise<MessageRow[]>;
  saveSetting: (key: string, value: unknown) => Promise<{ success: boolean; error?: string }>;
  getSetting: <T = unknown>(key: string, defaultValue?: T) => Promise<T>;
  saveTrace: (trace: unknown) => Promise<{ success: boolean; id?: string; error?: string }>;
  saveTracesBatch: (traces: unknown[]) => Promise<{ success: boolean; count?: number; error?: string }>;
  getTraces: (sessionId: string) => Promise<TraceEntry[]>;
  exportSessions: () => Promise<unknown>;
  importSessions: (data: unknown) => Promise<{ imported: number; skipped: number }>;

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
