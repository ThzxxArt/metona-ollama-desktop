import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => unknown>(),
  destroyed: false,
  windowId: 1,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => hoisted.ons.set(channel, fn),
  },
}));

vi.mock('../src/main/window-state.js', () => ({
  mainWindow: {
    webContents: { id: 1 },
    isDestroyed: () => hoisted.destroyed,
  },
}));

import { handleTrusted, isTrustedSender, onTrusted, parseArgs, redactLog } from '../src/main/ipc/register.js';
import { z } from 'zod';

const validEvent = {
  sender: { id: 1, getURL: () => 'file:///index.html' },
  senderFrame: { url: 'file:///index.html' },
  returnValue: undefined as unknown,
};

beforeEach(() => {
  hoisted.handlers.clear();
  hoisted.ons.clear();
  hoisted.destroyed = false;
  hoisted.windowId = 1;
});

describe('IPC register 边界', () => {
  it('redactLog 处理字符串、对象与循环对象', () => {
    expect(redactLog('Authorization: Bearer sk-secret')).toContain('Bearer ***');
    expect(redactLog('?api_key=secret&x=1')).toContain('api_key=***');
    expect(redactLog({ apiKey: 'secret' })).toContain('***');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redactLog(circular)).toBe('[object Object]');
  });

  it('isTrustedSender 拒绝窗口销毁、错误 id 与非本地 URL', () => {
    expect(isTrustedSender(validEvent as never)).toBe(true);
    hoisted.destroyed = true;
    expect(isTrustedSender(validEvent as never)).toBe(false);
    hoisted.destroyed = false;
    expect(isTrustedSender({ ...validEvent, sender: { id: 2, getURL: () => 'file:///x' } } as never)).toBe(false);
    expect(
      isTrustedSender({
        ...validEvent,
        sender: { id: 1, getURL: () => 'https://evil.test' },
        senderFrame: undefined,
      } as never),
    ).toBe(false);
    expect(
      isTrustedSender({
        ...validEvent,
        sender: { id: 1, getURL: () => 'http://localhost:5173' },
        senderFrame: undefined,
      } as never),
    ).toBe(true);
    expect(
      isTrustedSender({
        ...validEvent,
        sender: { id: 1, getURL: () => 'http://127.0.0.1:5173' },
        senderFrame: undefined,
      } as never),
    ).toBe(true);
  });

  it('parseArgs 成功与失败', () => {
    expect(parseArgs(z.string().min(1), 'x')).toBe('x');
    expect(() => parseArgs(z.string().min(1), '')).toThrow('参数校验失败');
  });

  it('handleTrusted 拒绝非法来源并调用合法处理器', async () => {
    const handler = vi.fn(() => 'ok');
    handleTrusted('test:invoke', handler);
    const fn = hoisted.handlers.get('test:invoke')!;
    await expect(Promise.resolve(fn(validEvent))).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledWith(validEvent);
    await expect(Promise.resolve(fn({ ...validEvent, sender: { id: 2, getURL: () => 'file:///x' } }))).rejects.toThrow(
      '非法 IPC 调用来源',
    );
  });

  it('onTrusted 非法来源对 sendSync 写入 undefined 且不调用处理器', () => {
    const handler = vi.fn();
    onTrusted('test:on', handler);
    const fn = hoisted.ons.get('test:on')!;
    const badEvent = { ...validEvent, sender: { id: 2, getURL: () => 'file:///x' } };
    fn(badEvent);
    expect(badEvent.returnValue).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    fn(validEvent);
    expect(handler).toHaveBeenCalledWith(validEvent);
  });
});
