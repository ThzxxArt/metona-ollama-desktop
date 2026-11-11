import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  start: vi.fn(async () => ({ success: true })),
  stop: vi.fn(),
  stopAll: vi.fn(),
  call: vi.fn(async () => ({ success: true })),
  tools: vi.fn(() => []),
  statuses: vi.fn(() => []),
  refresh: vi.fn(async () => []),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => hoisted.handlers.set(c, f) },
}));
vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { id: 1, send: vi.fn() }, isDestroyed: () => false },
}));
vi.mock('../src/main/mcp-manager.js', () => ({
  startServer: hoisted.start,
  stopServer: hoisted.stop,
  stopAllServers: hoisted.stopAll,
  callTool: hoisted.call,
  getAllTools: hoisted.tools,
  getServerStatuses: hoisted.statuses,
  refreshTools: hoisted.refresh,
}));

import { registerMcpIPC } from '../src/main/ipc/mcp.js';

const event = {
  sender: { id: 1, getURL: () => 'file:///index.html' },
  senderFrame: { url: 'file:///index.html' },
};
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = hoisted.handlers.get(channel);
  if (!fn) throw new Error(`missing ${channel}`);
  return Promise.resolve(fn(event, ...args));
}

beforeEach(() => {
  hoisted.handlers.clear();
  vi.clearAllMocks();
  registerMcpIPC();
});

describe('IPC mcp', () => {
  it('start/stop/stopAll/call/tools/statuses/refresh', async () => {
    const config = { name: 's', command: 'npx', args: ['x'], enabled: true };
    await expect(invoke('mcp:startServer', config)).resolves.toEqual({ success: true });
    expect(hoisted.start).toHaveBeenCalledWith(config);
    await expect(invoke('mcp:stopServer', 's')).resolves.toEqual({ success: true });
    await expect(invoke('mcp:stopAll')).resolves.toEqual({ success: true });
    await expect(invoke('mcp:callTool', 's', 't', { a: 1 })).resolves.toEqual({ success: true });
    await expect(invoke('mcp:getTools')).resolves.toEqual([]);
    await expect(invoke('mcp:getStatuses')).resolves.toEqual([]);
    await expect(invoke('mcp:refreshTools', 's')).resolves.toEqual([]);
  });

  it('参数校验失败', async () => {
    await expect(invoke('mcp:startServer', { name: '' })).rejects.toThrow('参数校验失败');
    await expect(invoke('mcp:stopServer', '')).rejects.toThrow('参数校验失败');
    await expect(invoke('mcp:callTool', 's', 't', 'bad')).rejects.toThrow('参数校验失败');
    await expect(invoke('mcp:refreshTools', '')).rejects.toThrow('参数校验失败');
  });
});
