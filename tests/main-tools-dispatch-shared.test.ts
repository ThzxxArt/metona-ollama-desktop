import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

const h = vi.hoisted(() => {
  const ok = (tag: string) => vi.fn(async () => ({ success: true, tag }));
  return {
    window: { webContents: { send: vi.fn() } } as { webContents: { send: ReturnType<typeof vi.fn> } } | null,
    readFile: ok('readFile'),
    readMultiple: ok('readMultiple'),
    writeFile: ok('writeFile'),
    listDir: ok('listDir'),
    tree: ok('tree'),
    searchFiles: ok('searchFiles'),
    editFile: ok('editFile'),
    deleteFile: ok('deleteFile'),
    downloadFile: ok('downloadFile'),
    compress: ok('compress'),
    diff: ok('diff'),
    webFetch: ok('webFetch'),
    webSearch: ok('webSearch'),
    git: ok('git'),
    moveFile: ok('moveFile'),
    copyFile: ok('copyFile'),
    browserOpen: ok('browserOpen'),
    browserScreenshot: ok('browserScreenshot'),
    browserEvaluate: ok('browserEvaluate'),
    browserExtract: ok('browserExtract'),
    browserClick: ok('browserClick'),
    browserType: ok('browserType'),
    browserScroll: ok('browserScroll'),
    browserWait: ok('browserWait'),
    browserClose: vi.fn(async () => ({ success: true, tag: 'browserClose' })),
  };
});

vi.mock('../src/main/tool-handlers.js', () => ({
  handleReadFile: h.readFile,
  handleReadMultipleFiles: h.readMultiple,
  handleWriteFile: h.writeFile,
  handleListDir: h.listDir,
  handleTree: h.tree,
  handleSearchFiles: h.searchFiles,
  handleEditFile: h.editFile,
  handleDeleteFile: h.deleteFile,
  handleDownloadFile: h.downloadFile,
  handleCompress: h.compress,
  handleDiff: h.diff,
  handleWebFetch: h.webFetch,
  handleWebSearch: h.webSearch,
  handleGit: h.git,
  handleMoveFile: h.moveFile,
  handleCopyFile: h.copyFile,
}));
vi.mock('../src/main/browser.js', () => ({
  browserOpen: h.browserOpen,
  browserScreenshot: h.browserScreenshot,
  browserEvaluate: h.browserEvaluate,
  browserExtract: h.browserExtract,
  browserClick: h.browserClick,
  browserType: h.browserType,
  browserScroll: h.browserScroll,
  browserWait: h.browserWait,
  browserClose: h.browserClose,
}));
vi.mock('../src/main/window-state.js', () => ({
  get mainWindow() {
    return h.window;
  },
}));
vi.mock('../src/main/workspace.js', () => ({ getWorkspaceDir: () => '/ws' }));

import { MAIN_TOOL_HANDLERS, getToolHandler, isKnownTool } from '../src/main/tool-dispatch.js';
import { sendLog, isUrl, resolvePath } from '../src/main/tool-handlers-shared.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.window = { webContents: { send: vi.fn() } };
});

describe('tool-handlers-shared', () => {
  it('sendLog 推送到主窗口', () => {
    sendLog('warn', '消息', '细节');
    expect(h.window!.webContents.send).toHaveBeenCalledWith('main:log', {
      level: 'warn',
      message: '消息',
      detail: '细节',
    });
  });

  it('主窗口不存在时 sendLog 不抛异常', () => {
    h.window = null;
    expect(() => sendLog('info', 'no window')).not.toThrow();
  });

  it('isUrl 只识别 http/https 且长度足够', () => {
    expect(isUrl('http://example.com')).toBe(true);
    expect(isUrl('HTTPS://EXAMPLE.COM/X')).toBe(true);
    expect(isUrl('  https://x.test  ')).toBe(true);
    expect(isUrl('ftp://example.com')).toBe(false);
    expect(isUrl('http://')).toBe(false);
    expect(isUrl(123 as never)).toBe(false);
    expect(isUrl('file:///etc/passwd')).toBe(false);
  });

  it('resolvePath 相对路径基于工作空间，绝对路径保持', () => {
    expect(resolvePath('a/b.txt')).toBe(path.resolve('/ws', 'a/b.txt'));
    const abs = path.resolve('/tmp/abs.txt');
    expect(resolvePath(abs)).toBe(abs);
  });
});

