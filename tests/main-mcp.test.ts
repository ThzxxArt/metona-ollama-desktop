import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type AnyFn = (...args: any[]) => any;

const hoisted = vi.hoisted(() => ({
  procs: [] as any[],
  classes: {} as Record<string, any>,
  responder: null as AnyFn | null,
  writeThrows: false,
  spawn: null as AnyFn | null,
  send: vi.fn(),
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
    pid = 4242;
    stdin: any;
    stdout = new Emitter();
    stderr = new Emitter();
    kill = vi.fn();
    constructor() {
      super();
      this.stdin = {
        write: vi.fn((line: string) => {
          if (hoisted.writeThrows) throw new Error('write failed');
          hoisted.responder?.(this, line);
          return true;
        }),
      };
    }
  }

  hoisted.classes.FakeProc = FakeProc;
  hoisted.spawn = vi.fn((...args: any[]) => {
    const proc = new FakeProc();
    (proc as any).spawnArgs = args;
    hoisted.procs.push(proc);
    return proc;
  });

  return { spawn: hoisted.spawn, ChildProcess: class {} };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '0.18.0' },
}));

vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { send: hoisted.send } },
}));

let mcp: any;

function sendResponse(proc: any, id: number, payload: Record<string, unknown>): void {
  const line = JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n';
  queueMicrotask(() => proc.stdout.emit('data', Buffer.from(line)));
}

function defaultRespond(proc: any, line: string): void {
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return;
  if (req.method === 'initialize') {
    sendResponse(proc, req.id, {
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } },
    });
  } else if (req.method === 'tools/list') {
    sendResponse(proc, req.id, {
      result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] },
    });
  } else if (req.method === 'tools/call') {
    sendResponse(proc, req.id, { result: { content: [{ type: 'text', text: 'ok' }] } });
  } else {
    sendResponse(proc, req.id, { result: {} });
  }
}

function respondWith(overrides: Record<string, (proc: any, req: any) => void>): void {
  hoisted.responder = (proc: any, line: string) => {
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (req.id !== undefined && overrides[req.method]) {
      overrides[req.method](proc, req);
      return;
    }
    defaultRespond(proc, line);
  };
}

async function loadMcp(): Promise<any> {
  vi.resetModules();
  return import('../src/main/mcp-manager.js');
}

async function start(name = 'demo', args = ['server.js']): Promise<any> {
  return mcp.startServer({ name, command: 'node', args, enabled: true });
}

function writtenRequests(proc: any): any[] {
  return proc.stdin.write.mock.calls.map((call: any[]) => {
    try {
      return JSON.parse(call[0]);
    } catch {
      return call[0];
    }
  });
}

