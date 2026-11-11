import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ws: '',
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => hoisted.handlers.set(c, f) },
}));
vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { id: 1, send: vi.fn() }, isDestroyed: () => false },
}));
vi.mock('../src/main/workspace.js', () => ({ getWorkspaceDir: () => hoisted.ws }));

import { registerMemoryIPC } from '../src/main/ipc/memory.js';

const event = {
  sender: { id: 1, getURL: () => 'file:///index.html' },
  senderFrame: { url: 'file:///index.html' },
};

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = hoisted.handlers.get(channel);
  if (!fn) throw new Error(`missing ${channel}`);
  return Promise.resolve(fn(event, ...args));
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metona-ipc-memory-'));
  hoisted.ws = tmpDir;
  hoisted.handlers.clear();
  registerMemoryIPC();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('IPC memory', () => {
  it('read 文件不存在返回空内容', async () => {
    await expect(invoke('memory:read')).resolves.toEqual({ success: true, content: '' });
  });

  it('write 空内容删除文件，非空写入', async () => {
    const p = path.join(tmpDir, 'MEMORY.md');
    await expect(invoke('memory:write', '# METONA MEMORY\n', 'test')).resolves.toEqual({ success: true });
    expect(fs.readFileSync(p, 'utf-8')).toContain('METONA MEMORY');
    await expect(invoke('memory:read')).resolves.toMatchObject({
      success: true,
      content: expect.stringContaining('MEMORY'),
    });
    await expect(invoke('memory:write', '', 'clear')).resolves.toEqual({ success: true });
    expect(fs.existsSync(p)).toBe(false);
  });

  it('write 内容校验失败', async () => {
    await expect(invoke('memory:write', 123)).rejects.toThrow('参数校验失败');
    await expect(invoke('memory:write', 'x'.repeat(6 * 1024 * 1024))).rejects.toThrow('参数校验失败');
    await expect(invoke('memory:write', '# METONA MEMORY\n', 123)).rejects.toThrow('参数校验失败');
  });

  it('init 创建模板文件', async () => {
    const result = (await invoke('memory:init')) as { success: boolean; action: string; existed: boolean };
    expect(result).toMatchObject({ success: true, action: 'created', existed: false });
    expect(fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8')).toContain('# METONA MEMORY');
  });

  it('init 校验合法文件', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'MEMORY.md'),
      '# METONA MEMORY\n\n## fact | id: mem_20260101_001 | importance: 8 | tags: a,b\n内容\n',
    );
    const result = (await invoke('memory:init')) as { success: boolean; action: string; valid: boolean };
    expect(result).toMatchObject({ success: true, action: 'valid', valid: true });
  });

  it('init 非法文件备份并重建', async () => {
    const p = path.join(tmpDir, 'MEMORY.md');
    fs.writeFileSync(p, 'broken content');
    const result = (await invoke('memory:init')) as { success: boolean; action: string; backedUp?: string };
    expect(result).toMatchObject({ success: true, action: 'recreated' });
    expect(result.backedUp && fs.existsSync(result.backedUp)).toBe(true);
    expect(fs.readFileSync(p, 'utf-8')).toContain('# METONA MEMORY');
  });

  it('init 工作空间目录不存在时自动创建', async () => {
    hoisted.ws = path.join(tmpDir, 'nested', 'ws');
    const result = (await invoke('memory:init')) as { success: boolean; action: string };
    expect(result).toMatchObject({ success: true, action: 'created' });
  });
});
