/**
 * Metona Ollama Desktop - Preload 脚本（sandbox 安全桥）
 * 只暴露领域 API，不暴露通用 ipcRenderer / Node 模块。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  OllamaBridgeAPI,
  OllamaChatRequestBody,
  OllamaConnectionSettings,
  OllamaConnectionView,
  OllamaEmbedResponse,
  OllamaModelsResponse,
  OllamaPsResponse,
  OllamaShowResponse,
  OllamaStreamChunk,
  OllamaTestResult,
} from '../shared/contracts/ollama.js';

interface SysInfo {
  homeDir: string;
  tmpDir: string;
  shell: string;
  arch: string;
  platform: string;
  hostname: string;
  username: string;
}

/** 系统信息通过同步 IPC 获取，preload 不直接 import os */
function readSysInfo(): SysInfo {
  try {
    const info = ipcRenderer.sendSync('app:sys:sync') as Partial<SysInfo> | undefined;
    if (info && typeof info === 'object') {
      return {
        homeDir: info.homeDir || '',
        tmpDir: info.tmpDir || '',
        shell: info.shell || '',
        arch: info.arch || '',
        platform: info.platform || '',
        hostname: info.hostname || '',
        username: info.username || '',
      };
    }
  } catch {
    // ignore
  }
  return { homeDir: '', tmpDir: '', shell: '', arch: '', platform: '', hostname: '', username: '' };
}

let streamSeq = 0;
function nextStreamId(): string {
  streamSeq += 1;
  return `stream-${Date.now()}-${streamSeq}`;
}

const ollama: OllamaBridgeAPI = {
  getConfig: (): Promise<OllamaConnectionView> => ipcRenderer.invoke('ollama:config:get'),
  setConfig: (patch: Partial<OllamaConnectionSettings>): Promise<OllamaConnectionView> =>
    ipcRenderer.invoke('ollama:config:set', patch),
  setApiKey: (key: string) => ipcRenderer.invoke('ollama:key:set', key),
  clearApiKey: () => ipcRenderer.invoke('ollama:key:clear'),
  test: (): Promise<OllamaTestResult> => ipcRenderer.invoke('ollama:test'),
  models: (): Promise<OllamaModelsResponse> => ipcRenderer.invoke('ollama:models'),
  show: (model: string): Promise<OllamaShowResponse> => ipcRenderer.invoke('ollama:show', model),
  ps: (): Promise<OllamaPsResponse> => ipcRenderer.invoke('ollama:ps'),
  chat: (body: OllamaChatRequestBody, signal?: AbortSignal) => {
    if (!signal) return ipcRenderer.invoke('ollama:chat', body);
    const requestId = nextStreamId();
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal.removeEventListener('abort', onAbort);
      const finish = (err?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(value);
      };
      const onAbort = (): void => {
        void ipcRenderer.invoke('ollama:chat:abortRequest', requestId);
        finish(new Error('请求已取消'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      ipcRenderer
        .invoke('ollama:chat', body, requestId)
        .then((value) => finish(undefined, value))
        .catch((err) => finish(err as Error));
    });
  },
  chatStream: (
    body: OllamaChatRequestBody,
    onChunk: (chunk: OllamaStreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const streamId = nextStreamId();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        ipcRenderer.removeListener('ollama:chat:chunk', onChunkEvent);
        ipcRenderer.removeListener('ollama:chat:done', onDoneEvent);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          // 本地回调抛错时，主进程的流仍在继续；主动 abort，避免后台空跑。
          void ipcRenderer.invoke('ollama:chat:abort', streamId);
          reject(err);
        } else {
          resolve();
        }
      };
      const onChunkEvent = (_e: unknown, data: { streamId: string; chunk: OllamaStreamChunk }): void => {
        if (data.streamId !== streamId) return;
        try {
          onChunk(data.chunk);
        } catch (err) {
          finish(err as Error);
        }
      };
      const onDoneEvent = (
        _e: unknown,
        data: { streamId: string; error?: { kind: string; message: string } },
      ): void => {
        if (data.streamId !== streamId) return;
        if (data.error && data.error.kind !== 'aborted') finish(new Error(data.error.message));
        else finish();
      };
      const onAbort = (): void => {
        void ipcRenderer.invoke('ollama:chat:abort', streamId);
      };

      ipcRenderer.on('ollama:chat:chunk', onChunkEvent);
      ipcRenderer.on('ollama:chat:done', onDoneEvent);
      signal?.addEventListener('abort', onAbort, { once: true });

      ipcRenderer.invoke('ollama:chat:start', body, streamId).catch((err) => finish(err as Error));
    });
  },
  embed: (model: string, input: string): Promise<OllamaEmbedResponse> =>
    ipcRenderer.invoke('ollama:embed', { model, input }),
  unload: (options?: { manual?: boolean }) => ipcRenderer.invoke('ollama:unload', options),
  onStreamChunk: (callback) => {
    const handler = (_e: unknown, data: { streamId: string; chunk: OllamaStreamChunk }): void => callback(data);
    ipcRenderer.on('ollama:chat:chunk', handler);
    return () => ipcRenderer.removeListener('ollama:chat:chunk', handler);
  },
  onStreamDone: (callback) => {
    const handler = (_e: unknown, data: { streamId: string; error?: { kind: string; message: string } }): void =>
      callback({ streamId: data.streamId, error: data.error as never });
    ipcRenderer.on('ollama:chat:done', handler);
    return () => ipcRenderer.removeListener('ollama:chat:done', handler);
  },
};