beforeEach(async () => {
  hoisted.procs.length = 0;
  hoisted.writeThrows = false;
  hoisted.responder = defaultRespond;
  hoisted.send.mockClear();
  hoisted.spawn?.mockClear();
  mcp = await loadMcp();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mcp-manager: startServer', () => {
  it('成功握手、发送 initialized 通知并拉取工具', async () => {
    const result = await start();
    expect(result).toEqual({ success: true });

    const proc = hoisted.procs[0];
    expect(hoisted.spawn).toHaveBeenCalledWith('node', ['server.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      cwd: process.cwd(),
    });
    const requests = writtenRequests(proc);
    expect(requests[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'Metona Ollama', version: '0.18.0' },
      },
    });
    expect(requests[1]).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(requests[2]).toMatchObject({ method: 'tools/list' });

    expect(mcp.getServerStatuses()).toEqual([{ name: 'demo', running: true, toolCount: 1 }]);
    expect(mcp.getAllTools()).toEqual([
      {
        serverName: 'demo',
        name: 'echo',
        fullName: 'mcp_demo__echo',
        description: '[MCP:demo] Echo',
        inputSchema: { type: 'object' },
      },
    ]);
  });

  it('握手错误时停止服务器并返回错误', async () => {
    respondWith({
      initialize: (proc, req) => {
        sendResponse(proc, req.id, { error: { code: -32603, message: 'init failed' } });
      },
    });
    const result = await start();
    expect(result).toEqual({ success: false, error: 'MCP 错误 [-32603]: init failed' });
    expect(hoisted.procs[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(mcp.getServerStatuses()).toEqual([]);
  });

  it('重复启动同名服务器会先停止旧进程，旧进程迟到事件不误删新实例', async () => {
    await start('dup');
    const first = hoisted.procs[0];
    await start('dup');
    expect(first.kill).toHaveBeenCalledWith('SIGTERM');
    expect(hoisted.procs).toHaveLength(2);
    expect(mcp.getServerStatuses()).toHaveLength(1);

    first.emit('close', 0);
    expect(mcp.getServerStatuses()).toEqual([{ name: 'dup', running: true, toolCount: 1 }]);
    first.emit('error', new Error('late error'));
    expect(mcp.getServerStatuses()).toEqual([{ name: 'dup', running: true, toolCount: 1 }]);
  });

  it('spawn 抛错时返回错误', async () => {
    hoisted.spawn!.mockImplementationOnce(() => {
      throw new Error('spawn boom');
    });
    await expect(start()).resolves.toEqual({ success: false, error: 'spawn boom' });
  });

  it('stdin 写入失败时握手失败', async () => {
    hoisted.writeThrows = true;
    await expect(start()).resolves.toEqual({ success: false, error: 'MCP 写入失败: write failed' });
    expect(hoisted.procs[0].kill).toHaveBeenCalled();
  });

  it('握手超时后停止服务器', async () => {
    vi.useFakeTimers();
    hoisted.responder = () => {};
    const pending = start('slow');
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain('MCP 请求超时: slow / initialize');
    expect(hoisted.procs[0].kill).toHaveBeenCalled();
    expect(mcp.getServerStatuses()).toEqual([]);
  });

  it('setMCPTimeout 下限为 10s，0 表示禁用超时', async () => {
    vi.useFakeTimers();
    hoisted.responder = () => {};
    mcp.setMCPTimeout(1_000);
    const pending = start('clamped');
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.error).toContain('(10000ms)');

    mcp.setMCPTimeout(0);
    hoisted.procs.length = 0;
    const noTimeout = start('disabled');
    await vi.advanceTimersByTimeAsync(120_000);
    let noTimeoutSettled = false;
    void noTimeout.then(() => {
      noTimeoutSettled = true;
    });
    await Promise.resolve();
    expect(noTimeoutSettled).toBe(false);
    mcp.stopServer('disabled');
    await expect(noTimeout).resolves.toMatchObject({ success: false });
  });
});