describe('tool-dispatch 注册表', () => {
  it('注册 14 个可分发工具，run_command 特殊识别', () => {
    expect(Object.keys(MAIN_TOOL_HANDLERS)).toHaveLength(14);
    expect(isKnownTool('run_command')).toBe(true);
    expect(isKnownTool('read_file')).toBe(true);
    expect(isKnownTool('not_a_tool')).toBe(false);
    expect(getToolHandler('read_file')).toBe(MAIN_TOOL_HANDLERS.read_file);
    expect(getToolHandler('unknown')).toBeUndefined();
  });

  it('read_file 单文件与批量分发', async () => {
    await MAIN_TOOL_HANDLERS.read_file({ path: '/a.txt' });
    expect(h.readFile).toHaveBeenCalledWith({ path: '/a.txt' });

    await MAIN_TOOL_HANDLERS.read_file({ paths: ['/a', '/b'], max_chars_per_file: 100 });
    expect(h.readMultiple).toHaveBeenCalledWith({ paths: ['/a', '/b'], max_chars_per_file: 100 });

    await MAIN_TOOL_HANDLERS.read_file({ paths: [] });
    expect(h.readFile).toHaveBeenCalledTimes(2);
  });

  it('write_file / search_files / edit_file / delete_file 分发', async () => {
    await MAIN_TOOL_HANDLERS.write_file({ path: '/a', content: 'x', mode: 'append' });
    expect(h.writeFile).toHaveBeenCalledWith({ path: '/a', content: 'x', mode: 'append' });

    await MAIN_TOOL_HANDLERS.search_files({ path: '/', query: 'q', use_regex: true });
    expect(h.searchFiles).toHaveBeenCalledWith({ path: '/', query: 'q', use_regex: true });

    await MAIN_TOOL_HANDLERS.edit_file({ path: '/a', old_text: 'a', new_text: 'b', all: true });
    expect(h.editFile).toHaveBeenCalledWith({ path: '/a', old_text: 'a', new_text: 'b', all: true });

    await MAIN_TOOL_HANDLERS.delete_file({ paths: ['/a'], recursive: true });
    expect(h.deleteFile).toHaveBeenCalledWith({ paths: ['/a'], recursive: true });
  });

  it('list_directory 的 tree 与 list 两种格式', async () => {
    await MAIN_TOOL_HANDLERS.list_directory({ path: '/d', format: 'tree', max_depth: 2, include_hidden: true });
    expect(h.tree).toHaveBeenCalledWith({ path: '/d', max_depth: 2, include_hidden: true });

    await MAIN_TOOL_HANDLERS.list_directory({ path: '/d', recursive: true, offset: 3 });
    expect(h.listDir).toHaveBeenCalledWith({ path: '/d', recursive: true, offset: 3 });
  });

  it('file_transfer copy/move/非法 operation', async () => {
    await MAIN_TOOL_HANDLERS.file_transfer({ operation: 'move', source: '/a', destination: '/b' });
    expect(h.moveFile).toHaveBeenCalledWith({ source: '/a', destination: '/b' });

    await MAIN_TOOL_HANDLERS.file_transfer({
      operation: 'copy',
      source: '/a',
      destination: '/b',
      recursive: false,
    });
    expect(h.copyFile).toHaveBeenCalledWith({ source: '/a', destination: '/b', recursive: false });

    const bad = await MAIN_TOOL_HANDLERS.file_transfer({ operation: 'rename' });
    expect(bad).toEqual({ success: false, error: 'operation 必须为 copy 或 move' });
  });

  it('download_file / compress / diff / web / git 分发', async () => {
    await MAIN_TOOL_HANDLERS.download_file({ url: 'https://x', destination: '/a' });
    expect(h.downloadFile).toHaveBeenCalledWith({ url: 'https://x', destination: '/a' });

    await MAIN_TOOL_HANDLERS.compress({ action: 'create', path: '/a' });
    expect(h.compress).toHaveBeenCalledWith({ action: 'create', path: '/a' });

    await MAIN_TOOL_HANDLERS.diff({ mode: 'file_vs_content', path1: '/a', content: 'x' });
    expect(h.diff).toHaveBeenCalledWith({ mode: 'file_vs_content', path1: '/a', content: 'x' });

    await MAIN_TOOL_HANDLERS.web_fetch({ url: 'https://x', retry: false });
    expect(h.webFetch).toHaveBeenCalledWith({ url: 'https://x', retry: false });

    await MAIN_TOOL_HANDLERS.web_search({ query: 'q', max_results: 3 });
    expect(h.webSearch).toHaveBeenCalledWith({ query: 'q', max_results: 3 });

    await MAIN_TOOL_HANDLERS.git({ action: 'status', path: '/repo' });
    expect(h.git).toHaveBeenCalledWith({ action: 'status', path: '/repo' });
  });
});

