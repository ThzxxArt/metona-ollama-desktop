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
    /** 无超时命令执行，用于 AI Tool Calling */
    execTool: (command: string, cwd?: string) => ipcRenderer.invoke('workspace:execTool', command, cwd),
    /** 终止当前 AI 工具命令 */
    killTool: () => ipcRenderer.invoke('workspace:killTool'),
    /** AI Tool Calling 命令输出 → 同步到工作空间终端 */
    onToolOutput: (callback: (data: { command: string; stdout: string; stderr: string; exitCode: number | null }) => void) => {
      ipcRenderer.on('workspace:toolOutput', (_: unknown, data: { command: string; stdout: string; stderr: string; exitCode: number | null }) => callback(data));
    }
  }
});
