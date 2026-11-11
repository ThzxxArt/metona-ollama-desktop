import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

interface SpawnSpec {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: Error;
  hang?: boolean;
  onStart?: (child: FakeChild) => void;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  queue: [] as unknown[],
  pathAllowed: vi.fn(() => ({ ok: true }) as { ok: boolean; reason?: string }),
  sendLog: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: h.spawn }));
vi.mock('../src/main/tool-security.js', () => ({ checkPathAllowed: h.pathAllowed }));
vi.mock('../src/main/tool-handlers-shared.js', () => ({
  sendLog: h.sendLog,
  resolvePath: (p: string) => p,
}));
vi.mock('../src/main/workspace.js', () => ({ getWorkspaceDir: () => '/ws' }));

import { handleGit } from '../src/main/tool-handlers-git.js';

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
      spec.onStart?.(child);
      if (spec.error) {
        child.emit('error', spec.error);
        return;
      }
      if (spec.stdout) child.stdout.emit('data', Buffer.from(spec.stdout));
      if (spec.stderr) child.stderr.emit('data', Buffer.from(spec.stderr));
      if (!spec.hang) child.emit('close', spec.code === undefined ? 0 : spec.code);
    });
    return child;
  });
}

function lastGitCall(): { args: string[]; options: { cwd: string } } {
  const calls = h.spawn.mock.calls;
  const [cmd, args, options] = calls[calls.length - 1] as [string, string[], { cwd: string }];
  expect(cmd).toBe('git');
  return { args, options };
}

