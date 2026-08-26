/**
 * Metona Ollama Desktop - Preload 脚本
 */

import { contextBridge, ipcRenderer } from 'electron';
import * as os from 'os';

contextBridge.exposeInMainWorld('metonaDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  /** 读取应用内置资源（SOUL.md / AGENT.md），basename 防路径穿越 */
  readAppResource: (name: string) => ipcRenderer.invoke('app:readResource', name),
  /** 更新 Ollama 服务地址的 CORS 允许清单（设置面板保存地址后调用） */
  setOllamaOrigin: (url: string) => ipcRenderer.invoke('app:setOllamaOrigin', url),
  sys: {
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    shell: process.env.SHELL || process.env.ComSpec || (process.platform === 'win32' ? 'cmd.exe' : 'bash'),
    arch: os.arch(),
    platform: os.platform(),
    hostname: os.hostname(),
    username: os.userInfo().username,
  },
  dialog: {
    openFile: (options?: unknown) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (options?: unknown) => ipcRenderer.invoke('dialog:saveFile', options),
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory')
  },
  fs: {
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
    readFileBase64: (filePath: string) => ipcRenderer.invoke('fs:readFileBase64', filePath),
    writeFile: (filePath: string, content: string, encoding?: string) => ipcRenderer.invoke('fs:writeFile', filePath, content, encoding)
  },
  tool: {
    execute: (toolName: string, args: Record<string, unknown>) => ipcRenderer.invoke('tool:execute', toolName, args),
    getConfig: () => ipcRenderer.invoke('tool:getConfig'),
    setAllowedDirs: (dirs: string[]) => ipcRenderer.invoke('tool:setAllowedDirs', dirs),
    setTimeouts: (timeouts: { http?: number; mcp?: number }) => ipcRenderer.invoke('tool:setTimeouts', timeouts)
  },
  notify: (title: string, body: string) => ipcRenderer.invoke('notify', title, body),
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.on('menu-action', (_: unknown, action: string) => callback(action));
  },
  onTrayAction: (callback: (action: string) => void) => {
    ipcRenderer.on('tray-action', (_: unknown, action: string) => callback(action));
  },
  onAppQuit: (callback: () => void) => {
    ipcRenderer.on('app-quit', () => callback());
  },
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
  onMainLog: (callback: (data: { level: string; message: string; detail?: string }) => void) => {
    ipcRenderer.on('main:log', (_: unknown, data: { level: string; message: string; detail?: string }) => callback(data));
  },
  db: {
    saveSession: (session: unknown) => ipcRenderer.invoke('db:saveSession', session),
    getSession: (id: string) => ipcRenderer.invoke('db:getSession', id),
    getAllSessions: () => ipcRenderer.invoke('db:getAllSessions'),
    /** 会话摘要列表（单条 SQL，历史列表/搜索不再全量加载消息） */
    getSessionSummaries: () => ipcRenderer.invoke('db:getSessionSummaries'),
    /** 按标题或消息内容搜索会话 */
    searchSessions: (query: string) => ipcRenderer.invoke('db:searchSessions', query),
    /** 全量会话+消息行（导出用，一次 IPC 取代 N+1 往返） */
    getAllSessionsData: () => ipcRenderer.invoke('db:getAllSessionsData'),
    deleteSession: (id: string) => ipcRenderer.invoke('db:deleteSession', id),
    clearAllSessions: () => ipcRenderer.invoke('db:clearAllSessions'),
    saveMessage: (msg: unknown) => ipcRenderer.invoke('db:saveMessage', msg),
    saveMessagesBatch: (msgs: unknown[]) => ipcRenderer.invoke('db:saveMessagesBatch', msgs),
    getMessages: (sessionId: string) => ipcRenderer.invoke('db:getMessages', sessionId),
    saveSetting: (key: string, value: unknown) => ipcRenderer.invoke('db:saveSetting', key, value),
    /** 批量保存设置（单事务 + 单次刷盘） */
    saveSettingsBatch: (entries: Array<{ key: string; value: unknown }>) => ipcRenderer.invoke('db:saveSettingsBatch', entries),
    getSetting: (key: string, defaultValue?: unknown) => ipcRenderer.invoke('db:getSetting', key, defaultValue),
    saveTrace: (trace: unknown) => ipcRenderer.invoke('db:saveTrace', trace),
    saveTracesBatch: (traces: unknown[]) => ipcRenderer.invoke('db:saveTracesBatch', traces),
    getTraces: (sessionId: string) => ipcRenderer.invoke('db:getTraces', sessionId),
    exportSessions: () => ipcRenderer.invoke('db:exportSessions'),
    importSessions: (data: unknown) => ipcRenderer.invoke('db:importSessions', data),

    getAllTokenStats: () => ipcRenderer.invoke('db:getAllTokenStats'),
    saveToolAudit: (audit: unknown) => ipcRenderer.invoke('db:saveToolAudit', audit),
    getToolAudits: (sessionId: string) => ipcRenderer.invoke('db:getToolAudits', sessionId),
    getAllToolAudits: (limit?: number) => ipcRenderer.invoke('db:getAllToolAudits', limit),
  },
  workspace: {
    getDir: () => ipcRenderer.invoke('workspace:getDir'),
    setDir: (dir: string) => ipcRenderer.invoke('workspace:setDir', dir),
    listDir: (dirPath?: string) => ipcRenderer.invoke('workspace:listDir', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('workspace:readFile', filePath),
    exec: (params: { id: string; command: string; cwd?: string }) => {
      ipcRenderer.send('workspace:exec', params);
    },
    kill: (id: string) => {
      ipcRenderer.send('workspace:kill', id);
    },
    onOutput: (callback: (data: { id: string; type: 'stdout' | 'stderr'; data: string }) => void) => {
      ipcRenderer.on('workspace:output', (_: unknown, data: { id: string; type: 'stdout' | 'stderr'; data: string }) => callback(data));
    },
    onExit: (callback: (data: { id: string; code: number | null }) => void) => {
      ipcRenderer.on('workspace:exit', (_: unknown, data: { id: string; code: number | null }) => callback(data));
    },
    /** 无超时工具命令执行，用于 AI Tool Calling */
    execTool: (command: string, cwd?: string) => ipcRenderer.invoke('tool:execute', 'run_command', { command, cwd }),
    /** AI 命令实时输出推送到工作空间终端 */
    onCmdOutput: (callback: (data: { command: string; type: 'stdout' | 'stderr'; data: string }) => void) => {
      ipcRenderer.on('cmd:output', (_: unknown, data: { command: string; type: 'stdout' | 'stderr'; data: string }) => callback(data));
    },
    /** AI 命令执行完毕 */
    onCmdDone: (callback: (data: { command: string; exitCode: number | null }) => void) => {
      ipcRenderer.on('cmd:done', (_: unknown, data: { command: string; exitCode: number | null }) => callback(data));
    },
    /** 终止当前 AI 命令 */
    cmdKill: () => ipcRenderer.invoke('cmd:kill')
  },
  mcp: {
    startServer: (config: { name: string; command: string; args: string[]; enabled: boolean; description?: string }) => ipcRenderer.invoke('mcp:startServer', config),
    stopServer: (name: string) => ipcRenderer.invoke('mcp:stopServer', name),
    stopAll: () => ipcRenderer.invoke('mcp:stopAll'),
    callTool: (serverName: string, toolName: string, args: Record<string, unknown>) => ipcRenderer.invoke('mcp:callTool', serverName, toolName, args),
    getTools: () => ipcRenderer.invoke('mcp:getTools'),
    getStatuses: () => ipcRenderer.invoke('mcp:getStatuses'),
    refreshTools: (name: string) => ipcRenderer.invoke('mcp:refreshTools', name)
  },
  video: {
    extractFrames: (filePath: string, options?: { maxFrames?: number; maxWidth?: number; maxSize?: number }) =>
      ipcRenderer.invoke('video:extractFrames', filePath, options),
    onProgress: (callback: (data: { current: number }) => void) => {
      ipcRenderer.on('video:progress', (_: unknown, data: { current: number }) => callback(data));
    },
    removeProgressListener: () => {
      ipcRenderer.removeAllListeners('video:progress');
    }
  },
  memoryAccess: {
    read: () => ipcRenderer.invoke('memory:read'),
    write: (content: string, reason?: string) => ipcRenderer.invoke('memory:write', content, reason),
    init: () => ipcRenderer.invoke('memory:init'),
  }
});
