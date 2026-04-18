/**
 * Metona Ollama Desktop - Preload 脚本
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('metonaDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  dialog: {
    openFile: (filters?: unknown) => ipcRenderer.invoke('dialog:openFile', { filters }),
    saveFile: (options?: unknown) => ipcRenderer.invoke('dialog:saveFile', options)
  },
  fs: {
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
    readFileBase64: (filePath: string) => ipcRenderer.invoke('fs:readFileBase64', filePath),
    writeFile: (filePath: string, content: string, encoding?: string) => ipcRenderer.invoke('fs:writeFile', filePath, content, encoding)
  },
  tool: {
    execute: (toolName: string, args: Record<string, unknown>) => ipcRenderer.invoke('tool:execute', toolName, args),
    getConfig: () => ipcRenderer.invoke('tool:getConfig'),
    setAllowedDirs: (dirs: string[]) => ipcRenderer.invoke('tool:setAllowedDirs', dirs)
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
    deleteSession: (id: string) => ipcRenderer.invoke('db:deleteSession', id),
    clearAllSessions: () => ipcRenderer.invoke('db:clearAllSessions'),
    saveMessage: (msg: unknown) => ipcRenderer.invoke('db:saveMessage', msg),
    getMessages: (sessionId: string) => ipcRenderer.invoke('db:getMessages', sessionId),
    saveMemory: (entry: unknown) => ipcRenderer.invoke('db:saveMemory', entry),
    getMemory: (id: string) => ipcRenderer.invoke('db:getMemory', id),
    getAllMemories: () => ipcRenderer.invoke('db:getAllMemories'),
    getMemoriesByType: (type: string) => ipcRenderer.invoke('db:getMemoriesByType', type),
    deleteMemory: (id: string) => ipcRenderer.invoke('db:deleteMemory', id),
    clearAllMemories: () => ipcRenderer.invoke('db:clearAllMemories'),
    searchMemories: (query: string, limit?: number) => ipcRenderer.invoke('db:searchMemories', query, limit),
    saveSetting: (key: string, value: unknown) => ipcRenderer.invoke('db:saveSetting', key, value),
    getSetting: (key: string, defaultValue?: unknown) => ipcRenderer.invoke('db:getSetting', key, defaultValue),
    saveToolCall: (tc: unknown) => ipcRenderer.invoke('db:saveToolCall', tc),
    getToolCalls: (sessionId: string) => ipcRenderer.invoke('db:getToolCalls', sessionId),
    saveTrace: (trace: unknown) => ipcRenderer.invoke('db:saveTrace', trace),
    getTraces: (sessionId: string) => ipcRenderer.invoke('db:getTraces', sessionId),
    exportSessions: () => ipcRenderer.invoke('db:exportSessions'),
    importSessions: (data: unknown) => ipcRenderer.invoke('db:importSessions', data),
    // v4.2 Skills
    saveSkill: (skill: unknown) => ipcRenderer.invoke('db:saveSkill', skill),
    getAllSkills: () => ipcRenderer.invoke('db:getAllSkills'),
    deleteSkill: (id: string) => ipcRenderer.invoke('db:deleteSkill', id),
    clearAllSkills: () => ipcRenderer.invoke('db:clearAllSkills'),
    searchSkills: (query: string, limit?: number) => ipcRenderer.invoke('db:searchSkills', query, limit),
    incrementSkillUsage: (id: string, success: boolean, durationMs: number) => ipcRenderer.invoke('db:incrementSkillUsage', id, success, durationMs),
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
  }
});
