import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

type AnyFn = (...args: any[]) => any;

const hoisted = vi.hoisted(() => {
  const state = {
    userData: '/tmp/metona-workspace-user',
    existing: new Set<string>(),
    mkdirError: null as Error | null,
    readdir: new Map<string, any[]>(),
    readdirError: null as Error | null,
    stats: new Map<string, { size: number; modified: string; file: boolean }>(),
    statError: null as Error | null,
    commandCheck: vi.fn((_command: string) => ({ ok: true })),
    pathCheck: vi.fn((_p: string, _op: string) => ({ ok: true })),
    systemBlocked: vi.fn((_p: string) => false),
    exemptions: vi.fn((_dirs: string[]) => undefined),
    spawn: null as AnyFn | null,
    procs: [] as any[],
    send: vi.fn(),
  };
  return { state, classes: {} as Record<string, any> };
});

vi.mock('fs', () => ({
  existsSync: vi.fn((p: string) => hoisted.state.existing.has(p)),
  mkdirSync: vi.fn((p: string, _opts: any) => {
    if (hoisted.state.mkdirError) throw hoisted.state.mkdirError;
    hoisted.state.existing.add(p);
  }),
  readdirSync: vi.fn((p: string, _opts: any) => {
    if (hoisted.state.readdirError) throw hoisted.state.readdirError;
    return hoisted.state.readdir.get(p) || [];
  }),
  statSync: vi.fn((p: string) => {
    if (hoisted.state.statError) throw hoisted.state.statError;
    const stat = hoisted.state.stats.get(p);
    if (!stat) throw new Error(`ENOENT: ${p}`);
    return {
      size: stat.size,
      mtime: { toISOString: () => stat.modified },
      isFile: () => stat.file,
      isDirectory: () => !stat.file,
    };
  }),
}));

vi.mock('child_process', () => {
  class Emitter {
    handlers = new Map<string, AnyFn[]>();
    on(event: string, cb: AnyFn) {
      const list = this.handlers.get(event) || [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: any[]) {
      for (const cb of this.handlers.get(event) || []) cb(...args);
    }
  }

  class FakeProc extends Emitter {
    pid = 777;
    stdout = new Emitter();
    stderr = new Emitter();
    kill = vi.fn();
  }

  hoisted.classes.FakeProc = FakeProc;
  hoisted.state.spawn = vi.fn((...args: any[]) => {
    const proc = new FakeProc();
    (proc as any).spawnArgs = args;
    hoisted.state.procs.push(proc);
    return proc;
  });
  return { spawn: hoisted.state.spawn, ChildProcess: class {} };
});

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => hoisted.state.userData },
}));

vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { send: hoisted.state.send } },
}));

vi.mock('../src/main/tool-security.js', () => ({
  checkCommandAllowed: hoisted.state.commandCheck,
  checkPathAllowed: hoisted.state.pathCheck,
  addBlocklistExemptions: hoisted.state.exemptions,
  isSystemBlockedPath: hoisted.state.systemBlocked,
}));

const originalPlatform = process.platform;
let workspace: any;
let defaultDir: string;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

async function loadWorkspace(): Promise<any> {
  vi.resetModules();
  return import('../src/main/workspace.js');
}

function dirent(name: string, directory: boolean) {
  return { name, isDirectory: () => directory, isFile: () => !directory };
}

