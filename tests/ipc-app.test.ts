import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => unknown>(),
  userData: '',
  appPath: process.cwd(),
  dialogResult: { canceled: false, filePaths: ['/tmp/a'] } as Record<string, unknown>,
  saveResult: { canceled: false, filePath: '/tmp/a' } as Record<string, unknown>,
  notify: vi.fn(),
  checkPath: vi.fn(() => ({ ok: true })),
  maximized: false,
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => hoisted.userData,
    getAppPath: () => hoisted.appPath,
    getVersion: () => '0.18.0',
    isPackaged: false,
  },
  dialog: {
    showOpenDialog: async () => hoisted.dialogResult,
    showSaveDialog: async () => hoisted.saveResult,
  },
  shell: { openExternal: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => hoisted.ons.set(channel, fn),
  },
}));

vi.mock('../src/main/window-state.js', () => ({
  mainWindow: {
    webContents: { id: 1, send: hoisted.send },
    isDestroyed: () => false,
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: () => hoisted.maximized,
    close: vi.fn(),
  },
}));

vi.mock('../src/main/utils.js', () => ({ showNotification: hoisted.notify }));
vi.mock('../src/main/tool-security.js', () => ({ checkPathAllowed: hoisted.checkPath }));

import { registerAppIPC } from '../src/main/ipc/app.js';
import { sendLog } from '../src/main/ipc/shared.js';

const event = {
  sender: { id: 1, send: vi.fn(), isDestroyed: () => false, getURL: () => 'file:///index.html' },
  senderFrame: { url: 'file:///index.html' },
  returnValue: undefined as unknown,
};

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = hoisted.handlers.get(channel);
  if (!fn) throw new Error(`missing handler ${channel}`);
  return Promise.resolve(fn(event, ...args));
}

