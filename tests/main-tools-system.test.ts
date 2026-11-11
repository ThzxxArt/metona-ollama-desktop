import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as fss from 'fs';
import * as path from 'path';
import * as os from 'os';

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
  netCheck: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string }),
  sendLog: vi.fn(),
  httpTimeout: 900_000,
}));

vi.mock('child_process', () => ({ spawn: h.spawn }));
vi.mock('../src/main/tool-security.js', () => ({ checkPathAllowed: h.pathAllowed }));
vi.mock('../src/main/tool-handlers-shared.js', () => ({
  sendLog: h.sendLog,
  resolvePath: (p: string) => p,
}));
vi.mock('../src/main/net-guard.js', () => ({ checkPublicHttpUrl: h.netCheck }));
vi.mock('../src/main/tools/web.js', () => ({ getHTTPTimeout: () => h.httpTimeout }));

import { handleDownloadFile, handleCompress } from '../src/main/tools/system.js';

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

function makeResponse(
  body: ArrayBuffer | string,
  opts: { status?: number; contentType?: string | null } = {},
): Response {
  const status = opts.status ?? 200;
  const headers = new Headers();
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'application/octet-stream');
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers,
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
    text: async () => (typeof body === 'string' ? body : ''),
    body: null,
  } as unknown as Response;
}

const fetchMock = vi.fn();
let tmpDir: string;

const realSetImmediate = setImmediate;
const realSetTimeout = setTimeout;

async function advanceUntilSettled<T>(p: Promise<T>, step = 1000, maxSteps = 80): Promise<T> {
  let result: T | undefined;
  let error: unknown;
  let settled = false;
  p.then(
    (v) => {
      result = v;
      settled = true;
    },
    (e) => {
      error = e;
      settled = true;
    },
  );
  for (let i = 0; i < maxSteps && !settled; i++) {
    await vi.advanceTimersByTimeAsync(step);
    // fs.promises 使用线程池，必须让真实 event loop 转一圈，并给 I/O 回调
    // 留出真实的调度窗口；CI 磁盘较慢时只转一圈会误判 promise 未结算。
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
    await Promise.resolve();
  }
  if (!settled) throw new Error('promise did not settle with fake timers');
  if (error) throw error;
  return result as T;
}