contextBridge.exposeInMainWorld('metonaDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  /** 读取应用内置资源（SOUL.md / AGENT.md），basename 防路径穿越 */
  readAppResource: (name: string) => ipcRenderer.invoke('app:readResource', name),
  sys: readSysInfo(),
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
  ollama,
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
    getSessionSummaries: () => ipcRenderer.invoke('db:getSessionSummaries'),
    searchSessions: (query: string) => ipcRenderer.invoke('db:searchSessions', query),
    getAllSessionsData: () => ipcRenderer.invoke('db:getAllSessionsData'),
    deleteSession: (id: string) => ipcRenderer.invoke('db:deleteSession', id),
    clearAllSessions: () => ipcRenderer.invoke('db:clearAllSessions'),
    saveMessage: (msg: unknown) => ipcRenderer.invoke('db:saveMessage', msg),
    saveMessagesBatch: (msgs: unknown[]) => ipcRenderer.invoke('db:saveMessagesBatch', msgs),
    getMessages: (sessionId: string) => ipcRenderer.invoke('db:getMessages', sessionId),
    getMessageIds: (sessionId: string) => ipcRenderer.invoke('db:getMessageIds', sessionId),
    deleteMessages: (sessionId: string, ids: string[]) => ipcRenderer.invoke('db:deleteMessages', sessionId, ids),
    saveSetting: (key: string, value: unknown) => ipcRenderer.invoke('db:saveSetting', key, value),
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
    getMemoryEmbeddings: (model: string) => ipcRenderer.invoke('db:getMemoryEmbeddings', model),
    saveMemoryEmbedding: (entryId: string, model: string, vector: number[]) => ipcRenderer.invoke('db:saveMemoryEmbedding', entryId, model, vector),
    clearMemoryEmbeddings: () => ipcRenderer.invoke('db:clearMemoryEmbeddings'),
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
    execTool: (command: string, cwd?: string) => ipcRenderer.invoke('tool:execute', 'run_command', { command, cwd }),
    onCmdOutput: (callback: (data: { command: string; type: 'stdout' | 'stderr'; data: string }) => void) => {
      ipcRenderer.on('cmd:output', (_: unknown, data: { command: string; type: 'stdout' | 'stderr'; data: string }) => callback(data));
    },
    onCmdDone: (callback: (data: { command: string; exitCode: number | null }) => void) => {
      ipcRenderer.on('cmd:done', (_: unknown, data: { command: string; exitCode: number | null }) => callback(data));
    },
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
