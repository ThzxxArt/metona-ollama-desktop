import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => unknown>(),
  runCommand: vi.fn(async () => ({ success: true, stdout: 'ok' })),
  killTool: vi.fn(() => true),
  handler: vi.fn(async () => ({ success: true, path: '/tmp/a', lines: 1 })),
  setAllowedDirs: vi.fn(),
  setHttp: vi.fn(),
  setMcp: vi.fn(),
  startProcess: vi.fn(() => ({ success: true })),
  killProcess: vi.fn(),
  setWorkspace: vi.fn(),
  saveSetting: vi.fn(),
  handlerAvailable: true,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, f: (...a: unknown[]) => unknown) => hoisted.handlers.set(c, f),
    on: (c: string, f: (...a: unknown[]) => unknown) => hoisted.ons.set(c, f),
  },
}));
vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { id: 1, send: vi.fn() }, isDestroyed: () => false },
}));
vi.mock('../src/main/tool-handlers.js', () => ({
  handleRunCommand: hoisted.runCommand,
  killToolProcess: hoisted.killTool,
}));
vi.mock('../src/main/tool-dispatch.js', () => ({
  getToolHandler: () => (hoisted.handlerAvailable ? hoisted.handler : undefined),
}));
vi.mock('../src/main/tool-security.js', () => ({
  getAllowedDirs: () => ['/a'],
  getBlockedDirs: () => ['/b'],
  setAllowedDirs: hoisted.setAllowedDirs,
}));
vi.mock('../src/main/tool-handlers-system.js', () => ({ setHTTPTimeout: hoisted.setHttp }));
vi.mock('../src/main/mcp-manager.js', () => ({ setMCPTimeout: hoisted.setMcp }));
vi.mock('../src/main/workspace.js', () => ({
  DEFAULT_WORKSPACE_DIR: '/default-ws',
  getWorkspaceDir: () => '/ws',
  setWorkspaceDir: hoisted.setWorkspace,
  listWorkspaceDir: () => [{ name: 'a' }],
  startProcess: hoisted.startProcess,
  killProcess: hoisted.killProcess,
}));
vi.mock('../src/main/db/sqlite.js', () => ({ saveSetting: hoisted.saveSetting }));

import { registerToolsIPC } from '../src/main/ipc/tools.js';

const event = {
  sender: { id: 1, send: vi.fn(), getURL: () => 'file:///index.html' },
  senderFrame: { url: 'file:///index.html' },
};

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = hoisted.handlers.get(channel);
  if (!fn) throw new Error(`missing ${channel}`);
  return Promise.resolve(fn(event, ...args));
}
function fire(channel: string, ...args: unknown[]): void {
  const fn = hoisted.ons.get(channel);
  if (!fn) throw new Error(`missing on ${channel}`);
  fn(event, ...args);
}

beforeEach(() => {
  hoisted.handlers.clear();
  hoisted.ons.clear();
  hoisted.handlerAvailable = true;
  vi.clearAllMocks();
  registerToolsIPC();
});