beforeEach(async () => {
  vi.useRealTimers();
  h.spawn.mockReset();
  h.queue.length = 0;
  h.pathAllowed.mockReset();
  h.pathAllowed.mockReturnValue({ ok: true });
  h.netCheck.mockReset();
  h.netCheck.mockResolvedValue({ ok: true });
  h.sendLog.mockReset();
  h.httpTimeout = 900_000;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  installSpawn();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metona-system-test-'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('download_file', () => {
  it('目标路径写权限被拒绝', async () => {
    h.pathAllowed.mockReturnValue({ ok: false, reason: '写操作被限制' });
    const r = await handleDownloadFile({ url: 'https://x.test/a', destination: path.join(tmpDir, 'a') });
    expect(r.success).toBe(false);
    expect(r.error).toBe('写操作被限制');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拒绝非 http/https 协议', async () => {
    const r = await handleDownloadFile({ url: 'file:///etc/passwd', destination: path.join(tmpDir, 'a') });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('http/https');
    expect(h.netCheck).not.toHaveBeenCalled();
  });

  it('SSRF 拦截', async () => {
    h.netCheck.mockResolvedValue({ ok: false, reason: '禁止访问内网/环回地址: 127.0.0.1' });
    const r = await handleDownloadFile({ url: 'http://127.0.0.1:11434/x', destination: path.join(tmpDir, 'a') });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('安全拦截');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('成功下载并写盘', async () => {
    const payload = Buffer.from('binary-data');
    fetchMock.mockResolvedValueOnce(
      makeResponse(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength), {
        contentType: 'application/octet-stream',
      }),
    );
    const dest = path.join(tmpDir, 'nested', 'file.bin');
    const r = await handleDownloadFile({ url: 'https://x.test/file.bin', destination: dest });
    expect(r.success).toBe(true);
    expect(r.size).toBe(payload.length);
    expect(r.content_type).toBe('application/octet-stream');
    expect(await fs.readFile(dest)).toEqual(payload);
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['User-Agent']).toContain('Chrome');
  });

  it('缺少 content-type 时返回 unknown', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('abc', { contentType: null }));
    const r = await handleDownloadFile({ url: 'https://x.test/a', destination: path.join(tmpDir, 'a') });
    expect(r.success).toBe(true);
    expect(r.content_type).toBe('unknown');
  });

  it('4xx 不重试直接失败', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('not found', { status: 404 }));
    const r = await handleDownloadFile({ url: 'https://x.test/404', destination: path.join(tmpDir, 'a') });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx 重试后成功', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(makeResponse('err', { status: 500 })).mockResolvedValueOnce(makeResponse('ok'));
    const r = await advanceUntilSettled(
      handleDownloadFile({ url: 'https://x.test/retry', destination: path.join(tmpDir, 'retry') }),
    );
    expect(r.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('网络错误重试后成功', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(makeResponse('ok'));
    const r = await advanceUntilSettled(
      handleDownloadFile({ url: 'https://x.test/net', destination: path.join(tmpDir, 'net') }),
    );
    expect(r.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('超时重试耗尽后返回超时错误', async () => {
    vi.useFakeTimers();
    h.httpTimeout = 5000;
    fetchMock.mockRejectedValue(new Error('The operation was aborted'));
    const r = await advanceUntilSettled(
      handleDownloadFile({ url: 'https://x.test/slow', destination: path.join(tmpDir, 'slow') }),
    );
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('下载超时 (5s)');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('文件超过 50MB 限制', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(new ArrayBuffer(50 * 1024 * 1024 + 1)));
    const r = await handleDownloadFile({ url: 'https://x.test/big', destination: path.join(tmpDir, 'big') });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('50MB');
  });

  it('写盘失败时返回错误', async () => {
    const blocker = path.join(tmpDir, 'blocker');
    await fs.writeFile(blocker, 'x');
    fetchMock.mockResolvedValueOnce(makeResponse('abc'));
    const r = await handleDownloadFile({
      url: 'https://x.test/a',
      destination: path.join(blocker, 'child.txt'),
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/ENOTDIR|EEXIST/);
  });

  it('arrayBuffer 抛 abort 错误时返回实际配置的超时提示', async () => {
    h.httpTimeout = 5000;
    const headers = new Headers({ 'content-type': 'application/octet-stream' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers,
      arrayBuffer: async () => {
        throw new Error('The operation was aborted');
      },
    });
    const r = await handleDownloadFile({ url: 'https://x.test/abort', destination: path.join(tmpDir, 'abort') });
    expect(r.success).toBe(false);
    expect(r.error).toBe('下载超时 (5s)');
  });

  it('getHTTPTimeout 为 0 时使用 60s 兜底', async () => {
    vi.useFakeTimers();
    h.httpTimeout = 0;
    fetchMock.mockRejectedValue(new Error('The operation was aborted'));
    const r = await advanceUntilSettled(
      handleDownloadFile({ url: 'https://x.test/zero', destination: path.join(tmpDir, 'zero') }),
    );
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('下载超时 (60s)');
  });
});

describe('compress create', () => {
  it('Linux zip 创建并返回归档大小', async () => {
    const src = path.join(tmpDir, 'srcdir');
    await fs.mkdir(src);
    const dest = src + '.zip';
    enqueue({
      onStart: () => fss.writeFileSync(dest, 'zip-bytes'),
    });
    const r = await handleCompress({ action: 'create', path: src, format: 'zip' });
    expect(r.success).toBe(true);
    expect(r.action).toBe('create');
    expect(r.archive).toBe(dest);
    expect(r.size).toBe(9);
    const [cmd, args, opts] = h.spawn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(cmd).toBe('zip');
    expect(args).toEqual(['-r', dest, 'srcdir']);
    expect(opts.cwd).toBe(tmpDir);
  });

  it('默认 tar.gz 创建，stat 失败也返回成功', async () => {
    const src = path.join(tmpDir, 'tardir');
    await fs.mkdir(src);
    enqueue({});
    const r = await handleCompress({ action: 'create', path: src });
    expect(r.success).toBe(true);
    expect(r.archive).toBe(src + '.tar.gz');
    const [cmd, args] = h.spawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('tar');
    expect(args).toEqual(['czf', src + '.tar.gz', 'tardir']);
  });

  it('自定义 destination', async () => {
    const src = path.join(tmpDir, 'custom-src');
    await fs.mkdir(src);
    const dest = path.join(tmpDir, 'custom.tar.gz');
    enqueue({});
    const r = await handleCompress({ action: 'create', path: src, destination: dest });
    expect(r.success).toBe(true);
    expect(r.archive).toBe(dest);
  });

  it('源路径读取权限被拒绝', async () => {
    h.pathAllowed.mockReturnValueOnce({ ok: false, reason: '禁止读取' });
    const r = await handleCompress({ action: 'create', path: '/secret' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('禁止读取');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('目标路径写权限被拒绝', async () => {
    h.pathAllowed.mockReturnValueOnce({ ok: true }).mockReturnValueOnce({ ok: false, reason: '禁止写入' });
    const r = await handleCompress({ action: 'create', path: '/src' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('禁止写入');
  });

  it('close 非零返回 stderr', async () => {
    enqueue({ stderr: 'zip: command failed', code: 2 });
    const r = await handleCompress({ action: 'create', path: '/src', format: 'zip' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('zip: command failed');
  });

  it('close 非零且无 stderr 返回退出码', async () => {
    enqueue({ code: 3 });
    const r = await handleCompress({ action: 'create', path: '/src' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('压缩失败 (exit 3)');
  });

  it('spawn error 事件返回错误', async () => {
    enqueue({ error: new Error('spawn zip ENOENT') });
    const r = await handleCompress({ action: 'create', path: '/src', format: 'zip' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('spawn zip ENOENT');
  });

  it('Windows zip 使用 PowerShell Compress-Archive 并转义单引号', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const src = path.join(tmpDir, "it's-src");
      const dest = path.join(tmpDir, "it's-out.zip");
      enqueue({});
      const r = await handleCompress({ action: 'create', path: src, destination: dest, format: 'zip' });
      expect(r.success).toBe(true);
      const [cmd, args] = h.spawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('powershell');
      expect(args.join(' ')).toContain('Compress-Archive');
      expect(args.join(' ')).toContain("it''s-src");
      expect(args.join(' ')).toContain("it''s-out.zip");
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('compress extract', () => {
  it('Linux zip 解压', async () => {
    const archive = path.join(tmpDir, 'a.zip');
    await fs.writeFile(archive, 'x');
    const dest = path.join(tmpDir, 'extract-zip');
    enqueue({});
    const r = await handleCompress({ action: 'extract', path: archive, destination: dest });
    expect(r.success).toBe(true);
    expect(r.action).toBe('extract');
    expect(r.destination).toBe(dest);
    expect(await fs.stat(dest).then((s) => s.isDirectory())).toBe(true);
    const [cmd, args] = h.spawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('unzip');
    expect(args).toEqual(['-o', archive, '-d', dest]);
  });

  it('tar 解压到默认目录', async () => {
    const archive = path.join(tmpDir, 'a.tar.gz');
    await fs.writeFile(archive, 'x');
    enqueue({});
    const r = await handleCompress({ action: 'extract', path: archive });
    expect(r.success).toBe(true);
    expect(r.destination).toBe(tmpDir);
    const [cmd, args] = h.spawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('tar');
    expect(args).toEqual(['xzf', archive, '-C', tmpDir]);
  });

  it('归档读取权限被拒绝', async () => {
    h.pathAllowed.mockReturnValueOnce({ ok: false, reason: '禁止读取归档' });
    const r = await handleCompress({ action: 'extract', path: '/a.zip' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('禁止读取归档');
  });

  it('目标目录写权限被拒绝', async () => {
    h.pathAllowed.mockReturnValueOnce({ ok: true }).mockReturnValueOnce({ ok: false, reason: '禁止写入目录' });
    const r = await handleCompress({ action: 'extract', path: '/a.zip', destination: '/out' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('禁止写入目录');
  });

  it('创建目标目录失败时返回错误', async () => {
    const blocker = path.join(tmpDir, 'blocker-file');
    await fs.writeFile(blocker, 'x');
    const r = await handleCompress({
      action: 'extract',
      path: path.join(tmpDir, 'a.zip'),
      destination: path.join(blocker, 'sub'),
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('ENOTDIR');
  });

  it('close 非零返回 stderr', async () => {
    enqueue({ stderr: 'unzip: bad archive', code: 9 });
    const r = await handleCompress({
      action: 'extract',
      path: '/a.zip',
      destination: path.join(tmpDir, 'out-fail'),
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe('unzip: bad archive');
  });

  it('close 非零且无 stderr 返回退出码', async () => {
    enqueue({ code: 7 });
    const r = await handleCompress({
      action: 'extract',
      path: '/a.tar.gz',
      destination: path.join(tmpDir, 'out-fail-2'),
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe('解压失败 (exit 7)');
  });

  it('spawn error 事件返回错误', async () => {
    enqueue({ error: new Error('spawn unzip ENOENT') });
    const r = await handleCompress({
      action: 'extract',
      path: '/a.zip',
      destination: path.join(tmpDir, 'out-fail-3'),
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('spawn unzip ENOENT');
  });

  it('Windows zip 使用 PowerShell Expand-Archive', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      enqueue({});
      const r = await handleCompress({
        action: 'extract',
        path: '/a.zip',
        destination: path.join(tmpDir, 'out-win'),
      });
      expect(r.success).toBe(true);
      const [cmd, args] = h.spawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('powershell');
      expect(args.join(' ')).toContain('Expand-Archive');
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});