describe('browser action 分发', () => {
  it('open / screenshot / evaluate / extract', async () => {
    await MAIN_TOOL_HANDLERS.browser({ action: 'open', url: 'https://x', wait_selector: '#app' });
    expect(h.browserOpen).toHaveBeenCalledWith('https://x', '#app');

    await MAIN_TOOL_HANDLERS.browser({ action: 'screenshot', full_page: true, selector: '#main' });
    expect(h.browserScreenshot).toHaveBeenCalledWith({ full_page: true, selector: '#main' });

    await MAIN_TOOL_HANDLERS.browser({ action: 'evaluate', js: '1+1' });
    expect(h.browserEvaluate).toHaveBeenCalledWith('1+1');

    await MAIN_TOOL_HANDLERS.browser({ action: 'extract', selector: 'body', max_chars: 100 });
    expect(h.browserExtract).toHaveBeenCalledWith({ selector: 'body', max_chars: 100 });
  });

  it('click / type / scroll / wait / close', async () => {
    await MAIN_TOOL_HANDLERS.browser({ action: 'click', selector: '#btn' });
    expect(h.browserClick).toHaveBeenCalledWith('#btn', false);

    await MAIN_TOOL_HANDLERS.browser({ action: 'click', selector: '#btn', wait: true });
    expect(h.browserClick).toHaveBeenCalledWith('#btn', true);

    await MAIN_TOOL_HANDLERS.browser({ action: 'type', selector: '#input', text: 'hi' });
    expect(h.browserType).toHaveBeenCalledWith('#input', 'hi', true, false);

    await MAIN_TOOL_HANDLERS.browser({
      action: 'type',
      selector: '#input',
      text: 'hi',
      clear: false,
      submit: true,
    });
    expect(h.browserType).toHaveBeenCalledWith('#input', 'hi', false, true);

    await MAIN_TOOL_HANDLERS.browser({ action: 'scroll', direction: 'down', selector: '#list' });
    expect(h.browserScroll).toHaveBeenCalledWith({ direction: 'down', selector: '#list' });

    await MAIN_TOOL_HANDLERS.browser({ action: 'wait', selector: '#done', time_ms: 500 });
    expect(h.browserWait).toHaveBeenCalledWith({ selector: '#done', time_ms: 500 });

    const closed = await MAIN_TOOL_HANDLERS.browser({ action: 'close' });
    expect(h.browserClose).toHaveBeenCalled();
    expect(closed).toEqual({ success: true });
  });

  it('未知 action 返回支持列表', async () => {
    const r = await MAIN_TOOL_HANDLERS.browser({ action: 'fly' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('未知 browser action: fly');
    expect(String(r.error)).toContain('open');
    expect(String(r.error)).toContain('close');
  });
});