beforeEach(() => {
  vi.useRealTimers();
  h.spawn.mockReset();
  h.queue.length = 0;
  h.pathAllowed.mockReset();
  h.pathAllowed.mockReturnValue({ ok: true });
  h.sendLog.mockReset();
  installSpawn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('git status / log / diff', () => {
  it('status 解析分支、跟踪与各类文件状态', async () => {
    enqueue({
      stdout: [
        '## main...origin/main',
        ' M modified.txt',
        'M  staged.txt',
        '?? new.txt',
        'R  renamed.txt',
        ' D deleted-wt.txt',
        'D  deleted-index.txt',
        'MM both.txt',
        '',
      ].join('\n'),
    });
    const r = await handleGit({ action: 'status' });
    expect(r.success).toBe(true);
    expect(r.branch).toBe('main');
    expect(r.tracking).toBe('origin/main');
    expect(r.modified).toEqual(['modified.txt', 'both.txt']);
    expect(r.staged).toEqual(['staged.txt', 'both.txt']);
    expect(r.untracked).toEqual(['new.txt']);
    expect(r.deleted).toEqual(['deleted-wt.txt', 'deleted-index.txt']);
    expect(r.renamed).toEqual(['renamed.txt']);
    expect(r.isClean).toBe(false);
    expect(lastGitCall().args).toEqual(['status', '--porcelain=v1', '-b']);
    expect(lastGitCall().options.cwd).toBe('/ws');
  });

  it('status 干净仓库与无分支行', async () => {
    enqueue({ stdout: '## main\n' });
    const clean = await handleGit({ action: 'status' });
    expect(clean.isClean).toBe(true);
    expect(clean.branch).toBe('main');
    expect(clean.tracking).toBe('');

    enqueue({ stdout: '' });
    const unknown = await handleGit({ action: 'status' });
    expect(unknown.branch).toBe('unknown');
  });

  it('status 非 git 仓库返回 stderr', async () => {
    enqueue({ stderr: 'fatal: not a git repository', code: 128 });
    const r = await handleGit({ action: 'status' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('not a git repository');
  });

  it('status 非仓库且无 stderr 使用默认错误', async () => {
    enqueue({ code: 1 });
    const r = await handleGit({ action: 'status' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('不是 git 仓库');
  });

  it('log 解析 oneline 并支持 count/all', async () => {
    enqueue({ stdout: 'abc123 first commit\n\ndef456 second commit\n' });
    const r = await handleGit({ action: 'log', count: 5, all: true });
    expect(r.success).toBe(true);
    expect(r.commits).toEqual([
      { hash: 'abc123', message: 'first commit' },
      { hash: 'def456', message: 'second commit' },
    ]);
    expect(r.total).toBe(2);
    expect(lastGitCall().args).toEqual(['log', '--oneline', '--max-count=5', '--all']);
  });

  it('log 默认 20 条且失败返回错误', async () => {
    enqueue({ stdout: 'abc only\n' });
    await handleGit({ action: 'log' });
    expect(lastGitCall().args).toEqual(['log', '--oneline', '--max-count=20']);

    enqueue({ stderr: 'bad revision', code: 1 });
    const r = await handleGit({ action: 'log' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('bad revision');
  });

  it('diff 支持 staged 与文件列表', async () => {
    enqueue({ stdout: 'diff --git a/x b/x\n+hello\n' });
    const r = await handleGit({ action: 'diff', staged: true, files: ['x', 'y'] });
    expect(r.success).toBe(true);
    expect(r.diff).toContain('+hello');
    expect(r.hasChanges).toBe(true);
    expect(r.staged).toBe(true);
    expect(lastGitCall().args).toEqual(['diff', '--cached', '--', 'x', 'y']);
  });

  it('diff 无变化与失败', async () => {
    enqueue({ stdout: '   \n' });
    const empty = await handleGit({ action: 'diff' });
    expect(empty.hasChanges).toBe(false);

    enqueue({ stderr: 'diff failed', code: 1 });
    const failed = await handleGit({ action: 'diff' });
    expect(failed.success).toBe(false);
    expect(failed.error).toBe('diff failed');
  });
});

describe('git add / commit / push / pull', () => {
  it('add 要求文件列表', async () => {
    const r = await handleGit({ action: 'add' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('指定要暂存的文件');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('add 使用 -- 分隔防止选项注入', async () => {
    enqueue({});
    const r = await handleGit({ action: 'add', files: ['-danger.txt'] });
    expect(r.success).toBe(true);
    expect(r.files).toEqual(['-danger.txt']);
    expect(lastGitCall().args).toEqual(['add', '--', '-danger.txt']);
  });

  it('add 失败返回 stderr', async () => {
    enqueue({ stderr: 'pathspec did not match', code: 128 });
    const r = await handleGit({ action: 'add', files: ['x'] });
    expect(r.success).toBe(false);
    expect(r.error).toContain('pathspec');
  });

  it('commit 要求 message', async () => {
    const r = await handleGit({ action: 'commit' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('提交信息');
  });

  it('commit 成功与失败', async () => {
    enqueue({ stdout: '[main abc] msg\n' });
    const ok = await handleGit({ action: 'commit', message: 'msg' });
    expect(ok.success).toBe(true);
    expect(ok.output).toBe('[main abc] msg');
    expect(lastGitCall().args).toEqual(['commit', '-m', 'msg']);

    enqueue({ stderr: 'nothing to commit', code: 1 });
    const bad = await handleGit({ action: 'commit', message: 'msg' });
    expect(bad.success).toBe(false);
    expect(bad.error).toBe('nothing to commit');
  });

  it('commit 失败且无 stderr 使用默认提示', async () => {
    enqueue({ code: 1 });
    const r = await handleGit({ action: 'commit', message: 'msg' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('可能没有暂存的更改');
  });

  it('push 组装 remote/branch/force 并优先返回 stderr', async () => {
    enqueue({ stdout: 'stdout text', stderr: 'remote: pushed\n' });
    const r = await handleGit({ action: 'push', remote: 'origin', branch: 'main', force: true });
    expect(r.success).toBe(true);
    expect(r.output).toBe('remote: pushed');
    expect(lastGitCall().args).toEqual(['push', 'origin', 'main', '--force']);
  });

  it('push 失败', async () => {
    enqueue({ stderr: 'rejected', code: 1 });
    const r = await handleGit({ action: 'push' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('rejected');
  });

  it('pull 成功与失败', async () => {
    enqueue({ stdout: 'Already up to date.\n' });
    const ok = await handleGit({ action: 'pull', remote: 'origin', branch: 'main' });
    expect(ok.success).toBe(true);
    expect(ok.output).toBe('Already up to date.');
    expect(lastGitCall().args).toEqual(['pull', 'origin', 'main']);

    enqueue({ stderr: 'merge conflict', code: 1 });
    const bad = await handleGit({ action: 'pull' });
    expect(bad.success).toBe(false);
    expect(bad.error).toBe('merge conflict');
  });
});

describe('git branch / checkout / merge / stash', () => {
  it('创建分支', async () => {
    enqueue({});
    const r = await handleGit({ action: 'branch', new_branch: true, branch: 'feat' });
    expect(r.success).toBe(true);
    expect(r.created).toBe('feat');
    expect(lastGitCall().args).toEqual(['checkout', '-b', 'feat']);
  });

  it('创建分支失败', async () => {
    enqueue({ stderr: 'already exists', code: 128 });
    const r = await handleGit({ action: 'branch', new_branch: true, branch: 'feat' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('already exists');
  });

  it('删除分支', async () => {
    enqueue({});
    const r = await handleGit({ action: 'branch', delete_branch: true, branch: 'old' });
    expect(r.success).toBe(true);
    expect(r.deleted).toBe('old');
    expect(lastGitCall().args).toEqual(['branch', '-d', 'old']);
  });

  it('删除分支失败', async () => {
    enqueue({ stderr: 'not merged', code: 1 });
    const r = await handleGit({ action: 'branch', delete_branch: true, branch: 'old' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('not merged');
  });

  it('列出分支并标记当前分支', async () => {
    enqueue({ stdout: '* main\n  dev\n  feature/x\n' });
    const r = await handleGit({ action: 'branch', all: true });
    expect(r.success).toBe(true);
    expect(r.branches).toEqual([
      { name: 'main', current: true },
      { name: 'dev', current: false },
      { name: 'feature/x', current: false },
    ]);
    expect(lastGitCall().args).toEqual(['branch', '-a']);
  });

  it('列出分支失败', async () => {
    enqueue({ stderr: 'branch error', code: 1 });
    const r = await handleGit({ action: 'branch' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('branch error');
  });

  it('checkout 要求分支名，支持 force 与失败', async () => {
    const missing = await handleGit({ action: 'checkout' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('分支名');

    enqueue({});
    const ok = await handleGit({ action: 'checkout', branch: 'main', force: true });
    expect(ok.success).toBe(true);
    expect(lastGitCall().args).toEqual(['checkout', '-f', 'main']);

    enqueue({ stderr: 'no such branch', code: 1 });
    const bad = await handleGit({ action: 'checkout', branch: 'nope' });
    expect(bad.success).toBe(false);
    expect(bad.error).toBe('no such branch');
  });

  it('merge 要求分支，成功与冲突', async () => {
    const missing = await handleGit({ action: 'merge' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('合并的分支');

    enqueue({ stdout: 'Fast-forward\n' });
    const ok = await handleGit({ action: 'merge', branch: 'dev' });
    expect(ok.success).toBe(true);
    expect(ok.output).toBe('Fast-forward');
    expect(lastGitCall().args).toEqual(['merge', 'dev']);

    enqueue({ stderr: 'CONFLICT', code: 1 });
    const conflict = await handleGit({ action: 'merge', branch: 'dev' });
    expect(conflict.success).toBe(false);
    expect(conflict.error).toBe('CONFLICT');

    enqueue({ code: 1 });
    const noStderr = await handleGit({ action: 'merge', branch: 'dev' });
    expect(noStderr.success).toBe(false);
    expect(noStderr.error).toBe('合并冲突');
  });

  it('stash 默认 push、带 message 与自定义子命令', async () => {
    enqueue({ stdout: 'Saved working directory\n' });
    const def = await handleGit({ action: 'stash' });
    expect(def.success).toBe(true);
    expect(def.subAction).toBe('push');
    expect(lastGitCall().args).toEqual(['stash', 'push']);

    enqueue({});
    await handleGit({ action: 'stash', message: 'wip' });
    expect(lastGitCall().args).toEqual(['stash', 'push', '-m', 'wip']);

    enqueue({});
    const pop = await handleGit({ action: 'stash', stash_sub: 'pop' } as never);
    expect(pop.subAction).toBe('pop');
    expect(lastGitCall().args).toEqual(['stash', 'pop']);
  });

  it('stash 失败', async () => {
    enqueue({ stderr: 'no local changes', code: 1 });
    const r = await handleGit({ action: 'stash' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('no local changes');
  });
});

describe('git remote / clone / init / reset / tag', () => {
  it('remote add 与列表', async () => {
    enqueue({});
    const add = await handleGit({ action: 'remote', remote: 'origin', remote_url: 'https://x.test/repo.git' });
    expect(add.success).toBe(true);
    expect(add.added).toBe('origin');
    expect(lastGitCall().args).toEqual(['remote', 'add', 'origin', 'https://x.test/repo.git']);

    enqueue({ stdout: 'origin\thttps://x.test/repo.git (fetch)\norigin\thttps://x.test/repo.git (push)\n' });
    const list = await handleGit({ action: 'remote' });
    expect(list.success).toBe(true);
    expect(list.remotes).toEqual([
      { name: 'origin', url: 'https://x.test/repo.git' },
      { name: 'origin', url: 'https://x.test/repo.git' },
    ]);
    expect(lastGitCall().args).toEqual(['remote', '-v']);
  });

  it('remote add/列表失败', async () => {
    enqueue({ stderr: 'remote exists', code: 1 });
    const add = await handleGit({
      action: 'remote',
      remote: 'origin',
      remote_url: 'https://ok.test/r.git',
    });
    expect(add.success).toBe(false);
    expect(add.error).toBe('remote exists');

    enqueue({ stderr: 'remote failed', code: 1 });
    const list = await handleGit({ action: 'remote' });
    expect(list.success).toBe(false);
    expect(list.error).toBe('remote failed');
  });

  it('clone 要求 URL，成功与失败', async () => {
    const missing = await handleGit({ action: 'clone' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('仓库 URL');

    enqueue({});
    const ok = await handleGit({ action: 'clone', url: 'https://x.test/r.git', path: '/dest' });
    expect(ok.success).toBe(true);
    expect(ok.destination).toBe('/dest');
    expect(lastGitCall().args).toEqual(['clone', 'https://x.test/r.git', '/dest']);

    enqueue({ stderr: 'clone failed', code: 128 });
    const bad = await handleGit({ action: 'clone', url: 'https://x.test/r.git' });
    expect(bad.success).toBe(false);
    expect(bad.error).toBe('clone failed');
  });

  it('clone 拒绝 ext:: / file:// 等危险 transport', async () => {
    const ext = await handleGit({ action: 'clone', url: 'ext::sh -c touch /tmp/pwned', path: '/dest' });
    expect(ext.success).toBe(false);
    expect(String(ext.error)).toContain('只支持');
    const file = await handleGit({ action: 'clone', url: 'file:///etc', path: '/dest' });
    expect(file.success).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('clone 目标路径写权限被拒绝', async () => {
    h.pathAllowed.mockReturnValueOnce({ ok: true }).mockReturnValueOnce({ ok: false, reason: '写操作被限制' });
    const r = await handleGit({ action: 'clone', url: 'https://x.test/r.git', path: '/etc/x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('写操作被限制');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('init 成功与失败', async () => {
    enqueue({ stdout: 'Initialized empty Git repository\n' });
    const ok = await handleGit({ action: 'init' });
    expect(ok.success).toBe(true);
    expect(ok.output).toContain('Initialized');
    expect(lastGitCall().args).toEqual(['init']);

    enqueue({ stderr: 'init failed', code: 1 });
    const bad = await handleGit({ action: 'init' });
    expect(bad.success).toBe(false);
    expect(bad.error).toBe('init failed');
  });

  it('reset 支持 cached/hard/files', async () => {
    enqueue({ stdout: 'Unstaged changes after reset\n' });
    const r = await handleGit({ action: 'reset', staged: true, force: true, files: ['a', 'b'] });
    expect(r.success).toBe(true);
    expect(lastGitCall().args).toEqual(['reset', '--cached', '--hard', '--', 'a', 'b']);
  });

  it('reset 失败', async () => {
    enqueue({ stderr: 'reset failed', code: 1 });
    const r = await handleGit({ action: 'reset' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('reset failed');
  });

  it('tag 创建轻量/附注标签与列表', async () => {
    enqueue({});
    const light = await handleGit({ action: 'tag', tag_name: 'v1.0.0' } as never);
    expect(light.success).toBe(true);
    expect(light.created).toBe('v1.0.0');
    expect(lastGitCall().args).toEqual(['tag', 'v1.0.0']);

    enqueue({});
    const annotated = await handleGit({ action: 'tag', tag_name: 'v1.1.0', message: 'release' } as never);
    expect(annotated.success).toBe(true);
    expect(lastGitCall().args).toEqual(['tag', '-a', 'v1.1.0', '-m', 'release']);

    enqueue({ stdout: 'v1.0.0\nv1.1.0\n' });
    const list = await handleGit({ action: 'tag' });
    expect(list.success).toBe(true);
    expect(list.tags).toEqual(['v1.0.0', 'v1.1.0']);
    expect(lastGitCall().args).toEqual(['tag', '-l']);
  });

  it('tag 兼容旧 branch 参数并处理失败', async () => {
    enqueue({});
    const legacy = await handleGit({ action: 'tag', branch: 'v2' });
    expect(legacy.created).toBe('v2');

    enqueue({ stderr: 'tag exists', code: 1 });
    const bad = await handleGit({ action: 'tag', tag_name: 'v1' } as never);
    expect(bad.success).toBe(false);
    expect(bad.error).toBe('tag exists');
  });

  it('未知 action 返回错误', async () => {
    const r = await handleGit({ action: 'unknown-action' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('未知 git 操作');
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe('git 安全防护与异常', () => {
  it.each([
    ['branch', '-branch'],
    ['remote', '-remote'],
    ['url', '-url'],
    ['remote_url', '--upload-pack=evil'],
    ['tag_name', '-tag'],
    ['stash_sub', '--exec=evil'],
  ])('拒绝以 - 开头的 %s 参数', async (name, value) => {
    const r = await handleGit({ action: 'status', [name]: value } as never);
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain(`参数 ${name}`);
    expect(String(r.error)).toContain('选项注入');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['remote_url', 'ext::sh -c touch /tmp/pwn'],
    ['remote_url', 'file:///etc/passwd'],
    ['url', 'ext::sh -c id'],
    ['url', 'not-a-url'],
  ])('拒绝不安全的 git URL（%s=%s）', async (name, value) => {
    const r = await handleGit({ action: 'remote', remote: 'origin', [name]: value } as never);
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain(`参数 ${name} 只支持`);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('允许 scp-like SSH URL', async () => {
    enqueue({});
    const r = await handleGit({
      action: 'clone',
      url: 'git@github.com:user/repo.git',
      path: '/dest',
    });
    expect(r.success).toBe(true);
    expect(lastGitCall().args).toEqual(['clone', 'git@github.com:user/repo.git', '/dest']);
  });

  it('工作目录安全检查失败时不执行 git', async () => {
    h.pathAllowed.mockReturnValue({ ok: false, reason: '禁止访问系统目录' });
    const r = await handleGit({ action: 'status', path: '/etc' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('禁止访问系统目录');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('spawn error 事件转为失败结果', async () => {
    enqueue({ error: new Error('spawn git ENOENT') });
    const r = await handleGit({ action: 'status' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('spawn git ENOENT');
  });

  it('spawn 同步抛异常被外层捕获', async () => {
    h.spawn.mockImplementationOnce(() => {
      throw new Error('spawn blocked');
    });
    const r = await handleGit({ action: 'status' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('spawn blocked');
  });

  it('push 超时会 kill 子进程并返回超时错误', async () => {
    vi.useFakeTimers();
    enqueue({ hang: true });
    const p = handleGit({ action: 'push' });
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await p;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('操作超时 (60s)');
    const child = h.spawn.mock.results[0].value as FakeChild;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
