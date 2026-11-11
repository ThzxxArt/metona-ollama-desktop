import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type AnyFn = (...args: any[]) => any;

const hoisted = vi.hoisted(() => {
  const listeners = new Map<string, Set<AnyFn>>();
  const api: { current: any } = { current: null };
  const invoke = vi.fn();
  const send = vi.fn();
  const sendSync = vi.fn();
  const removeAllListeners = vi.fn((channel: string) => {
    listeners.delete(channel);
  });
  const removeListener = vi.fn((channel: string, cb: AnyFn) => {
    listeners.get(channel)?.delete(cb);
  });
  const on = vi.fn((channel: string, cb: AnyFn) => {
    const set = listeners.get(channel) || new Set<AnyFn>();
    set.add(cb);
    listeners.set(channel, set);
  });
  const exposeInMainWorld = vi.fn((name: string, value: any) => {
    api.current = value;
    (globalThis as any)[name] = value;
  });
  return { listeners, api, invoke, send, sendSync, on, removeListener, removeAllListeners, exposeInMainWorld };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: hoisted.exposeInMainWorld },
  ipcRenderer: {
    invoke: hoisted.invoke,
    send: hoisted.send,
    sendSync: hoisted.sendSync,
    on: hoisted.on,
    removeListener: hoisted.removeListener,
    removeAllListeners: hoisted.removeAllListeners,
  },
}));

function emit(channel: string, ...args: any[]): void {
  for (const cb of [...(hoisted.listeners.get(channel) || [])]) cb({}, ...args);
}

let api: any;

async function loadPreload(sysInfo?: unknown, sysThrows = false): Promise<any> {
  vi.resetModules();
  hoisted.api.current = null;
  hoisted.listeners.clear();
  hoisted.sendSync.mockReset();
  if (sysThrows)
    hoisted.sendSync.mockImplementation(() => {
      throw new Error('sync failed');
    });
  else hoisted.sendSync.mockReturnValue(sysInfo);
  await import('../src/main/preload.js');
  return hoisted.api.current;
}

beforeEach(async () => {
  hoisted.invoke.mockReset();
  hoisted.invoke.mockResolvedValue(undefined);
  hoisted.send.mockReset();
  hoisted.on.mockClear();
  hoisted.removeListener.mockClear();
  hoisted.removeAllListeners.mockClear();
  hoisted.exposeInMainWorld.mockClear();
  api = await loadPreload({
    homeDir: '/home/u',
    tmpDir: '/tmp',
    shell: '/bin/bash',
    arch: 'x64',
    platform: 'linux',
    hostname: 'host',
    username: 'u',
  });
});

afterEach(() => {
  delete (globalThis as any).metonaDesktop;
});

