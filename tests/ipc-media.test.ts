import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  exec: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => hoisted.handlers.set(c, f) },
}));
vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { id: 1, send: hoisted.send }, isDestroyed: () => false },
}));
vi.mock('ffmpeg-static', () => ({ default: '/usr/bin/ffmpeg' }));
vi.mock('child_process', () => ({ execFile: hoisted.exec }));

import { registerMediaIPC } from '../src/main/ipc/media.js';

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
let video: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metona-ipc-media-'));
  video = path.join(tmpDir, 'v.mp4');
  fs.writeFileSync(video, 'video');
  hoisted.handlers.clear();
  hoisted.exec.mockReset();
  hoisted.send.mockReset();
  registerMediaIPC();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('IPC media', () => {
  it('文件不存在返回错误', async () => {
    await expect(invoke('video:extractFrames', path.join(tmpDir, 'missing.mp4'))).resolves.toMatchObject({
      success: false,
    });
  });

  it('文件过大直接拒绝', async () => {
    await expect(invoke('video:extractFrames', video, { maxSize: 1 })).resolves.toMatchObject({ success: false });
  });

  it('成功提取帧并解析视频信息', async () => {
    hoisted.exec.mockImplementation((_bin, args, _opts, cb) => {
      const outPattern = args[args.length - 1] as string;
      const dir = path.dirname(outPattern);
      fs.writeFileSync(path.join(dir, 'frame_0001.jpg'), Buffer.alloc(300, 1));
      fs.writeFileSync(path.join(dir, 'frame_0002.jpg'), Buffer.alloc(300, 1));
      cb(null, '', '');
      return {
        stderr: {
          on: (event: string, listener: (data: Buffer) => void) => {
            if (event === 'data') {
              listener(
                Buffer.from(
                  'Duration: 00:00:02.00, start: 0.000000, bitrate: 1 kb/s\n  Stream #0:0: Video: h264, yuv420p, 640x480',
                ),
              );
            }
          },
        },
      };
    });
    const result = (await invoke('video:extractFrames', video)) as {
      success: boolean;
      frames: unknown[];
      videoInfo: { duration: number; width: number; height: number };
    };
    expect(result.success).toBe(true);
    expect(result.frames).toHaveLength(2);
    expect(result.videoInfo).toMatchObject({ width: 640, height: 480 });
  });

  it('没有帧时返回错误', async () => {
    hoisted.exec.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '', 'no frames');
      return { stderr: { on: vi.fn() } };
    });
    await expect(invoke('video:extractFrames', video)).resolves.toMatchObject({ success: false });
  });

  it('ffmpeg 失败返回错误', async () => {
    hoisted.exec.mockImplementation((_bin, _args, _opts, cb) => {
      cb(new Error('ffmpeg failed'), '', '');
      return { stderr: { on: vi.fn() } };
    });
    await expect(invoke('video:extractFrames', video)).resolves.toMatchObject({ success: false });
  });

  it('参数校验失败', async () => {
    await expect(invoke('video:extractFrames', '')).rejects.toThrow('参数校验失败');
    await expect(invoke('video:extractFrames', video, { maxFrames: 0 })).rejects.toThrow('参数校验失败');
  });
});
