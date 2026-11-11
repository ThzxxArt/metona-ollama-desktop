// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  executeTool: vi.fn(),
}));

vi.mock('../src/renderer/services/tool-registry.js', () => ({
  executeTool: hoisted.executeTool,
}));

import { state } from '../src/renderer/state/state.js';
import {
  SIDE_EFFECT_TOOLS,
  getAdjustedToolTimeout,
  executeToolWithTimeout,
  hasPathDependency,
  pathsConflict,
  validateToolArgsQuick,
  setToolCache,
  getToolCache,
  clearToolCache,
  deleteToolCache,
  isCacheValid,
  getToolCacheKey,
  isDuplicateCall,
} from '../src/renderer/services/agent/tool-planning.js';
import type { ToolCall } from '../src/renderer/types.js';

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { type: 'function', function: { name, arguments: args } };
}

beforeEach(() => {
  hoisted.executeTool.mockReset();
  clearToolCache();
  state.set('httpTimeout', 900_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getAdjustedToolTimeout', () => {
  it('按工具类型返回基础超时', () => {
    expect(getAdjustedToolTimeout('memory', {})).toBe(5_000);
    expect(getAdjustedToolTimeout('read_file', {})).toBe(60_000);
    expect(getAdjustedToolTimeout('unknown_tool', {})).toBe(60_000);
  });

  it('网络工具使用用户 httpTimeout，0 表示禁用超时', () => {
    state.set('httpTimeout', 120_000);
    expect(getAdjustedToolTimeout('web_search', {})).toBe(900_000);
    state.set('httpTimeout', 1_200_000);
    expect(getAdjustedToolTimeout('web_fetch', {})).toBe(1_200_000);
    state.set('httpTimeout', 0);
    expect(getAdjustedToolTimeout('download_file', {})).toBe(0);
  });

  it('run_command 按命令内容分级', () => {
    expect(getAdjustedToolTimeout('run_command', { command: 'npm install left-pad' })).toBe(300_000);
    expect(getAdjustedToolTimeout('run_command', { command: 'cargo build' })).toBe(180_000);
    expect(getAdjustedToolTimeout('run_command', { command: 'npm test' })).toBe(120_000);
    expect(getAdjustedToolTimeout('run_command', { command: 'ls -la' })).toBe(120_000);
    expect(getAdjustedToolTimeout('run_command', {})).toBe(60_000);
  });

  it('视频抓取与大文件写入使用特殊超时', () => {
    state.set('httpTimeout', 100_000);
    expect(getAdjustedToolTimeout('web_fetch', { url: 'https://youtube.com/watch?v=1' })).toBe(900_000);
    expect(getAdjustedToolTimeout('web_fetch', { url: 'https://example.com' })).toBe(900_000);
    expect(getAdjustedToolTimeout('write_file', { content: 'x'.repeat(100_001) })).toBe(30_000);
    expect(getAdjustedToolTimeout('write_file', { content: 'small' })).toBe(15_000);
  });
});

describe('executeToolWithTimeout', () => {
  it('正常返回工具结果', async () => {
    hoisted.executeTool.mockResolvedValue({ success: true, content: 'ok' });
    const result = await executeToolWithTimeout('read_file', { path: 'a.txt' });
    expect(result).toEqual({ success: true, content: 'ok' });
    expect(hoisted.executeTool).toHaveBeenCalledWith('read_file', { path: 'a.txt' });
  });

  it('工具抛错时转为失败结果', async () => {
    hoisted.executeTool.mockRejectedValue(new Error('boom'));
    const result = await executeToolWithTimeout('read_file', { path: 'a.txt' });
    expect(result).toEqual({ success: false, error: 'boom' });
  });

  it('超时返回超时错误并终止子进程', async () => {
    vi.useFakeTimers();
    const kill = vi.fn(async () => ({ success: true }));
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { workspace: { cmdKill: kill } };
    hoisted.executeTool.mockReturnValue(new Promise(() => {}));
    const pending = executeToolWithTimeout('run_command', { command: 'sleep 999' });
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain('执行超时');
    expect(kill).toHaveBeenCalled();
  });

  it('已中止的信号不执行工具', async () => {
    const kill = vi.fn(async () => ({ success: true }));
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { workspace: { cmdKill: kill } };
    const ac = new AbortController();
    ac.abort();
    const result = await executeToolWithTimeout('run_command', { command: 'ls' }, ac.signal);
    expect(result).toEqual({ success: false, error: '用户中止' });
    expect(hoisted.executeTool).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalled();
  });

  it('执行期间收到中止信号立即返回', async () => {
    const ac = new AbortController();
    hoisted.executeTool.mockReturnValue(new Promise(() => {}));
    const pending = executeToolWithTimeout('read_file', { path: 'a.txt' }, ac.signal);
    ac.abort();
    await expect(pending).resolves.toEqual({ success: false, error: '用户中止' });
  });

  it('timeout=0 时直接执行且不挂定时器', async () => {
    state.set('httpTimeout', 0);
    hoisted.executeTool.mockResolvedValue({ success: true });
    const result = await executeToolWithTimeout('web_search', { query: 'x' });
    expect(result.success).toBe(true);
  });
});

describe('hasPathDependency', () => {
  it('写-写同路径串行', () => {
    expect(
      hasPathDependency(call('write_file', { path: '/ws/a.txt' }), [call('write_file', { path: '/ws/a.txt' })]),
    ).toBe(true);
  });

  it('写-读同路径串行', () => {
    expect(
      hasPathDependency(call('read_file', { path: '/ws/a.txt' }), [call('write_file', { path: '/ws/a.txt' })]),
    ).toBe(true);
  });

  it('读-写同路径串行', () => {
    expect(
      hasPathDependency(call('write_file', { path: '/ws/a.txt' }), [call('read_file', { path: '/ws/a.txt' })]),
    ).toBe(true);
  });

  it('run_command 的 cwd 与写路径冲突时串行', () => {
    expect(
      hasPathDependency(call('run_command', { command: 'ls', cwd: '/ws/src' }), [
        call('write_file', { path: '/ws/src/index.ts' }),
      ]),
    ).toBe(true);
  });

  it('无关路径可并行', () => {
    expect(
      hasPathDependency(call('write_file', { path: '/ws/a.txt' }), [call('write_file', { path: '/other/b.txt' })]),
    ).toBe(false);
  });

  it('批量读取 paths 数组不参与路径依赖', () => {
    expect(
      hasPathDependency(call('read_file', { paths: ['/ws/a.txt'] }), [call('write_file', { path: '/ws/a.txt' })]),
    ).toBe(false);
  });

  it('delete_file 批量 paths 使用第一个路径', () => {
    expect(
      hasPathDependency(call('delete_file', { paths: ['/ws/a.txt'] }), [call('edit_file', { path: '/ws/a.txt' })]),
    ).toBe(true);
  });

  it('file_transfer/compress/download_file 的写入路径参与检测', () => {
    expect(
      hasPathDependency(call('file_transfer', { source: '/ws/a', destination: '/ws/b' }), [
        call('write_file', { path: '/ws/b' }),
      ]),
    ).toBe(true);
    expect(
      hasPathDependency(call('compress', { path: '/ws/a', destination: '/ws/out.zip' }), [
        call('write_file', { path: '/ws/out.zip' }),
      ]),
    ).toBe(true);
    expect(
      hasPathDependency(call('download_file', { destination: '/ws/f.bin' }), [
        call('write_file', { path: '/ws/f.bin' }),
      ]),
    ).toBe(true);
  });
});

describe('validateToolArgsQuick', () => {
  it('read_file 支持 path 或非空 paths', () => {
    expect(validateToolArgsQuick('read_file', {})).toContain('path');
    expect(validateToolArgsQuick('read_file', { path: '  ' })).toContain('path');
    expect(validateToolArgsQuick('read_file', { paths: [] })).toContain('path');
    expect(validateToolArgsQuick('read_file', { paths: ['a'] })).toBeNull();
  });

  it('write/delete/compress 需要 path', () => {
    for (const name of ['write_file', 'delete_file', 'compress']) {
      expect(validateToolArgsQuick(name, {})).toContain('path');
      expect(validateToolArgsQuick(name, { path: 'a' })).toBeNull();
    }
  });

  it('list_directory / search_files 参数校验', () => {
    expect(validateToolArgsQuick('list_directory', {})).toContain('path');
    expect(validateToolArgsQuick('search_files', {})).toContain('query');
    expect(validateToolArgsQuick('search_files', { query: 'x' })).toContain('path');
    expect(validateToolArgsQuick('search_files', { query: 'x', path: '.' })).toBeNull();
  });

  it('web_fetch / web_search / run_command 参数校验', () => {
    expect(validateToolArgsQuick('web_fetch', { url: 'ftp://x' })).toContain('url');
    expect(validateToolArgsQuick('web_fetch', { url: 'https://x' })).toBeNull();
    expect(validateToolArgsQuick('web_search', {})).toContain('query');
    expect(validateToolArgsQuick('run_command', {})).toContain('command');
  });

  it('browser / session / edit_file 参数校验', () => {
    expect(validateToolArgsQuick('browser', {})).toContain('action');
    expect(validateToolArgsQuick('browser', { action: 'open' })).toBeNull();
    expect(validateToolArgsQuick('session', { action: 'delete' })).toContain('action');
    expect(validateToolArgsQuick('session', { action: 'read' })).toContain('session_id');
    expect(validateToolArgsQuick('session', { action: 'list' })).toBeNull();
    expect(validateToolArgsQuick('edit_file', { path: 'a' })).toContain('old_text');
    expect(validateToolArgsQuick('edit_file', { path: 'a', old_text: 'x' })).toContain('new_text');
    expect(validateToolArgsQuick('edit_file', { path: 'a', old_text: 'x', new_text: '' })).toBeNull();
  });
});

describe('工具缓存', () => {
  it('set/get 命中并刷新 LRU 顺序', () => {
    setToolCache('a', { result: { success: true, n: 1 }, timestamp: 1 });
    setToolCache('b', { result: { success: true, n: 2 }, timestamp: 2 });
    expect(getToolCache('a')?.result.n).toBe(1);
    expect(getToolCache('missing')).toBeUndefined();
  });

  it('超过 100 条淘汰最旧条目', () => {
    for (let i = 0; i < 101; i++) {
      setToolCache(`k${i}`, { result: { success: true, i }, timestamp: i });
    }
    expect(getToolCache('k0')).toBeUndefined();
    expect(getToolCache('k100')).toBeDefined();
  });

  it('delete/clear 生效', () => {
    setToolCache('a', { result: { success: true }, timestamp: 1 });
    deleteToolCache('a');
    expect(getToolCache('a')).toBeUndefined();
    setToolCache('b', { result: { success: true }, timestamp: 1 });
    clearToolCache();
    expect(getToolCache('b')).toBeUndefined();
  });

  it('TTL 过期判定', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    expect(isCacheValid('read_file', 1_000_000)).toBe(true);
    expect(isCacheValid('read_file', 1_000_000 - 30 * 60_000 - 1)).toBe(false);
    expect(isCacheValid('unknown_tool', 1_000_000 - 59_000)).toBe(true);
    expect(isCacheValid('unknown_tool', 1_000_000 - 61_000)).toBe(false);
  });

  it('缓存键与参数键序无关', () => {
    expect(getToolCacheKey('read_file', { a: 1, b: 2 })).toBe(getToolCacheKey('read_file', { b: 2, a: 1 }));
  });

  it('重复调用检测基于稳定参数序列化', () => {
    const all = [call('read_file', { path: 'a' }), call('read_file', { path: 'a' })];
    expect(isDuplicateCall(all[1], all)).toBe(true);
    expect(isDuplicateCall(call('read_file', { path: 'b' }), all)).toBe(false);
  });

  it('副作用工具集合包含写操作', () => {
    expect(SIDE_EFFECT_TOOLS.has('write_file')).toBe(true);
    expect(SIDE_EFFECT_TOOLS.has('run_command')).toBe(true);
    expect(SIDE_EFFECT_TOOLS.has('read_file')).toBe(false);
  });
});

describe('pathsConflict 额外边界', () => {
  it('规范化反斜杠与尾部斜杠', () => {
    expect(pathsConflict('C:\\a\\b', 'C:/a/b')).toBe(true);
    expect(pathsConflict('/a/b/', '/a/b')).toBe(true);
  });

  it('前缀相同但不是路径段不冲突', () => {
    expect(pathsConflict('/a/bc', '/a/b')).toBe(false);
  });
});