function invokeSync(channel: string, ...args: unknown[]): unknown {
  const fn = hoisted.ons.get(channel);
  if (!fn) throw new Error(`missing on handler ${channel}`);
  fn(event, ...args);
  return event.returnValue;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metona-ipc-app-'));
  hoisted.userData = tmpDir;
  hoisted.handlers.clear();
  hoisted.ons.clear();
  hoisted.dialogResult = { canceled: false, filePaths: ['/tmp/a'] };
  hoisted.saveResult = { canceled: false, filePath: '/tmp/a' };
  registerAppIPC();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('IPC app / dialog / fs', () => {
  it('openFile 返回路径，取消返回 null', async () => {
    await expect(invoke('dialog:openFile', { filters: [{ name: 'x', extensions: ['txt'] }] })).resolves.toEqual([
      '/tmp/a',
    ]);
    hoisted.dialogResult = { canceled: true, filePaths: [] };
    await expect(invoke('dialog:openFile')).resolves.toBeNull();
  });

  it('openFile 处理 multiple=false / properties / 默认 filters', async () => {
    await expect(invoke('dialog:openFile', { multiple: false })).resolves.toEqual(['/tmp/a']);
    await expect(
      invoke('dialog:openFile', { properties: ['multiSelections'], filters: [{ name: 'x', extensions: ['*'] }] }),
    ).resolves.toEqual(['/tmp/a']);
    await expect(invoke('dialog:openFile', { properties: ['openFile'] })).resolves.toEqual(['/tmp/a']);
  });

  it('openFile 拒绝非法 filters', async () => {
    await expect(invoke('dialog:openFile', { filters: [{ name: '', extensions: [] }] })).rejects.toThrow(
      '参数校验失败',
    );
  });

  it('saveFile 返回路径，取消返回 null', async () => {
    await expect(invoke('dialog:saveFile', { defaultPath: 'x.txt' })).resolves.toBe('/tmp/a');
    await expect(invoke('dialog:saveFile')).resolves.toBe('/tmp/a');
    hoisted.saveResult = { canceled: true };
    await expect(invoke('dialog:saveFile')).resolves.toBeNull();
  });

  it('openDirectory 返回路径', async () => {
    await expect(invoke('dialog:openDirectory')).resolves.toEqual(['/tmp/a']);
  });

  it('fs 读写文本与 base64', async () => {
    const p = path.join(tmpDir, 'a.txt');
    await expect(invoke('fs:writeFile', p, 'hello')).resolves.toEqual({ success: true });
    await expect(invoke('fs:readFile', p)).resolves.toMatchObject({ success: true, content: 'hello', name: 'a.txt' });
    const b64 = Buffer.from('bin').toString('base64');
    await expect(invoke('fs:writeFile', path.join(tmpDir, 'b.bin'), b64, 'base64')).resolves.toEqual({ success: true });
    await expect(invoke('fs:readFileBase64', path.join(tmpDir, 'b.bin'))).resolves.toMatchObject({
      success: true,
      content: b64,
      size: 3,
    });
    await expect(invoke('fs:writeFile', path.join(tmpDir, 'c.txt'), 'café', 'latin1')).resolves.toEqual({
      success: true,
    });
  });

  it('fs 读写失败返回错误', async () => {
    await expect(invoke('fs:readFile', path.join(tmpDir, 'missing.txt'))).resolves.toMatchObject({ success: false });
    await expect(invoke('fs:readFileBase64', path.join(tmpDir, 'missing.bin'))).resolves.toMatchObject({
      success: false,
    });
    await expect(invoke('fs:writeFile', tmpDir, 'x')).resolves.toMatchObject({ success: false });
  });

  it('fs 参数校验', async () => {
    await expect(invoke('fs:readFile', '')).rejects.toThrow('参数校验失败');
    await expect(invoke('fs:writeFile', path.join(tmpDir, 'x'), 123)).rejects.toThrow('参数校验失败');
    await expect(invoke('fs:writeFile', path.join(tmpDir, 'x'), 'x', 'bad')).rejects.toThrow('参数校验失败');
  });

  it('路径白名单拒绝时返回错误', async () => {
    hoisted.checkPath.mockReturnValueOnce({ ok: false, reason: 'blocked' });
    await expect(invoke('fs:readFile', path.join(tmpDir, 'a.txt'))).resolves.toEqual({
      success: false,
      error: 'blocked',
    });
    hoisted.checkPath.mockReturnValueOnce({ ok: false, reason: 'blocked' });
    await expect(invoke('fs:readFileBase64', path.join(tmpDir, 'a.bin'))).resolves.toEqual({
      success: false,
      error: 'blocked',
    });
    hoisted.checkPath.mockReturnValueOnce({ ok: false, reason: 'blocked' });
    await expect(invoke('fs:writeFile', path.join(tmpDir, 'a.txt'), 'x')).resolves.toEqual({
      success: false,
      error: 'blocked',
    });
  });

  it('sendLog 脱敏并处理 detail 有无', () => {
    hoisted.send.mockClear();
    sendLog('info', 'Bearer sk-secret');
    expect(hoisted.send).toHaveBeenCalledWith('main:log', {
      level: 'info',
      message: 'Bearer ***',
      detail: undefined,
    });
    sendLog('warn', 'x', '?token=secret');
    expect(hoisted.send).toHaveBeenLastCalledWith('main:log', {
      level: 'warn',
      message: 'x',
      detail: '?token=***',
    });
  });

  it('notify 调用系统通知', async () => {
    await invoke('notify', 'title', 'body');
    expect(hoisted.notify).toHaveBeenCalledWith('title', 'body');
  });

  it('app info / sys / sys sync', async () => {
    await expect(invoke('app:info')).resolves.toMatchObject({ version: '0.18.0', platform: process.platform });
    expect(invokeSync('app:sys:sync')).toMatchObject({ arch: expect.any(String) });
  });

  it('checkUpdate 成功/失败', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ tag_name: 'v0.19.0', html_url: 'https://example.com' }),
      })),
    );
    await expect(invoke('app:checkUpdate')).resolves.toMatchObject({ hasUpdate: true, latest: '0.19.0' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: 'v0.18.0' }) })),
    );
    await expect(invoke('app:checkUpdate')).resolves.toMatchObject({ hasUpdate: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: '' }) })),
    );
    await expect(invoke('app:checkUpdate')).resolves.toMatchObject({ hasUpdate: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(invoke('app:checkUpdate')).resolves.toMatchObject({ hasUpdate: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(invoke('app:checkUpdate')).resolves.toMatchObject({ hasUpdate: false, error: 'offline' });
  });

  it('readResource 读取内置资源并拒绝路径穿越', async () => {
    hoisted.appPath = process.cwd();
    await expect(invoke('app:readResource', 'SOUL.md')).resolves.toMatchObject({ success: true });
    await expect(invoke('app:readResource', '../secret')).resolves.toMatchObject({ success: false });
    await expect(invoke('app:readResource', '.env')).resolves.toMatchObject({ success: false });
    await expect(invoke('app:readResource', 'missing.md')).resolves.toMatchObject({ success: false });
  });

  it('window 控制与 openExternal 协议限制', async () => {
    await expect(invoke('window:minimize')).resolves.toBeUndefined();
    hoisted.maximized = true;
    await expect(invoke('window:maximize')).resolves.toBeUndefined();
    hoisted.maximized = false;
    await expect(invoke('window:maximize')).resolves.toBeUndefined();
    await expect(invoke('window:close')).resolves.toBeUndefined();
    await expect(invoke('shell:openExternal', 'https://example.com')).resolves.toBeUndefined();
    await expect(invoke('shell:openExternal', 'javascript:alert(1)')).rejects.toThrow('参数校验失败');
    await expect(invoke('shell:openExternal', 'mailto:a@b.c')).resolves.toBeUndefined();
  });

  it('非法发送方被拒绝', async () => {
    const bad = { sender: { id: 2 }, senderFrame: { url: 'file:///index.html' } };
    const fn = hoisted.handlers.get('app:info')!;
    await expect(Promise.resolve(fn(bad))).rejects.toThrow('非法 IPC 调用来源');
  });
});
