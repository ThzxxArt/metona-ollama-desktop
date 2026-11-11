import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';

interface SpawnSpec {
  stdout?: string | string[];
  stderr?: string | string[];
  code?: number | null;
  error?: Error;
  hang?: boolean;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  queue: [] as unknown[],
  cmdAllowed: vi.fn(() => ({ ok: true }) as { ok: boolean; reason?: string }),
  pathAllowed: vi.fn(() => ({ ok: true }) as { ok: boolean; reason?: string }),
  send: vi.fn(),
  sendLog: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: h.spawn }));
vi.mock('../src/main/tool-security.js', () => ({
  checkPathAllowed: h.pathAllowed,
  checkCommandAllowed: h.cmdAllowed,
}));
vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { send: h.send } },
}));
vi.mock('../src/main/tool-handlers-shared.js', () => ({
  sendLog: h.sendLog,
  resolvePath: (p: string) => p,
}));
vi.mock('../src/main/workspace.js', () => ({ getWorkspaceDir: () => '/ws' }));

import { handleRunCommand, killToolProcess } from '../src/main/tools/command.js';

function enqueue(spec: SpawnSpec): void {
  h.queue.push(spec);
}

function installSpawn(): void {
  h.spawn.mockImplementation(() => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const spec = (h.queue.shift() as SpawnSpec | undefined) ?? { code: 0 };
    process.nextTick(() => {
      for (const chunk of Array.isArray(spec.stdout) ? spec.stdout : spec.stdout ? [spec.stdout] : []) {
        child.stdout.emit('data', Buffer.from(chunk));
      }
      for (const chunk of Array.isArray(spec.stderr) ? spec.stderr : spec.stderr ? [spec.stderr] : []) {
        child.stderr.emit('data', Buffer.from(chunk));
      }
      if (spec.error) {
        child.emit('error', spec.error);
        return;
      }
      if (!spec.hang) child.emit('close', spec.code === undefined ? 0 : spec.code);
    });
    return child;
  });
}

beforeEach(() => {
  h.spawn.mockReset();
  h.queue.length = 0;
  h.cmdAllowed.mockReset();
  h.cmdAllowed.mockReturnValue({ ok: true });
  h.pathAllowed.mockReset();
  h.pathAllowed.mockReturnValue({ ok: true });
  h.send.mockReset();
  h.sendLog.mockReset();
  installSpawn();
});