beforeEach(async () => {
  hoisted.state.userData = '/tmp/metona-workspace-user';
  hoisted.state.existing = new Set<string>();
  hoisted.state.mkdirError = null;
  hoisted.state.readdir = new Map();
  hoisted.state.readdirError = null;
  hoisted.state.stats = new Map();
  hoisted.state.statError = null;
  hoisted.state.commandCheck.mockReset();
  hoisted.state.commandCheck.mockReturnValue({ ok: true });
  hoisted.state.pathCheck.mockReset();
  hoisted.state.pathCheck.mockReturnValue({ ok: true });
  hoisted.state.systemBlocked.mockReset();
  hoisted.state.systemBlocked.mockReturnValue(false);
  hoisted.state.exemptions.mockClear();
  hoisted.state.procs.length = 0;
  hoisted.state.spawn?.mockClear();
  hoisted.state.send.mockClear();
  workspace = await loadWorkspace();
  defaultDir = workspace.DEFAULT_WORKSPACE_DIR;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('workspace: ensure / get / set', () => {
  it('ensureWorkspaceDir 在目录缺失时递归创建并添加安全豁免', () => {
    workspace.ensureWorkspaceDir();
    expect(defaultDir).toBe(path.join('/tmp/metona-workspace-user', 'workspace'));
    expect(hoisted.state.existing.has(defaultDir)).toBe(true);
    expect(hoisted.state.exemptions).toHaveBeenCalledWith([defaultDir]);
    expect(hoisted.state.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ message: '📁 创建默认工作空间目录' }),
    );
  });

  it('ensureWorkspaceDir 目录已存在时不重复创建', () => {
    hoisted.state.existing.add(defaultDir);
    workspace.ensureWorkspaceDir();
    expect(hoisted.state.exemptions).toHaveBeenCalledWith([defaultDir]);
    expect(hoisted.state.send).not.toHaveBeenCalled();
  });

  it('getWorkspaceDir 默认返回 userData/workspace', () => {
    expect(workspace.getWorkspaceDir()).toBe(defaultDir);
  });

  it('setWorkspaceDir 解析相对路径、创建缺失目录并豁免', () => {
    workspace.setWorkspaceDir('relative-ws');
    const expected = path.resolve('relative-ws');
    expect(workspace.getWorkspaceDir()).toBe(expected);
    expect(hoisted.state.existing.has(expected)).toBe(true);
    expect(hoisted.state.exemptions).toHaveBeenCalledWith([expected]);
  });

  it('setWorkspaceDir 已存在目录不再创建', () => {
    const dir = path.resolve('/existing/ws');
    hoisted.state.existing.add(dir);
    hoisted.state.stats.set(dir, { size: 0, modified: '2026-01-01T00:00:00.000Z', file: false });
    workspace.setWorkspaceDir(dir);
    expect(workspace.getWorkspaceDir()).toBe(dir);
    expect(hoisted.state.exemptions).toHaveBeenCalledWith([dir]);
  });

  it('setWorkspaceDir 拒绝已存在的文件路径', () => {
    const file = path.resolve('/existing/file.txt');
    hoisted.state.existing.add(file);
    hoisted.state.stats.set(file, { size: 10, modified: '2026-01-01T00:00:00.000Z', file: true });
    expect(() => workspace.setWorkspaceDir(file)).toThrow('工作空间路径不是目录');
    expect(workspace.getWorkspaceDir()).toBe(defaultDir);
  });

  it('setWorkspaceDir 拒绝系统目录', () => {
    hoisted.state.systemBlocked.mockReturnValueOnce(true);
    expect(() => workspace.setWorkspaceDir('/etc')).toThrow('不能将系统目录设为工作空间');
    expect(workspace.getWorkspaceDir()).toBe(defaultDir);
  });
});

