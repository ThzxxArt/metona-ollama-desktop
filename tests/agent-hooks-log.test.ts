// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('../src/renderer/components/toast.js', () => ({
  showToast: hoisted.showToast,
}));

import {
  registerHook,
  unregisterHook,
  setHookEnabled,
  getRegisteredHooks,
  getPhaseHooks,
  executeHooks,
  addWrittenFile,
  securityCheckHook,
  fileWriteDedupHook,
  initHarnessHooks,
} from '../src/renderer/services/hooks.js';
import { initGlobalErrorHandler } from '../src/renderer/services/infra-service.js';
import { state, KEYS } from '../src/renderer/state/state.js';
import type { HarnessHook, LoopContext, HookData } from '../src/renderer/types.js';

function makeCtx(): LoopContext {
  return {
    state: 'INIT',
    sessionId: 's1',
    loopCount: 0,
    maxLoops: 10,
    content: '',
    thinking: '',
    toolCalls: [],
    allToolRecords: [],
    messages: [],
    totalEvalCount: 0,
    totalPromptEvalCount: 0,
    totalInferenceNs: 0,
    loopEvalCount: 0,
    loopPromptEvalCount: 0,
    loopInferenceNs: 0,
    prevLoopSuccessKeys: [],
    prevToolCalls: [],
    startTime: Date.now(),
    emergencyCompressCount: 0,
    compressedThisCycle: false,
  };
}

function hook(
  name: string,
  phase: HarnessHook['phase'],
  priority: number,
  handler: HarnessHook['handler'],
  enabled = true,
): HarnessHook {
  return { name, phase, priority, enabled, handler };
}