describe('mcp-manager: JSON-RPC 分帧与响应', () => {
  it('处理跨 chunk、非 JSON 行与通知', async () => {
    await start();
    const proc = hoisted.procs[0];
    respondWith({
      'tools/call': (_proc, req) => {
        const line = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { value: 42 } }) + '\n';
        queueMicrotask(() => {
          proc.stdout.emit('data', Buffer.from('startup log line\n'));
          proc.stdout.emit(
            'data',
            Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' }) + '\n'),
          );
          proc.stdout.emit('data', Buffer.from(line.slice(0, 8)));
          proc.stdout.emit('data', Buffer.from(line.slice(8)));
        });
      },
    });

    await expect(mcp.callTool('demo', 'echo', { a: 1 })).resolves.toEqual({
      success: true,
      result: { value: 42 },
    });
    expect(hoisted.send).toHaveBeenCalledWith('main:log', expect.objectContaining({ level: 'success' }));
  });

  it('工具调用返回 JSON-RPC 错误时失败', async () => {
    await start();
    respondWith({
      'tools/call': (proc, req) => {
        sendResponse(proc, req.id, { error: { code: -32000, message: 'tool exploded' } });
      },
    });
    await expect(mcp.callTool('demo', 'bad', {})).resolves.toEqual({
      success: false,
      error: 'MCP 错误 [-32000]: tool exploded',
    });
  });

  it('未知 id 与无 id 通知被忽略', async () => {
    await start();
    const proc = hoisted.procs[0];
    proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":999,"result":{}}\n'));
    proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"notifications/x"}\n'));
    proc.stdout.emit('data', Buffer.from('\n'));
    expect(mcp.getServerStatuses()).toEqual([{ name: 'demo', running: true, toolCount: 1 }]);
  });

  it('未分帧数据超过 10MB 时丢弃缓冲区并告警', async () => {
    await start();
    const proc = hoisted.procs[0];
    proc.stdout.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1, 0x78));
    expect(hoisted.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ level: 'error', message: expect.stringContaining('输出超过') }),
    );
    await expect(mcp.callTool('demo', 'echo', {})).resolves.toMatchObject({ success: true });
  });

  it('callTool 对未运行/未初始化服务器返回错误', async () => {
    await expect(mcp.callTool('missing', 't', {})).resolves.toEqual({
      success: false,
      error: 'MCP 服务器 missing 未运行',
    });

    hoisted.responder = () => {};
    const pending = start('pending');
    await expect(mcp.callTool('pending', 't', {})).resolves.toEqual({
      success: false,
      error: 'MCP 服务器 pending 未运行',
    });
    mcp.stopServer('pending');
    await expect(pending).resolves.toMatchObject({ success: false });
  });

  it('callTool 请求超时返回错误', async () => {
    await start();
    vi.useFakeTimers();
    hoisted.responder = () => {};
    const pending = mcp.callTool('demo', 'slow', {});
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain('MCP 请求超时: demo / tools/call');
  });

  it('stopServer 时挂起请求被拒绝', async () => {
    await start();
    hoisted.responder = () => {};
    const pending = mcp.callTool('demo', 'pending', {});
    mcp.stopServer('demo');
    await expect(pending).resolves.toEqual({ success: false, error: 'MCP 服务器已关闭' });
    expect(hoisted.procs[0].kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('mcp-manager: refreshTools', () => {
  it('服务器不存在或未初始化时返回空数组', async () => {
    await expect(mcp.refreshTools('missing')).resolves.toEqual([]);

    hoisted.responder = () => {};
    const pending = start('pending');
    await expect(mcp.refreshTools('pending')).resolves.toEqual([]);
    mcp.stopServer('pending');
    await pending;
  });

  it('按 nextCursor 分页收集工具', async () => {
    let page = 0;
    respondWith({
      'tools/list': (proc, req) => {
        page += 1;
        const result =
          page === 1
            ? { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'c1' }
            : page === 2
              ? { tools: [{ name: 'b', inputSchema: { type: 'object' } }], nextCursor: 'c2' }
              : { tools: [{ name: 'c', inputSchema: { type: 'object' } }] };
        sendResponse(proc, req.id, { result });
      },
    });

    await start();
    expect(mcp.getAllTools().map((t: any) => t.name)).toEqual(['a', 'b', 'c']);
    expect(mcp.getServerStatuses()).toEqual([{ name: 'demo', running: true, toolCount: 3 }]);
  });

  it('最多拉取 10 页，防止异常服务器死循环', async () => {
    let calls = 0;
    respondWith({
      'tools/list': (proc, req) => {
        calls += 1;
        sendResponse(proc, req.id, {
          result: { tools: [{ name: `t${calls}`, inputSchema: { type: 'object' } }], nextCursor: 'again' },
        });
      },
    });
    await start();
    expect(calls).toBe(10);
    expect(mcp.getAllTools()).toHaveLength(10);
  });

  it('tools/list 出错时返回空数组', async () => {
    respondWith({
      'tools/list': (proc, req) => {
        sendResponse(proc, req.id, { error: { code: -1, message: 'list failed' } });
      },
    });
    const result = await start();
    expect(result).toEqual({ success: true });
    expect(mcp.getAllTools()).toEqual([]);
    expect(mcp.getServerStatuses()).toEqual([{ name: 'demo', running: true, toolCount: 0 }]);
  });
});

describe('mcp-manager: lifecycle / queries', () => {
  it('stderr 输出转发日志，close 清理服务器', async () => {
    await start('closer');
    const proc = hoisted.procs[0];
    proc.stderr.emit('data', Buffer.from('  stderr message  '));
    expect(hoisted.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ message: '🔌 MCP [closer] stderr', detail: 'stderr message' }),
    );

    proc.emit('close', 0);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mcp.getServerStatuses()).toEqual([]);
  });

  it('error 事件清理服务器', async () => {
    await start('error-server');
    const proc = hoisted.procs[0];
    proc.emit('error', new Error('boom'));
    expect(proc.kill).toHaveBeenCalled();
    expect(mcp.getServerStatuses()).toEqual([]);
    expect(hoisted.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ message: '🔌 MCP 启动失败: error-server' }),
    );
  });

  it('stopAllServers 停止全部并清理挂起请求', async () => {
    await start('one');
    await start('two');
    const pending = mcp.callTool('one', 'slow', {});
    hoisted.responder = () => {};
    mcp.stopAllServers();
    expect(mcp.getServerStatuses()).toEqual([]);
    expect(hoisted.procs[0].kill).toHaveBeenCalled();
    expect(hoisted.procs[1].kill).toHaveBeenCalled();
    await expect(pending).resolves.toMatchObject({ success: false });
  });

  it('stopServer 对未知服务器安全返回', () => {
    expect(() => mcp.stopServer('nope')).not.toThrow();
  });

  it('getAllTools 跳过未初始化服务器，getServerStatuses 报告 running=false', async () => {
    hoisted.responder = () => {};
    const pending = start('pending');
    expect(mcp.getAllTools()).toEqual([]);
    expect(mcp.getServerStatuses()).toEqual([{ name: 'pending', running: false, toolCount: 0 }]);
    mcp.stopServer('pending');
    await pending;
  });
});
