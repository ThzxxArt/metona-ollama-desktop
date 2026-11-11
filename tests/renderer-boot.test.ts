// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const noop = () => {};
const asyncNoop = async () => ({ success: true });
const unsub = () => noop;

function makeBridge() {
  return {
    isDesktop: true,
    info: async () => ({
      version: '0.18.0',
      platform: 'linux',
      arch: 'x64',
      electronVersion: '45',
      userDataPath: '/tmp',
    }),
    checkUpdate: async () => ({ hasUpdate: false }),
    readAppResource: async () => ({ success: true, content: '' }),
    sys: {
      homeDir: '/home/test',
      tmpDir: '/tmp',
      shell: 'bash',
      arch: 'x64',
      platform: 'linux',
      hostname: 'test',
      username: 'test',
    },
    dialog: { openFile: async () => null, saveFile: async () => null, openDirectory: async () => null },
    fs: {
      readFile: async () => ({ success: true, content: '' }),
      readFileBase64: async () => ({ success: true, content: '', size: 0 }),
      writeFile: asyncNoop,
    },
    tool: {
      execute: async () => ({ success: true }),
      getConfig: async () => ({ allowedDirs: [], blockedDirs: [] }),
      setAllowedDirs: noop,
      setTimeouts: asyncNoop,
    },
    ollama: {
      getConfig: async () => ({
        mode: 'local',
        localUrl: 'http://127.0.0.1:11434',
        remoteUrl: 'https://ollama.com',
        remoteKind: 'cloud',
        contextLength: 131072,
        remoteAutoUnload: true,
        requestTimeoutMs: 900000,
        hasApiKey: false,
        keyStorageAvailable: true,
      }),
      setConfig: async () => ({
        mode: 'local',
        localUrl: 'http://127.0.0.1:11434',
        remoteUrl: 'https://ollama.com',
        remoteKind: 'cloud',
        contextLength: 131072,
        remoteAutoUnload: true,
        requestTimeoutMs: 900000,
        hasApiKey: false,
        keyStorageAvailable: true,
      }),
      setApiKey: async () => ({ success: true, hasApiKey: true }),
      clearApiKey: async () => ({ success: true, hasApiKey: false }),
      test: async () => ({ ok: true, version: '0.40.16', modelCount: 0, latencyMs: 1 }),
      models: async () => ({ models: [] }),
      show: async () => ({ capabilities: [], model_info: {} }),
      ps: async () => ({ models: [] }),
      chat: async () => ({ message: { content: '' } }),
      chatStream: async () => {},
      embed: async () => ({ embedding: [] }),
      unload: async () => ({ success: true, unloaded: 0 }),
      onStreamChunk: unsub,
      onStreamDone: unsub,
    },
    notify: asyncNoop,
    window: { minimize: asyncNoop, maximize: asyncNoop, close: asyncNoop },
    openExternal: asyncNoop,
    onMenuAction: unsub,
    onTrayAction: unsub,
    onAppQuit: unsub,
    removeAllListeners: noop,
    onMainLog: unsub,
    db: {
      saveSession: async () => ({ success: true, id: 's' }),
      getSession: async () => null,
      getAllSessions: async () => [],
      getSessionSummaries: async () => [],
      searchSessions: async () => [],
      getAllSessionsData: async () => ({ sessions: [], messages: [] }),
      deleteSession: asyncNoop,
      clearAllSessions: asyncNoop,
      saveMessage: asyncNoop,
      saveMessagesBatch: asyncNoop,
      getMessages: async () => [],
      getMessageIds: async () => [],
      deleteMessages: async () => ({ success: true }),
      saveSetting: asyncNoop,
      saveSettingsBatch: asyncNoop,
      getSetting: async (_key: string, fallback: unknown) => fallback,
      saveTrace: asyncNoop,
      saveTracesBatch: asyncNoop,
      getTraces: async () => [],
      exportSessions: async () => null,
      importSessions: async () => ({ imported: 0, skipped: 0 }),
      getAllTokenStats: async () => null,
      saveToolAudit: asyncNoop,
      getToolAudits: async () => ({ success: true, audits: [] }),
      getAllToolAudits: async () => ({ success: true, audits: [] }),
      getMemoryEmbeddings: async () => [],
      saveMemoryEmbedding: asyncNoop,
      clearMemoryEmbeddings: asyncNoop,
    },
    workspace: {
      getDir: async () => ({ dir: '/tmp/ws', defaultDir: '/tmp/ws' }),
      setDir: async () => ({ success: true, dir: '/tmp/ws' }),
      listDir: async () => [],
      readFile: async () => ({ success: true, content: '' }),
      exec: noop,
      kill: noop,
      onOutput: unsub,
      onExit: unsub,
      execTool: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }),
      onCmdOutput: unsub,
      onCmdDone: unsub,
      cmdKill: async () => ({ killed: true }),
    },
    mcp: {
      startServer: asyncNoop,
      stopServer: asyncNoop,
      stopAll: asyncNoop,
      callTool: async () => ({ success: true }),
      getTools: async () => [],
      getStatuses: async () => [],
      refreshTools: async () => [],
    },
    video: {
      extractFrames: async () => ({ success: true, frames: [] }),
      onProgress: unsub,
      removeProgressListener: noop,
    },
    memoryAccess: {
      read: async () => ({ success: true, content: '' }),
      write: asyncNoop,
      init: async () => ({ success: true }),
    },
  };
}

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf-8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body;
  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = makeBridge();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: noop,
    removeEventListener: noop,
  }) as unknown as typeof window.matchMedia;
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame;
  window.scrollTo = noop;
});

describe('渲染进程启动 smoke', () => {
  it('main.ts 初始化全部 UI 组件不抛异常', async () => {
    const errors: string[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.message);
    window.addEventListener('error', onError);
    await import('../src/renderer/main.ts');
    await new Promise((r) => setTimeout(r, 50));
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(document.querySelector('.app-title')?.textContent).toBe('Metona Ollama');
  }, 15_000);
});