describe('run_command 执行', () => {
  it('成功执行并流式推送 stdout/stderr', async () => {
    enqueue({ stdout: 'hello\n', stderr: 'warn\n', code: 0 });
    const r = await handleRunCommand({ command: 'echo hello' });
    expect(r.success).toBe(true);
    expect(r.stdout).toBe('hello\n');
    expect(r.stderr).toBe('warn\n');
    expect(r.exitCode).toBe(0);
    expect(r.cwd).toBe('/ws');
    expect(r.command).toBe('echo hello');
    expect(typeof r.duration).toBe('number');

    const [cmd, args, opts] = h.spawn.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(cmd).toBe('bash');
    expect(args).toEqual(['-c', 'echo hello']);
    expect(opts.cwd).toBe('/ws');
    expect(opts.env.LANG).toBe('en_US.UTF-8');
    expect(opts.env.LC_ALL).toBe('en_US.UTF-8');
    expect(opts.env.TERM).toBe('xterm-256color');

    expect(h.send).toHaveBeenCalledWith('cmd:output', {
      command: 'echo hello',
      type: 'stdout',
      data: 'hello\n',
    });
    expect(h.send).toHaveBeenCalledWith('cmd:output', {
      command: 'echo hello',
      type: 'stderr',
      data: 'warn\n',
    });
    expect(h.send).toHaveBeenCalledWith('cmd:done', { command: 'echo hello', exitCode: 0 });
  });

  it('非零退出码返回失败但保留输出', async () => {
    enqueue({ stdout: 'partial', stderr: 'boom', code: 2 });
    const r = await handleRunCommand({ command: 'false' });
    expect(r.success).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe('partial');
    expect(r.stderr).toBe('boom');
  });

  it('多块输出完整拼接', async () => {
    enqueue({ stdout: ['a', 'b', 'c'], stderr: ['e1', 'e2'], code: 0 });
    const r = await handleRunCommand({ command: 'cat' });
    expect(r.stdout).toBe('abc');
    expect(r.stderr).toBe('e1e2');
    expect(h.send.mock.calls.filter((c) => c[0] === 'cmd:output')).toHaveLength(5);
  });

  it('大输出不被截断（完整返回）', async () => {
    const big = 'x'.repeat(100_000);
    enqueue({ stdout: big, code: 0 });
    const r = await handleRunCommand({ command: 'big' });
    expect(String(r.stdout)).toHaveLength(100_000);
  });

  it('自定义 cwd 会被 resolve', async () => {
    enqueue({ code: 0 });
    const r = await handleRunCommand({ command: 'pwd', cwd: 'sub/dir' });
    expect(r.success).toBe(true);
    expect(r.cwd).toBe(path.resolve('sub/dir'));
    const opts = h.spawn.mock.calls[0][2] as { cwd: string };
    expect(opts.cwd).toBe(path.resolve('sub/dir'));
  });

  it('spawn error 事件返回失败并附加 stderr', async () => {
    enqueue({ stderr: 'before', error: new Error('spawn bash ENOENT') });
    const r = await handleRunCommand({ command: 'x' });
    expect(r.success).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.error).toBe('spawn bash ENOENT');
    expect(String(r.stderr)).toContain('before');
    expect(String(r.stderr)).toContain('spawn bash ENOENT');
    expect(h.send).toHaveBeenCalledWith('cmd:done', { command: 'x', exitCode: 1 });
  });

  it('参数异常（cwd 非字符串）被外层捕获', async () => {
    const r = await handleRunCommand({ command: 'x', cwd: {} as never });
    expect(r.success).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(String(r.error)).toContain('path');
    expect(r.stdout).toBe('');
  });

  it('Windows 使用 cmd.exe 并设置 UTF-8 代码页', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      enqueue({ stdout: 'ok', code: 0 });
      const r = await handleRunCommand({ command: 'echo hi' });
      expect(r.success).toBe(true);
      const [cmd, args, opts] = h.spawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
      expect(cmd).toBe('cmd.exe');
      expect(args).toEqual(['/c', 'chcp 65001 >nul && echo hi']);
      expect(opts.env.TERM).toBe(process.env.TERM);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('run_command 安全拦截', () => {
  it('危险命令不执行', async () => {
    h.cmdAllowed.mockReturnValueOnce({ ok: false, reason: '命令包含被禁止的操作: rm -rf /' });
    const r = await handleRunCommand({ command: 'rm -rf /' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('被禁止');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('cwd 路径检查失败不执行', async () => {
    h.pathAllowed.mockReturnValueOnce({ ok: false, reason: '禁止访问系统目录' });
    const r = await handleRunCommand({ command: 'ls', cwd: '/etc' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('禁止访问系统目录');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('spawn 同步抛错时返回工具错误而不是 rejected Promise', async () => {
    h.spawn.mockImplementationOnce(() => {
      throw new Error('spawn blocked');
    });
    const r = await handleRunCommand({ command: 'echo hi' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('spawn blocked');
    expect(r.exitCode).toBe(1);
  });
});

describe('killToolProcess', () => {
  it('没有运行中的命令返回 false', () => {
    expect(killToolProcess()).toBe(false);
  });

  it('终止运行中的命令并返回 true', async () => {
    enqueue({ hang: true });
    const p = handleRunCommand({ command: 'sleep 100' });
    const child = h.spawn.mock.results[0].value as FakeChild;
    expect(killToolProcess()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 143);
    const r = await p;
    expect(r.exitCode).toBe(143);
    expect(r.success).toBe(false);
    expect(killToolProcess()).toBe(false);
  });

  it('并发命令全部被终止，不只最后一个', async () => {
    enqueue({ hang: true });
    enqueue({ hang: true });
    const p1 = handleRunCommand({ command: 'sleep 1' });
    const p2 = handleRunCommand({ command: 'sleep 2' });
    const c1 = h.spawn.mock.results[0].value as FakeChild;
    const c2 = h.spawn.mock.results[1].value as FakeChild;
    expect(killToolProcess()).toBe(true);
    expect(c1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(c2.kill).toHaveBeenCalledWith('SIGTERM');
    c1.emit('close', 143);
    c2.emit('close', 143);
    await Promise.all([p1, p2]);
    expect(killToolProcess()).toBe(false);
  });
});