afterEach(() => {
  for (const h of getRegisteredHooks()) unregisterHook(h.name);
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════
// Hooks
// ═══════════════════════════════════════════════════════════════

describe('hooks 注册与执行', () => {
  it('无 Hook 时默认全部通过', async () => {
    const r = await executeHooks('pre_tool', makeCtx());
    expect(r).toEqual({ results: [], allPassed: true });
  });

  it('按优先级降序执行并汇总结果', async () => {
    const order: string[] = [];
    registerHook(
      hook('low', 'pre_tool', 1, async () => {
        order.push('low');
        return { passed: true, message: '' };
      }),
    );
    registerHook(
      hook('high', 'pre_tool', 100, async () => {
        order.push('high');
        return { passed: false, message: 'blocked' };
      }),
    );
    registerHook(
      hook('mid', 'pre_tool', 50, async () => {
        order.push('mid');
        return { passed: true, message: '' };
      }),
    );
    const r = await executeHooks('pre_tool', makeCtx(), { toolName: 'read_file' });
    expect(order).toEqual(['high', 'mid', 'low']);
    expect(r.allPassed).toBe(false);
    expect(r.results.map((x) => x.message)).toEqual(['blocked', '', '']);
  });

  it('禁用的 Hook 不执行', async () => {
    const handler = vi.fn(async () => ({ passed: false, message: 'no' }));
    registerHook(hook('disabled', 'post_tool', 10, handler));
    setHookEnabled('disabled', false);
    const r = await executeHooks('post_tool', makeCtx());
    expect(handler).not.toHaveBeenCalled();
    expect(r.allPassed).toBe(true);
    expect(getPhaseHooks('post_tool')).toEqual([]);
  });

  it('Hook 抛错被捕获并视为通过', async () => {
    registerHook(
      hook('boom', 'post_iteration', 10, async () => {
        throw new Error('hook crash');
      }),
    );
    const r = await executeHooks('post_iteration', makeCtx());
    expect(r.allPassed).toBe(true);
    expect(r.results[0].passed).toBe(true);
    expect(r.results[0].message).toContain('hook crash');
  });

  it('重复注册同名 Hook 覆盖注册表但阶段索引保留旧条目', async () => {
    const first = hook('same', 'pre_completion', 1, async () => ({ passed: true, message: 'first' }));
    const second = hook('same', 'pre_completion', 2, async () => ({ passed: true, message: 'second' }));
    registerHook(first);
    registerHook(second);
    expect(getRegisteredHooks()).toHaveLength(1);
    const r = await executeHooks('pre_completion', makeCtx());
    // 阶段索引未去重，两个条目都会执行（历史行为）
    expect(r.results.map((x) => x.message)).toEqual(['second', 'first']);
  });

  it('unregister 移除 Hook，未知名称安全', () => {
    registerHook(hook('x', 'pre_tool', 1, async () => ({ passed: true, message: '' })));
    unregisterHook('x');
    expect(getRegisteredHooks()).toHaveLength(0);
    expect(() => unregisterHook('missing')).not.toThrow();
    expect(() => setHookEnabled('missing', false)).not.toThrow();
  });
});

describe('内置 Hook', () => {
  it('SecurityCheck 拦截危险命令与管道 shell', async () => {
    const ctx = makeCtx();
    for (const command of [
      'rm -rf /',
      'mkfs.ext4 /dev/sda',
      'dd if=/dev/zero of=/dev/sda',
      'shutdown -h now',
      ':(){ :|:& };:',
      'chmod 777 /tmp',
    ]) {
      const r = await securityCheckHook.handler(ctx, { toolName: 'run_command', toolArgs: { command } });
      expect(r.passed).toBe(false);
    }
    const pipe = await securityCheckHook.handler(ctx, {
      toolName: 'run_command',
      toolArgs: { command: 'echo hi | bash' },
    });
    expect(pipe.passed).toBe(false);
    expect(pipe.message).toContain('管道');
  });

  it('SecurityCheck 放行普通命令并拦截受保护删除路径', async () => {
    const ctx = makeCtx();
    expect(
      (await securityCheckHook.handler(ctx, { toolName: 'run_command', toolArgs: { command: 'ls -la' } })).passed,
    ).toBe(true);
    expect(
      (await securityCheckHook.handler(ctx, { toolName: 'delete_file', toolArgs: { path: '/etc/passwd' } })).passed,
    ).toBe(false);
    expect(
      (
        await securityCheckHook.handler(ctx, {
          toolName: 'delete_file',
          toolArgs: { paths: ['/tmp/a', 'C:\\Windows\\x'] },
        })
      ).passed,
    ).toBe(false);
    expect(
      (await securityCheckHook.handler(ctx, { toolName: 'delete_file', toolArgs: { path: '/workspace/a.txt' } }))
        .passed,
    ).toBe(true);
  });

  it('FileWriteDedup 只阻断内容完全相同的重复写入', async () => {
    const ctx = makeCtx();
    const data = (args: Record<string, unknown>): HookData => ({ toolName: 'write_file', toolArgs: args });
    expect((await fileWriteDedupHook.handler(ctx, data({ path: '/ws/a', content: 'one' }))).passed).toBe(true);
    addWrittenFile('/ws/a', 'one');
    const dup = await fileWriteDedupHook.handler(ctx, data({ path: '/ws/a', content: 'one' }));
    expect(dup.passed).toBe(false);
    expect(dup.message).toContain('内容未变化');
    expect((await fileWriteDedupHook.handler(ctx, data({ path: '/ws/a', content: 'two' }))).passed).toBe(true);
    expect((await fileWriteDedupHook.handler(ctx, data({ path: '', content: 'x' }))).passed).toBe(true);
    expect((await fileWriteDedupHook.handler(ctx, { toolName: 'read_file', toolArgs: { path: '/ws/a' } })).passed).toBe(
      true,
    );
  });

  it('initHarnessHooks 幂等注册两个内置 Hook', () => {
    initHarnessHooks();
    initHarnessHooks();
    const names = getRegisteredHooks()
      .map((h) => h.name)
      .sort();
    expect(names).toEqual(['FileWriteDedup', 'SecurityCheck']);
  });
});

// ═══════════════════════════════════════════════════════════════
// State store
// ═══════════════════════════════════════════════════════════════

describe('state 响应式存储', () => {
  beforeEach(() => {
    state.init({ testKey: undefined });
  });

  it('set 通知监听器，相同值不通知', () => {
    const cb = vi.fn();
    const off = state.on('k', cb);
    state.set('k', 1);
    state.set('k', 1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1, undefined);
    off();
    state.set('k', 2);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('get 支持默认值', () => {
    expect(state.get('missing', 'fallback')).toBe('fallback');
    state.set('k', 0);
    expect(state.get('k', 9)).toBe(0);
  });

  it('update 使用旧值计算', () => {
    state.set('n', 1);
    state.update('n', (old: number) => old + 1);
    expect(state.get('n')).toBe(2);
  });

  it('setIn 复制嵌套对象/数组并通知', () => {
    const old = { a: { b: 1 }, list: [{ x: 1 }] };
    state.set('obj', old);
    const cb = vi.fn();
    state.on('obj', cb);
    state.setIn('obj', ['a', 'b'], 2);
    expect((state.get('obj') as typeof old).a.b).toBe(2);
    expect(old.a.b).toBe(1);
    state.setIn('obj', ['list', 0, 'x'], 9);
    expect((state.get('obj') as typeof old).list[0].x).toBe(9);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('setIn 空路径等价 set，非对象根被忽略', () => {
    state.set('obj', 5);
    state.setIn('obj', ['a'], 1);
    expect(state.get('obj')).toBe(5);
    state.setIn('obj', [], 7);
    expect(state.get('obj')).toBe(7);
  });

  it('batch 合并通知且异常后仍刷新', () => {
    const cb = vi.fn();
    state.on('b1', cb);
    state.on('b2', cb);
    state.batch(() => {
      state.set('b1', 1);
      state.set('b1', 2);
      state.set('b2', 3);
    });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(() =>
      state.batch(() => {
        throw new Error('x');
      }),
    ).toThrow('x');
    state.set('b1', 4);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('监听器抛错不影响其他监听器', () => {
    const good = vi.fn();
    state.on('err', () => {
      throw new Error('bad listener');
    });
    state.on('err', good);
    state.set('err', 1);
    expect(good).toHaveBeenCalled();
  });

  it('update 触发通知', () => {
    const cb = vi.fn();
    state.set('u', 1);
    state.on('u', cb);
    state.update('u', (old: number) => old + 1);
    expect(cb).toHaveBeenCalledWith(2, 1);
  });

  it('setIn 自动创建嵌套对象与数组', () => {
    state.set('obj', {});
    state.setIn('obj', ['a', 'b'], 1);
    expect((state.get('obj') as Record<string, unknown>).a).toEqual({ b: 1 });
    state.setIn('obj', ['list', 0, 'x'], 2);
    expect((state.get('obj') as Record<string, any>).list[0]).toEqual({ x: 2 });
  });

  it('浅比较数组与对象', () => {
    const cb = vi.fn();
    state.set('arr', [1, 2]);
    state.on('arr', cb);
    state.set('arr', [1, 2]);
    expect(cb).not.toHaveBeenCalled();
    state.set('arr', [1, 3]);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Infra 全局错误处理
// ═══════════════════════════════════════════════════════════════

describe('infra-service 全局错误边界', () => {
  beforeEach(() => {
    hoisted.showToast.mockReset();
  });

  it('捕获 window error 并阻止默认行为', () => {
    initGlobalErrorHandler();
    const event = new ErrorEvent('error', { message: 'boom', filename: 'a.ts', lineno: 3, colno: 4, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(hoisted.showToast).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error', 5000);
  });

  it('捕获 unhandledrejection 的 Error 与字符串原因', () => {
    initGlobalErrorHandler();
    const errEvent = new Event('unhandledrejection', { cancelable: true }) as Event & { reason: unknown };
    errEvent.reason = new Error('async boom');
    window.dispatchEvent(errEvent);
    expect(errEvent.defaultPrevented).toBe(true);
    expect(hoisted.showToast).toHaveBeenCalledWith(expect.stringContaining('async boom'), 'error', 5000);

    const strEvent = new Event('unhandledrejection', { cancelable: true }) as Event & { reason: unknown };
    strEvent.reason = 'plain failure';
    window.dispatchEvent(strEvent);
    expect(hoisted.showToast).toHaveBeenCalledWith(expect.stringContaining('plain failure'), 'error', 5000);
  });
});

// ═══════════════════════════════════════════════════════════════
// Log service
// ═══════════════════════════════════════════════════════════════

async function loadLogService() {
  vi.resetModules();
  return import('../src/renderer/services/log-service.js');
}

describe('log-service', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="logPanel"><div id="logPanelBody"></div></div><button id="btnExportLog"></button>';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    delete (window as unknown as { metonaDesktop?: unknown }).metonaDesktop;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('init 前的日志进入 earlyBuffer，init 后渲染到 DOM', async () => {
    const log = await loadLogService();
    log.addLog('info', 'early message', 'detail');
    expect(log.getLogs()).toHaveLength(1);
    expect(document.querySelectorAll('.log-entry')).toHaveLength(0);
    log.initLogPanel();
    expect(document.querySelectorAll('.log-entry')).toHaveLength(1);
    expect(document.querySelector('.log-msg')?.textContent).toBe('early message');
    expect(document.querySelector('.log-detail')?.textContent).toBe('detail');
  });

  it('init 后日志通过 rAF 批量渲染并保留自定义图标/id', async () => {
    const log = await loadLogService();
    log.initLogPanel();
    log.addLog('warn', 'later', undefined, '⚡', 'custom-id');
    const el = document.getElementById('custom-id');
    expect(el).not.toBeNull();
    expect(el!.className).toContain('log-warn');
    expect(el!.textContent).toContain('⚡');
    expect(log.getLogs().at(-1)?.id).toBe('custom-id');
  });

  it('init 缺少 DOM 时不抛错', async () => {
    document.body.innerHTML = '';
    const log = await loadLogService();
    expect(() => log.initLogPanel()).not.toThrow();
    expect(() => log.addLog('info', 'buffered')).not.toThrow();
  });

  it('日志上限 2000 条', async () => {
    const log = await loadLogService();
    log.initLogPanel();
    for (let i = 0; i < 2005; i++) log.addLog('debug', `m${i}`);
    const logs = log.getLogs();
    expect(logs).toHaveLength(2000);
    expect(logs[0].message).toBe('m5');
  });

  it('便捷日志方法映射正确级别与图标', async () => {
    const log = await loadLogService();
    log.initLogPanel();
    log.logInfo('i');
    log.logSuccess('s');
    log.logWarn('w');
    log.logError('e');
    log.logDebug('d');
    log.logToolStart('read_file', '{"path":"a"}');
    log.logToolResult('read_file', true);
    log.logToolResult('read_file', false, 'err');
    log.logThink('x'.repeat(250));
    log.logStream('stream');
    log.logAgentLoop(1, 5);
    log.logModelResponse(10, 1);
    log.logConnection('connected', 'ok');
    log.logModel('qwen', 'loaded');
    log.logSession('new', 'id');
    log.logMemory('add', 'x');
    log.logRAG('search');
    log.logSetting('k', 'v');
    log.logInit('done');
    const logs = log.getLogs();
    expect(logs.map((l) => l.level)).toEqual([
      'info',
      'success',
      'warn',
      'error',
      'debug',
      'tool',
      'success',
      'error',
      'think',
      'stream',
      'info',
      'stream',
      'success',
      'info',
      'info',
      'debug',
      'info',
      'debug',
      'info',
    ]);
    expect(logs.find((l) => l.level === 'think')!.detail!.length).toBeGreaterThan(200);
  });

  it('未知级别、短思考与断连日志走回退分支', async () => {
    const log = await loadLogService();
    log.initLogPanel();
    log.addLog('unknown' as never, 'unknown level');
    log.logThink('short');
    log.logConnection('disconnected');
    expect(log.getLogs().at(-3)?.icon).toBe('•');
    expect(log.getLogs().at(-2)?.detail).toBe('short');
    expect(log.getLogs().at(-1)?.level).toBe('warn');
  });

  it('流式进度原地更新 logs 与 DOM', async () => {
    const log = await loadLogService();
    log.initLogPanel();
    log.logStreamProgress('before reset');
    log.resetStreamProgress();
    const id = log.getLogs().at(-1)!.id;
    log.logStreamProgress('50%');
    expect(log.getLogs().find((l) => l.id === id)!.message).toBe('50%');
    expect(document.getElementById(id)!.textContent).toContain('50%');
    document.querySelector(`#${id} .log-msg`)?.remove();
    log.logStreamProgress('no span');
    document.getElementById(id)?.remove();
    log.logStreamProgress('no element');
  });

  it('视频进度原地更新 detail', async () => {
    const log = await loadLogService();
    log.initLogPanel();
    log.updateVideoProgress(1);
    log.resetVideoProgress('demo.mp4');
    const id = log.getLogs().at(-1)!.id;
    log.updateVideoProgress(12);
    expect(log.getLogs().find((l) => l.id === id)!.detail).toBe('12 帧');
    expect(document.getElementById(id)!.textContent).toContain('12 帧');
    document.querySelector(`#${id} .log-detail`)?.remove();
    log.updateVideoProgress(13);
    document.getElementById(id)?.remove();
    log.updateVideoProgress(14);
  });

  it('桌面端导出日志调用保存对话框与文件写入', async () => {
    const saveFile = vi.fn(async () => '/tmp/log.txt');
    const writeFile = vi.fn(async () => ({ success: true }));
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { dialog: { saveFile }, fs: { writeFile } };
    const log = await loadLogService();
    log.initLogPanel();
    log.addLog('info', 'export me');
    document.getElementById('btnExportLog')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(saveFile).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith('/tmp/log.txt', expect.stringContaining('export me'), 'utf-8');
  });

  it('无桌面桥时浏览器下载导出', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:x') });
    const log = await loadLogService();
    log.initLogPanel();
    log.addLog('info', 'browser export');
    document.getElementById('btnExportLog')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('无日志时导出直接返回', async () => {
    const saveFile = vi.fn(async () => '/tmp/log.txt');
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = {
      dialog: { saveFile },
      fs: { writeFile: vi.fn() },
    };
    const log = await loadLogService();
    log.initLogPanel();
    document.getElementById('btnExportLog')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('滚动日志面板更新自动滚动状态', async () => {
    const log = await loadLogService();
    log.initLogPanel();
    const body = document.getElementById('logPanelBody')!;
    expect(() => body.dispatchEvent(new Event('scroll'))).not.toThrow();
    expect(log.getLogs()).toEqual([]);
  });

  it('保存对话框取消时不写文件', async () => {
    const saveFile = vi.fn(async () => null);
    const writeFile = vi.fn();
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { dialog: { saveFile }, fs: { writeFile } };
    const log = await loadLogService();
    log.initLogPanel();
    log.addLog('info', 'cancel');
    document.getElementById('btnExportLog')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(writeFile).not.toHaveBeenCalled();
  });
});