describe('preload: 暴露面', () => {
  it('只暴露领域 API，不暴露 ipcRenderer / process / require', () => {
    expect(hoisted.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(hoisted.exposeInMainWorld).toHaveBeenCalledWith('metonaDesktop', expect.any(Object));
    expect(Object.keys(api).sort()).toEqual(
      [
        'checkUpdate',
        'db',
        'dialog',
        'fs',
        'info',
        'isDesktop',
        'mcp',
        'memoryAccess',
        'notify',
        'ollama',
        'onAppQuit',
        'onMainLog',
        'onMenuAction',
        'onTrayAction',
        'openExternal',
        'readAppResource',
        'removeAllListeners',
        'sys',
        'tool',
        'video',
        'window',
        'workspace',
      ].sort(),
    );
    expect(api.isDesktop).toBe(true);
    expect(api.ipcRenderer).toBeUndefined();
    expect(api.require).toBeUndefined();
    expect(api.process).toBeUndefined();
  });

  it('readSysInfo 成功时补全缺失字段', async () => {
    const loaded = await loadPreload({ homeDir: '/h', platform: 'win32' });
    expect(loaded.sys).toEqual({
      homeDir: '/h',
      tmpDir: '',
      shell: '',
      arch: '',
      platform: 'win32',
      hostname: '',
      username: '',
    });
  });

  it('readSysInfo 返回非对象或抛错时使用空值', async () => {
    const loaded = await loadPreload('not-an-object');
    expect(loaded.sys).toEqual({
      homeDir: '',
      tmpDir: '',
      shell: '',
      arch: '',
      platform: '',
      hostname: '',
      username: '',
    });

    const thrown = await loadPreload(undefined, true);
    expect(thrown.sys).toEqual({
      homeDir: '',
      tmpDir: '',
      shell: '',
      arch: '',
      platform: '',
      hostname: '',
      username: '',
    });
  });
});

async function expectChannel(call: () => Promise<unknown>, channel: string, ...args: unknown[]): Promise<void> {
  hoisted.invoke.mockClear();
  hoisted.invoke.mockResolvedValueOnce('result');
  await expect(call()).resolves.toBe('result');
  expect(hoisted.invoke).toHaveBeenCalledWith(channel, ...args);
}

describe('preload: 顶层与领域 invoke 通道', () => {
  it('app / dialog / fs / tool / window / notify / openExternal', async () => {
    await expectChannel(() => api.info(), 'app:info');
    await expectChannel(() => api.checkUpdate(), 'app:checkUpdate');
    await expectChannel(() => api.readAppResource('SOUL.md'), 'app:readResource', 'SOUL.md');

    const openOptions = { filters: [{ name: 'x', extensions: ['txt'] }] };
    await expectChannel(() => api.dialog.openFile(openOptions), 'dialog:openFile', openOptions);
    await expectChannel(() => api.dialog.saveFile({ defaultPath: 'a.txt' }), 'dialog:saveFile', {
      defaultPath: 'a.txt',
    });
    await expectChannel(() => api.dialog.openDirectory(), 'dialog:openDirectory');

    await expectChannel(() => api.fs.readFile('/a.txt'), 'fs:readFile', '/a.txt');
    await expectChannel(() => api.fs.readFileBase64('/a.bin'), 'fs:readFileBase64', '/a.bin');
    await expectChannel(() => api.fs.writeFile('/a.txt', 'x', 'utf-8'), 'fs:writeFile', '/a.txt', 'x', 'utf-8');

    await expectChannel(() => api.tool.execute('run_command', { command: 'ls' }), 'tool:execute', 'run_command', {
      command: 'ls',
    });
    await expectChannel(() => api.tool.getConfig(), 'tool:getConfig');
    await expectChannel(() => api.tool.setAllowedDirs(['/a']), 'tool:setAllowedDirs', ['/a']);
    await expectChannel(() => api.tool.setTimeouts({ http: 1, mcp: 2 }), 'tool:setTimeouts', { http: 1, mcp: 2 });

    await expectChannel(() => api.notify('title', 'body'), 'notify', 'title', 'body');
    await expectChannel(() => api.window.minimize(), 'window:minimize');
    await expectChannel(() => api.window.maximize(), 'window:maximize');
    await expectChannel(() => api.window.close(), 'window:close');
    await expectChannel(() => api.openExternal('https://example.com'), 'shell:openExternal', 'https://example.com');
  });

  it('ollama 全部 invoke 通道', async () => {
    const body = { model: 'm', messages: [] };
    const patch = { baseUrl: 'http://127.0.0.1:11434' };
    await expectChannel(() => api.ollama.getConfig(), 'ollama:config:get');
    await expectChannel(() => api.ollama.setConfig(patch), 'ollama:config:set', patch);
    await expectChannel(() => api.ollama.setApiKey('key'), 'ollama:key:set', 'key');
    await expectChannel(() => api.ollama.setApiKey('key', 'openai'), 'ollama:key:set', 'key', 'openai');
    await expectChannel(() => api.ollama.clearApiKey(), 'ollama:key:clear');
    await expectChannel(() => api.ollama.clearApiKey('anthropic'), 'ollama:key:clear', 'anthropic');
    await expectChannel(() => api.ollama.test(), 'ollama:test');
    await expectChannel(() => api.ollama.models(), 'ollama:models');
    await expectChannel(() => api.ollama.show('m'), 'ollama:show', 'm');
    await expectChannel(() => api.ollama.ps(), 'ollama:ps');
    await expectChannel(() => api.ollama.chat(body), 'ollama:chat', body);
    await expectChannel(() => api.ollama.embed('m', 'input'), 'ollama:embed', { model: 'm', input: 'input' });
    await expectChannel(() => api.ollama.unload({ manual: true }), 'ollama:unload', { manual: true });
  });

  it('db 全部 invoke 通道', async () => {
    const session = { id: 's' };
    const msg = { id: 'm' };
    const entries = [{ key: 'k', value: 'v' }];
    await expectChannel(() => api.db.saveSession(session), 'db:saveSession', session);
    await expectChannel(() => api.db.getSession('s'), 'db:getSession', 's');
    await expectChannel(() => api.db.getAllSessions(), 'db:getAllSessions');
    await expectChannel(() => api.db.getSessionSummaries(), 'db:getSessionSummaries');
    await expectChannel(() => api.db.searchSessions('q'), 'db:searchSessions', 'q');
    await expectChannel(() => api.db.getAllSessionsData(), 'db:getAllSessionsData');
    await expectChannel(() => api.db.deleteSession('s'), 'db:deleteSession', 's');
    await expectChannel(() => api.db.clearAllSessions(), 'db:clearAllSessions');
    await expectChannel(() => api.db.saveMessage(msg), 'db:saveMessage', msg);
    await expectChannel(() => api.db.saveMessagesBatch([msg]), 'db:saveMessagesBatch', [msg]);
    await expectChannel(() => api.db.getMessages('s'), 'db:getMessages', 's');
    await expectChannel(() => api.db.getMessageIds('s'), 'db:getMessageIds', 's');
    await expectChannel(() => api.db.deleteMessages('s', ['m']), 'db:deleteMessages', 's', ['m']);
    await expectChannel(() => api.db.saveSetting('k', 'v'), 'db:saveSetting', 'k', 'v');
    await expectChannel(() => api.db.saveSettingsBatch(entries), 'db:saveSettingsBatch', entries);
    await expectChannel(() => api.db.getSetting('k', 'def'), 'db:getSetting', 'k', 'def');
    await expectChannel(() => api.db.saveTrace({ id: 't' }), 'db:saveTrace', { id: 't' });
    await expectChannel(() => api.db.saveTracesBatch([{ id: 't' }]), 'db:saveTracesBatch', [{ id: 't' }]);
    await expectChannel(() => api.db.getTraces('s'), 'db:getTraces', 's');
    await expectChannel(() => api.db.exportSessions(), 'db:exportSessions');
    await expectChannel(() => api.db.importSessions({ sessions: [] }), 'db:importSessions', { sessions: [] });
    await expectChannel(() => api.db.getAllTokenStats(), 'db:getAllTokenStats');
    await expectChannel(() => api.db.saveToolAudit({ id: 'a' }), 'db:saveToolAudit', { id: 'a' });
    await expectChannel(() => api.db.getToolAudits('s'), 'db:getToolAudits', 's');
    await expectChannel(() => api.db.getAllToolAudits(5), 'db:getAllToolAudits', 5);
    await expectChannel(() => api.db.getMemoryEmbeddings('m'), 'db:getMemoryEmbeddings', 'm');
    await expectChannel(
      () => api.db.saveMemoryEmbedding('e', 'm', [0.1, 0.2]),
      'db:saveMemoryEmbedding',
      'e',
      'm',
      [0.1, 0.2],
    );
    await expectChannel(() => api.db.clearMemoryEmbeddings(), 'db:clearMemoryEmbeddings');
  });

  it('workspace / mcp / video / memory invoke 与 send 通道', async () => {
    await expectChannel(() => api.workspace.getDir(), 'workspace:getDir');
    await expectChannel(() => api.workspace.setDir('/ws'), 'workspace:setDir', '/ws');
    await expectChannel(() => api.workspace.listDir('/ws'), 'workspace:listDir', '/ws');
    await expectChannel(() => api.workspace.readFile('/ws/a'), 'workspace:readFile', '/ws/a');
    await expectChannel(() => api.workspace.cmdKill(), 'cmd:kill');

    hoisted.invoke.mockClear();
    hoisted.invoke.mockResolvedValueOnce('exec-result');
    await expect(api.workspace.execTool('ls', '/ws')).resolves.toBe('exec-result');
    expect(hoisted.invoke).toHaveBeenCalledWith('tool:execute', 'run_command', { command: 'ls', cwd: '/ws' });

    api.workspace.exec({ id: 'p1', command: 'ls' });
    expect(hoisted.send).toHaveBeenCalledWith('workspace:exec', { id: 'p1', command: 'ls' });
    api.workspace.kill('p1');
    expect(hoisted.send).toHaveBeenCalledWith('workspace:kill', 'p1');

    const mcpConfig = { name: 's', command: 'npx', args: ['x'], enabled: true };
    await expectChannel(() => api.mcp.startServer(mcpConfig), 'mcp:startServer', mcpConfig);
    await expectChannel(() => api.mcp.stopServer('s'), 'mcp:stopServer', 's');
    await expectChannel(() => api.mcp.stopAll(), 'mcp:stopAll');
    await expectChannel(() => api.mcp.callTool('s', 't', { a: 1 }), 'mcp:callTool', 's', 't', { a: 1 });
    await expectChannel(() => api.mcp.getTools(), 'mcp:getTools');
    await expectChannel(() => api.mcp.getStatuses(), 'mcp:getStatuses');
    await expectChannel(() => api.mcp.refreshTools('s'), 'mcp:refreshTools', 's');

    await expectChannel(() => api.video.extractFrames('/v.mp4', { maxFrames: 3 }), 'video:extractFrames', '/v.mp4', {
      maxFrames: 3,
    });
    api.video.removeProgressListener();
    expect(hoisted.removeAllListeners).toHaveBeenCalledWith('video:progress');

    await expectChannel(() => api.memoryAccess.read(), 'memory:read');
    await expectChannel(() => api.memoryAccess.write('content', 'reason'), 'memory:write', 'content', 'reason');
    await expectChannel(() => api.memoryAccess.init(), 'memory:init');
  });
});

describe('preload: 事件桥', () => {
  it('menu / tray / app-quit / main-log / workspace / cmd / video 事件转发', () => {
    const menu = vi.fn();
    const tray = vi.fn();
    const quit = vi.fn();
    const log = vi.fn();
    const output = vi.fn();
    const exit = vi.fn();
    const cmdOutput = vi.fn();
    const cmdDone = vi.fn();
    const progress = vi.fn();

    api.onMenuAction(menu);
    api.onTrayAction(tray);
    api.onAppQuit(quit);
    api.onMainLog(log);
    api.workspace.onOutput(output);
    api.workspace.onExit(exit);
    api.workspace.onCmdOutput(cmdOutput);
    api.workspace.onCmdDone(cmdDone);
    api.video.onProgress(progress);

    emit('menu-action', 'new-chat');
    emit('tray-action', 'new-chat');
    emit('app-quit');
    emit('main:log', { level: 'info', message: 'm' });
    emit('workspace:output', { id: 'p', type: 'stdout', data: 'x' });
    emit('workspace:exit', { id: 'p', code: 0 });
    emit('cmd:output', { command: 'ls', type: 'stdout', data: 'x' });
    emit('cmd:done', { command: 'ls', exitCode: 0 });
    emit('video:progress', { current: 2 });

    expect(menu).toHaveBeenCalledWith('new-chat');
    expect(tray).toHaveBeenCalledWith('new-chat');
    expect(quit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ level: 'info', message: 'm' });
    expect(output).toHaveBeenCalledWith({ id: 'p', type: 'stdout', data: 'x' });
    expect(exit).toHaveBeenCalledWith({ id: 'p', code: 0 });
    expect(cmdOutput).toHaveBeenCalledWith({ command: 'ls', type: 'stdout', data: 'x' });
    expect(cmdDone).toHaveBeenCalledWith({ command: 'ls', exitCode: 0 });
    expect(progress).toHaveBeenCalledWith({ current: 2 });
  });

  it('removeAllListeners 透传通道', () => {
    api.removeAllListeners('some-channel');
    expect(hoisted.removeAllListeners).toHaveBeenCalledWith('some-channel');
  });

  it('onStreamChunk / onStreamDone 注册并返回取消函数', () => {
    const chunkCb = vi.fn();
    const doneCb = vi.fn();
    const offChunk = api.ollama.onStreamChunk(chunkCb);
    const offDone = api.ollama.onStreamDone(doneCb);

    emit('ollama:chat:chunk', { streamId: 's1', chunk: { message: { content: 'a' } } });
    emit('ollama:chat:done', { streamId: 's1', error: { kind: 'aborted', message: 'x' } });
    expect(chunkCb).toHaveBeenCalledWith({ streamId: 's1', chunk: { message: { content: 'a' } } });
    expect(doneCb).toHaveBeenCalledWith({ streamId: 's1', error: { kind: 'aborted', message: 'x' } });

    offChunk();
    offDone();
    expect(hoisted.removeListener).toHaveBeenCalledWith('ollama:chat:chunk', expect.any(Function));
    expect(hoisted.removeListener).toHaveBeenCalledWith('ollama:chat:done', expect.any(Function));

    chunkCb.mockClear();
    doneCb.mockClear();
    emit('ollama:chat:chunk', { streamId: 's1', chunk: {} });
    emit('ollama:chat:done', { streamId: 's1' });
    expect(chunkCb).not.toHaveBeenCalled();
    expect(doneCb).not.toHaveBeenCalled();
  });
});

