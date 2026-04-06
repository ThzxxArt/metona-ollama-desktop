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
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content)
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
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  }
});