describe('workspace: startProcess', () => {
  it('命令被拦截时不 spawn', () => {
    hoisted.state.commandCheck.mockReturnValueOnce({ ok: false, reason: 'blocked command' });
    const result = workspace.startProcess('id', 'rm -rf /', undefined, vi.fn(), vi.fn());
    expect(result).toEqual({ success: false, error: 'blocked command' });
    expect(hoisted.state.spawn).not.toHaveBeenCalled();
    expect(hoisted.state.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ level: 'warn', message: '🖥️ 命令被拦截' }),
    );
  });

  it('目录被拦截时不 spawn', () => {
    hoisted.state.pathCheck.mockReturnValueOnce({ ok: false, reason: 'blocked path' });
    const result = workspace.startProcess('id', 'ls', '/outside', vi.fn(), vi.fn());
    expect(result).toEqual({ success: false, error: 'blocked path' });
    expect(hoisted.state.spawn).not.toHaveBeenCalled();
  });

  it('工作目录不存在时返回错误', () => {
    const result = workspace.startProcess('id', 'ls', undefined, vi.fn(), vi.fn());
    expect(result).toEqual({ success: false, error: `工作目录不存在: ${defaultDir}` });
    expect(hoisted.state.spawn).not.toHaveBeenCalled();
  });

  it('成功启动并转发 stdout/stderr/close', () => {
    hoisted.state.existing.add(defaultDir);
    const onOutput = vi.fn();
    const onExit = vi.fn();
    const result = workspace.startProcess('p1', 'echo hi', undefined, onOutput, onExit);
    expect(result).toEqual({ success: true });

    const proc = hoisted.state.procs[0];
    expect(proc.spawnArgs[0]).toBe('bash');
    expect(proc.spawnArgs[1]).toEqual(['-c', 'echo hi']);
    expect(proc.spawnArgs[2]).toMatchObject({
      cwd: defaultDir,
      env: {
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout.emit('data', Buffer.from('out'));
    proc.stderr.emit('data', Buffer.from('err'));
    expect(onOutput).toHaveBeenCalledWith('stdout', 'out');
    expect(onOutput).toHaveBeenCalledWith('stderr', 'err');

    proc.emit('close', 0);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(hoisted.state.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ level: 'success', message: '🖥️ 进程退出' }),
    );
  });

  it('同 id 重启会杀掉旧进程', () => {
    hoisted.state.existing.add(defaultDir);
    workspace.startProcess('same', 'a', undefined, vi.fn(), vi.fn());
    const first = hoisted.state.procs[0];
    workspace.startProcess('same', 'b', undefined, vi.fn(), vi.fn());
    expect(first.kill).toHaveBeenCalledWith('SIGTERM');
    expect(hoisted.state.procs).toHaveLength(2);
  });

  it('spawn 抛错时返回错误', () => {
    hoisted.state.existing.add(defaultDir);
    hoisted.state.spawn!.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    expect(workspace.startProcess('p', 'ls', undefined, vi.fn(), vi.fn())).toEqual({
      success: false,
      error: 'spawn failed',
    });
  });

  it('cwd 参数被 resolve 并做路径检查', () => {
    const cwd = path.resolve('/custom/dir');
    hoisted.state.existing.add(cwd);
    workspace.startProcess('p', 'ls', '/custom/dir', vi.fn(), vi.fn());
    expect(hoisted.state.pathCheck).toHaveBeenCalledWith(cwd, 'read');
    expect(hoisted.state.procs[0].spawnArgs[2].cwd).toBe(cwd);
  });

  it('进程 error 事件回调 stderr 与退出码 1', () => {
    hoisted.state.existing.add(defaultDir);
    const onOutput = vi.fn();
    const onExit = vi.fn();
    workspace.startProcess('p', 'ls', undefined, onOutput, onExit);
    hoisted.state.procs[0].emit('error', new Error('ENOENT'));
    expect(onOutput).toHaveBeenCalledWith('stderr', '进程启动失败: ENOENT\n');
    expect(onExit).toHaveBeenCalledWith(1);
    expect(hoisted.state.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ level: 'error', message: '🖥️ 进程启动失败' }),
    );
  });

  it('Windows 使用 cmd.exe + chcp 65001 且不注入 TERM', () => {
    setPlatform('win32');
    const savedTerm = process.env.TERM;
    delete process.env.TERM;
    try {
      hoisted.state.existing.add(defaultDir);
      workspace.startProcess('p', 'dir', undefined, vi.fn(), vi.fn());
      const proc = hoisted.state.procs[0];
      expect(proc.spawnArgs[0]).toBe('cmd.exe');
      expect(proc.spawnArgs[1]).toEqual(['/c', 'chcp 65001 >nul && dir']);
      expect(proc.spawnArgs[2].env.TERM).toBeUndefined();
    } finally {
      if (savedTerm !== undefined) process.env.TERM = savedTerm;
    }
  });
});