describe('IPC tools / workspace', () => {
  it('tool:execute 成功与未知工具', async () => {
    await expect(invoke('tool:execute', 'read_file', { path: '/tmp/a' })).resolves.toMatchObject({ success: true });
    await expect(invoke('tool:execute', '', {})).rejects.toThrow('参数校验失败');
    await expect(invoke('tool:execute', 'x', 'bad')).rejects.toThrow('参数校验失败');
  });

  it.each([
    ['read_file', { total: 2 }],
    ['read_file', { path: '/a', lines: 1, truncated: true }],
    ['write_file', { path: '/a', bytesWritten: 3, created: true }],
    ['write_file', { path: '/a', bytesWritten: 3 }],
    ['list_directory', { path: '/a', total: 2, truncated: true }],
    ['list_directory', { path: '/a', fileCount: 3 }],
    ['search_files', { query: 'q', total_matches: 2, total_files: 1 }],
    ['delete_file', { batch: true, successCount: 1, totalPaths: 2 }],
    ['delete_file', { path: '/a' }],
    ['file_transfer', { source: '/a', destination: '/b' }],
    ['web_fetch', { status: 200, length: 10 }],
    ['web_search', { _mode: 'searxng', query: 'q', total: 2 }],
    ['web_search', { query: 'q', total: 1 }],
    ['edit_file', { path: '/a', replaceCount: 2 }],
    ['download_file', { url: 'u', destination: '/a', size: 3 }],
    ['git', { action: 'status' }],
    ['compress', { action: 'create', archive: '/a.zip' }],
    ['compress', { action: 'extract', destination: '/d' }],
    ['diff', { identical: true }],
    ['diff', { additions: 1, deletions: 2, hunk_count: 1 }],
    ['browser', { action: 'open' }],
    ['unknown_tool', {}],
  ])('summarizeResult 覆盖 %s', async (name, result) => {
    hoisted.handler.mockResolvedValueOnce({ success: true, ...result });
    await expect(invoke('tool:execute', name, {})).resolves.toMatchObject({ success: true });
  });

  it('未知工具与 workspace 读取处理器缺失返回明确错误', async () => {
    hoisted.handlerAvailable = false;
    await expect(invoke('tool:execute', 'unknown_tool', {})).resolves.toEqual({
      success: false,
      error: '未知工具: unknown_tool',
    });
    await expect(invoke('workspace:readFile', '/tmp/a')).resolves.toEqual({
      success: false,
      error: 'read_file 处理器不可用',
    });
  });

  it('tool:execute 处理器失败/异常', async () => {
    hoisted.handler.mockResolvedValueOnce({ success: false, error: 'bad' });
    await expect(invoke('tool:execute', 'read_file', {})).resolves.toMatchObject({ success: false });
    hoisted.handler.mockRejectedValueOnce(new Error('boom'));
    await expect(invoke('tool:execute', 'read_file', {})).resolves.toMatchObject({ success: false, error: 'boom' });
  });

  it('run_command 走专用处理器', async () => {
    await expect(invoke('tool:execute', 'run_command', { command: 'ls' })).resolves.toMatchObject({ success: true });
    expect(hoisted.runCommand).toHaveBeenCalledWith({ command: 'ls' });
  });

  it('工具配置与超时', async () => {
    await expect(invoke('tool:getConfig')).resolves.toEqual({ allowedDirs: ['/a'], blockedDirs: ['/b'] });
    await expect(invoke('tool:setAllowedDirs', ['/x'])).resolves.toBeUndefined();
    expect(hoisted.setAllowedDirs).toHaveBeenCalledWith(['/x']);
    await expect(invoke('tool:setTimeouts', { http: 1000, mcp: 2000 })).resolves.toEqual({ success: true });
    expect(hoisted.setHttp).toHaveBeenCalledWith(1000);
    expect(hoisted.setMcp).toHaveBeenCalledWith(2000);
    await expect(invoke('tool:setTimeouts', { http: 1000 })).resolves.toEqual({ success: true });
    await expect(invoke('tool:setTimeouts', { mcp: 2000 })).resolves.toEqual({ success: true });
    await expect(invoke('tool:setTimeouts', { http: -1 })).rejects.toThrow('参数校验失败');
  });

  it('workspace 目录读写', async () => {
    await expect(invoke('workspace:getDir')).resolves.toEqual({ dir: '/ws', defaultDir: '/default-ws' });
    await expect(invoke('workspace:setDir', '/new')).resolves.toEqual({ success: true, dir: '/ws' });
    expect(hoisted.setWorkspace).toHaveBeenCalledWith('/new');
    expect(hoisted.saveSetting).toHaveBeenCalledWith('workspaceDir', '/ws');
    await expect(invoke('workspace:listDir')).resolves.toEqual([{ name: 'a' }]);
    await expect(invoke('workspace:listDir', '/sub')).resolves.toEqual([{ name: 'a' }]);
    await expect(invoke('workspace:readFile', '/tmp/a')).resolves.toMatchObject({ success: true });
  });

  it('workspace 参数校验与设置失败', async () => {
    await expect(invoke('workspace:setDir', '')).rejects.toThrow('参数校验失败');
    await expect(invoke('workspace:listDir', 1)).rejects.toThrow('参数校验失败');
    await expect(invoke('workspace:readFile', '')).rejects.toThrow('参数校验失败');
    hoisted.setWorkspace.mockImplementationOnce(() => {
      throw new Error('系统目录');
    });
    await expect(invoke('workspace:setDir', '/etc')).resolves.toEqual({ success: false, error: '系统目录' });
  });

  it('workspace:exec 转发输出与退出', async () => {
    fire('workspace:exec', { id: '1', command: 'ls', cwd: '/ws' });
    expect(hoisted.startProcess).toHaveBeenCalled();
    const outputCb = hoisted.startProcess.mock.calls[0][3] as (type: string, data: string) => void;
    const exitCb = hoisted.startProcess.mock.calls[0][4] as (code: number) => void;
    outputCb('stdout', 'hello');
    exitCb(0);
    expect(event.sender.send).toHaveBeenCalledWith('workspace:output', { id: '1', type: 'stdout', data: 'hello' });
    expect(event.sender.send).toHaveBeenCalledWith('workspace:exit', { id: '1', code: 0 });
  });

  it('workspace:exec 启动失败返回错误', async () => {
    hoisted.startProcess.mockReturnValueOnce({ success: false, error: 'spawn failed' });
    fire('workspace:exec', { id: '2', command: 'bad' });
    expect(event.sender.send).toHaveBeenCalledWith('workspace:output', {
      id: '2',
      type: 'stderr',
      data: 'spawn failed\n',
    });
    expect(event.sender.send).toHaveBeenCalledWith('workspace:exit', { id: '2', code: 1 });
  });

  it('workspace:kill 与 cmd:kill', async () => {
    fire('workspace:kill', '1');
    expect(hoisted.killProcess).toHaveBeenCalledWith('1');
    await expect(invoke('cmd:kill')).resolves.toEqual({ killed: true });
    expect(hoisted.killTool).toHaveBeenCalled();
    hoisted.killTool.mockReturnValueOnce(false);
    await expect(invoke('cmd:kill')).resolves.toEqual({ killed: false });
  });
});