describe('preload: ollama.chat requestId 语义', () => {
  const body = { model: 'm', messages: [] };

  it('无 requestId 时直接 invoke', async () => {
    hoisted.invoke.mockResolvedValueOnce('chat-result');
    await expect(api.ollama.chat(body)).resolves.toBe('chat-result');
    expect(hoisted.invoke).toHaveBeenCalledWith('ollama:chat', body);
  });

  it('有 requestId 时透传，供 abortRequest 取消', async () => {
    hoisted.invoke.mockResolvedValueOnce('chat-result');
    await expect(api.ollama.chat(body, 'req-1')).resolves.toBe('chat-result');
    expect(hoisted.invoke).toHaveBeenCalledWith('ollama:chat', body, 'req-1');

    hoisted.invoke.mockResolvedValueOnce({ success: true });
    await expect(api.ollama.abortRequest('req-1')).resolves.toEqual({ success: true });
    expect(hoisted.invoke).toHaveBeenCalledWith('ollama:chat:abortRequest', 'req-1');
  });
});

describe('preload: ollama.chatStream 流语义', () => {
  const body = { model: 'm', messages: [] };

  function startStream(onChunk: AnyFn, requestId?: string) {
    const promise = api.ollama.chatStream(body, onChunk, requestId);
    const startCall = hoisted.invoke.mock.calls.find((c: any[]) => c[0] === 'ollama:chat:start');
    if (!startCall) throw new Error('chat:start not invoked');
    const streamId = startCall[2] as string;
    return { promise, streamId };
  }

  it('chunk 与 done 正常完成，忽略其它 streamId', async () => {
    const onChunk = vi.fn();
    hoisted.invoke.mockResolvedValue(undefined);
    const { promise, streamId } = startStream(onChunk, 'stream-1');

    emit('ollama:chat:chunk', { streamId: 'other', chunk: { message: { content: 'x' } } });
    emit('ollama:chat:done', { streamId: 'other' });
    expect(onChunk).not.toHaveBeenCalled();

    emit('ollama:chat:chunk', { streamId, chunk: { message: { content: 'a' } } });
    expect(onChunk).toHaveBeenCalledWith({ message: { content: 'a' } });
    emit('ollama:chat:done', { streamId });
    await expect(promise).resolves.toBeUndefined();

    expect(hoisted.removeListener).toHaveBeenCalledWith('ollama:chat:chunk', expect.any(Function));
    expect(hoisted.removeListener).toHaveBeenCalledWith('ollama:chat:done', expect.any(Function));
  });

  it('done 带非 aborted 错误时拒绝', async () => {
    hoisted.invoke.mockResolvedValue(undefined);
    const { promise, streamId } = startStream(vi.fn(), 'stream-err');
    emit('ollama:chat:done', { streamId, error: { kind: 'network', message: '连接失败' } });
    await expect(promise).rejects.toThrow('连接失败');
    expect(hoisted.invoke).toHaveBeenCalledWith('ollama:chat:abort', streamId);
  });

  it('done 带 aborted 错误时正常完成', async () => {
    hoisted.invoke.mockResolvedValue(undefined);
    const { promise, streamId } = startStream(vi.fn(), 'stream-aborted');
    emit('ollama:chat:done', { streamId, error: { kind: 'aborted', message: '取消' } });
    await expect(promise).resolves.toBeUndefined();
  });

  it('回调抛错时 abort 主进程流并拒绝', async () => {
    hoisted.invoke.mockResolvedValue(undefined);
    const onChunk = vi.fn(() => {
      throw new Error('callback boom');
    });
    const { promise, streamId } = startStream(onChunk, 'stream-cb');
    emit('ollama:chat:chunk', { streamId, chunk: { message: { content: 'a' } } });
    await expect(promise).rejects.toThrow('callback boom');
    expect(hoisted.invoke).toHaveBeenCalledWith('ollama:chat:abort', streamId);
  });

  it('start invoke 失败时拒绝并清理监听', async () => {
    hoisted.invoke.mockRejectedValueOnce(new Error('start failed'));
    const { promise } = startStream(vi.fn(), 'stream-fail');
    await expect(promise).rejects.toThrow('start failed');
    expect(hoisted.listeners.get('ollama:chat:chunk')?.size ?? 0).toBe(0);
    expect(hoisted.listeners.get('ollama:chat:done')?.size ?? 0).toBe(0);
  });

  it('abortStream 透传主进程 abort 通道', async () => {
    hoisted.invoke.mockResolvedValueOnce({ success: true });
    await expect(api.ollama.abortStream('stream-1')).resolves.toEqual({ success: true });
    expect(hoisted.invoke).toHaveBeenCalledWith('ollama:chat:abort', 'stream-1');
  });

  it('重复 done 只 finish 一次', async () => {
    hoisted.invoke.mockResolvedValue(undefined);
    const { promise, streamId } = startStream(vi.fn(), 'stream-dup');
    emit('ollama:chat:done', { streamId });
    emit('ollama:chat:done', { streamId });
    emit('ollama:chat:done', { streamId });
    await expect(promise).resolves.toBeUndefined();
    const removeCalls = hoisted.removeListener.mock.calls.filter((c: any[]) => c[0] === 'ollama:chat:done');
    expect(removeCalls).toHaveLength(1);
  });
});