describe('workspace: killProcess / killAllProcesses', () => {
  it('kill 未知进程返回 false', () => {
    expect(workspace.killProcess('missing')).toBe(false);
    expect(hoisted.state.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ level: 'warn', message: '🖥️ kill 未找到进程' }),
    );
  });

  it('POSIX kill 发送 SIGTERM 并移除记录', () => {
    hoisted.state.existing.add(defaultDir);
    workspace.startProcess('p', 'ls', undefined, vi.fn(), vi.fn());
    const proc = hoisted.state.procs[0];
    expect(workspace.killProcess('p')).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(workspace.killProcess('p')).toBe(false);
  });

  it('kill 抛错时返回 false 并移除记录', () => {
    hoisted.state.existing.add(defaultDir);
    workspace.startProcess('p', 'ls', undefined, vi.fn(), vi.fn());
    const proc = hoisted.state.procs[0];
    proc.kill.mockImplementationOnce(() => {
      throw new Error('kill failed');
    });
    expect(workspace.killProcess('p')).toBe(false);
    expect(workspace.killProcess('p')).toBe(false);
  });

  it('Windows 使用 taskkill /T /F 终止进程树', () => {
    setPlatform('win32');
    hoisted.state.existing.add(defaultDir);
    workspace.startProcess('p', 'dir', undefined, vi.fn(), vi.fn());
    expect(workspace.killProcess('p')).toBe(true);
    expect(hoisted.state.spawn).toHaveBeenCalledWith('taskkill', ['/PID', '777', '/T', '/F']);
  });

  it('killAllProcesses 终止所有活跃进程并清空', () => {
    hoisted.state.existing.add(defaultDir);
    workspace.startProcess('a', 'ls', undefined, vi.fn(), vi.fn());
    workspace.startProcess('b', 'ls', undefined, vi.fn(), vi.fn());
    const [a, b] = hoisted.state.procs;
    workspace.killAllProcesses();
    expect(a.kill).toHaveBeenCalledWith('SIGTERM');
    expect(b.kill).toHaveBeenCalledWith('SIGTERM');
    expect(workspace.killProcess('a')).toBe(false);
    expect(workspace.killProcess('b')).toBe(false);
  });

  it('killAllProcesses 忽略 kill 异常', () => {
    hoisted.state.existing.add(defaultDir);
    workspace.startProcess('a', 'ls', undefined, vi.fn(), vi.fn());
    hoisted.state.procs[0].kill.mockImplementationOnce(() => {
      throw new Error('already dead');
    });
    expect(() => workspace.killAllProcesses()).not.toThrow();
  });
});

describe('workspace: listWorkspaceDir', () => {
  it('默认目录列出文件，过滤隐藏文件并按目录优先排序', () => {
    hoisted.state.existing.add(defaultDir);
    hoisted.state.readdir.set(defaultDir, [
      dirent('b.txt', false),
      dirent('.hidden', false),
      dirent('zdir', true),
      dirent('adir', true),
    ]);
    hoisted.state.stats.set(path.join(defaultDir, 'b.txt'), {
      size: 12,
      modified: '2026-01-02T03:04:05.000Z',
      file: true,
    });
    hoisted.state.stats.set(path.join(defaultDir, 'zdir'), {
      size: 0,
      modified: '2026-01-01T00:00:00.000Z',
      file: false,
    });
    hoisted.state.stats.set(path.join(defaultDir, 'adir'), {
      size: 0,
      modified: '2026-01-01T00:00:00.000Z',
      file: false,
    });

    const result = workspace.listWorkspaceDir();
    expect(result.success).toBe(true);
    expect(result.entries).toEqual([
      { name: 'adir', type: 'directory', size: null, modified: '2026-01-01T00:00:00.000Z' },
      { name: 'zdir', type: 'directory', size: null, modified: '2026-01-01T00:00:00.000Z' },
      { name: 'b.txt', type: 'file', size: 12, modified: '2026-01-02T03:04:05.000Z' },
    ]);
  });

  it('允许浏览工作空间子目录', () => {
    const sub = path.join(defaultDir, 'sub');
    hoisted.state.existing.add(sub);
    hoisted.state.readdir.set(sub, []);
    expect(workspace.listWorkspaceDir(sub)).toEqual({ success: true, entries: [] });
  });

  it('拒绝工作空间之外的目录', () => {
    expect(workspace.listWorkspaceDir('/etc')).toEqual({
      success: false,
      error: '只能浏览工作空间目录内的文件',
    });
  });

  it('目录不存在时返回错误', () => {
    expect(workspace.listWorkspaceDir()).toEqual({ success: false, error: '目录不存在' });
  });

  it('readdir 或 stat 抛错时返回错误信息', () => {
    hoisted.state.existing.add(defaultDir);
    hoisted.state.readdirError = new Error('EACCES');
    expect(workspace.listWorkspaceDir()).toEqual({ success: false, error: 'EACCES' });

    hoisted.state.readdirError = null;
    hoisted.state.readdir.set(defaultDir, [dirent('a.txt', false)]);
    hoisted.state.statError = new Error('stat failed');
    expect(workspace.listWorkspaceDir()).toEqual({ success: false, error: 'stat failed' });
  });

  it('拒绝 workspace 前缀相似的兄弟目录（防 startsWith 绕过）', () => {
    hoisted.state.existing.add(`${defaultDir}-evil`);
    expect(workspace.listWorkspaceDir(`${defaultDir}-evil`)).toEqual({
      success: false,
      error: '只能浏览工作空间目录内的文件',
    });
  });
});
