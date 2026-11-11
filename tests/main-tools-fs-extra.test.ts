import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const h = vi.hoisted(() => ({
  rename: vi.fn(),
  realRename: null as null | ((...args: unknown[]) => Promise<void>),
  allowed: vi.fn(() => ({ ok: true }) as { ok: boolean; reason?: string }),
  sendLog: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  h.realRename = actual.rename as unknown as (...args: unknown[]) => Promise<void>;
  return { ...actual, rename: (...args: unknown[]) => h.rename(...args) };
});
vi.mock('../src/main/tool-handlers-shared.js', () => ({
  sendLog: h.sendLog,
  resolvePath: (p: string) => p,
  isUrl: (s: string) => typeof s === 'string' && /^https?:\/\//i.test(s),
}));
vi.mock('../src/main/tool-security.js', () => ({ checkPathAllowed: h.allowed }));
vi.mock('../src/main/workspace.js', () => ({ getWorkspaceDir: () => '/tmp/ws' }));
vi.mock('child_process', () => ({ execFile: h.execFile }));

import {
  handleReadFile,
  handleWriteFile,
  handleListDir,
  handleSearchFiles,
  handleCreateDir,
  handleDeleteFile,
  handleEditFile,
  handleTree,
  handleReadMultipleFiles,
  handleMoveFile,
  handleCopyFile,
  handleDiff,
} from '../src/main/tool-handlers-fs.js';

let tmpDir: string;

function p(name: string): string {
  return path.join(tmpDir, name);
}

async function write(name: string, content: string | Buffer): Promise<string> {
  const file = p(name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

beforeEach(async () => {
  h.rename.mockReset();
  h.rename.mockImplementation((...args: unknown[]) => h.realRename!(...args));
  h.allowed.mockReset();
  h.allowed.mockReturnValue({ ok: true });
  h.sendLog.mockReset();
  h.execFile.mockReset();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metona-fs-extra-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('read_file 二进制与编码', () => {
  it('二进制模式返回 base64、字节范围与 MIME', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 255, 254]);
    const file = await write('img.png', bytes);
    const r = await handleReadFile({ path: file, mode: 'binary' });
    expect(r.success).toBe(true);
    expect(r.encoding).toBe('base64');
    expect(r.mode).toBe('binary');
    expect(Buffer.from(r.content as string, 'base64')).toEqual(bytes);
    expect(r.bytes_read).toBe(6);
    expect(r.byte_range).toEqual([0, 6]);
    expect(r.mime_hint).toBe('image/png');
    expect(r.truncated).toBe(false);
  });

  it('二进制 offset/limit 截断并给出剩余字节提示', async () => {
    const bytes = Buffer.from('0123456789');
    const file = await write('part.bin', bytes);
    const r = await handleReadFile({ path: file, mode: 'binary', offset_bytes: 2, limit_bytes: 4 });
    expect(r.success).toBe(true);
    expect(Buffer.from(r.content as string, 'base64').toString()).toBe('2345');
    expect(r.byte_range).toEqual([2, 6]);
    expect(r.truncated).toBe(true);
    expect(r.remaining_bytes).toBe(4);
    expect(String(r.hint)).toContain('offset_bytes=6');
    expect(r.mime_hint).toBe('application/octet-stream');
  });

  it('未知扩展名 MIME 回退为 octet-stream', async () => {
    const file = await write('a.xyz', 'abc');
    const r = await handleReadFile({ path: file, mode: 'binary' });
    expect(r.mime_hint).toBe('application/octet-stream');
  });

  it('文本字节分页读取', async () => {
    const file = await write('bytes.txt', 'abcdefghij');
    const r = await handleReadFile({ path: file, offset_bytes: 2, limit_bytes: 3 });
    expect(r.success).toBe(true);
    expect(r.content).toBe('cde');
    expect(r.byte_range).toEqual([2, 5]);
    expect(r.truncated).toBe(true);
    expect(r.remaining_bytes).toBe(5);
    expect(String(r.hint)).toContain('offset_bytes=5');
  });

  it('文本字节分页未指定 limit 时默认 50000', async () => {
    const file = await write('bytes2.txt', 'abcdef');
    const r = await handleReadFile({ path: file, offset_bytes: 1 });
    expect(r.success).toBe(true);
    expect(r.content).toBe('bcdef');
    expect(r.byte_range).toEqual([1, 6]);
    expect(r.truncated).toBe(false);
  });

  it('offset 等于文件大小时返回空内容', async () => {
    const file = await write('bytes3.txt', 'abc');
    const r = await handleReadFile({ path: file, offset_bytes: 3 });
    expect(r.success).toBe(true);
    expect(r.content).toBe('');
    expect(r.truncated).toBe(false);
  });

  it('offset 超过文件大小时返回空内容而不是 RangeError', async () => {
    const file = await write('bytes4.txt', 'abc');
    const r = await handleReadFile({ path: file, offset_bytes: 99 });
    expect(r.success).toBe(true);
    expect(r.content).toBe('');
    expect(r.byte_range).toEqual([3, 3]);
    expect(r.truncated).toBe(false);
  });

  it('按行范围读取并提示剩余行', async () => {
    const file = await write('lines.txt', 'a\nb\nc\nd\ne');
    const r = await handleReadFile({ path: file, start_line: 2, end_line: 4 });
    expect(r.success).toBe(true);
    expect(r.content).toBe('b\nc\nd');
    expect(r.line_range).toEqual([2, 4]);
    expect(r.truncated).toBe(true);
    expect(r.remaining_lines).toBe(1);
    expect(String(r.hint)).toContain('start_line=5');
  });

  it('只指定 start_line 时读到末尾', async () => {
    const file = await write('lines2.txt', 'a\nb\nc');
    const r = await handleReadFile({ path: file, start_line: 2 });
    expect(r.content).toBe('b\nc');
    expect(r.line_range).toEqual([2, 3]);
    expect(r.truncated).toBe(false);
  });

  it('按指定编码读取', async () => {
    const file = await write('latin.txt', Buffer.from('café', 'latin1'));
    const r = await handleReadFile({ path: file, encoding: 'latin1' });
    expect(r.success).toBe(true);
    expect(r.content).toBe('café');
    expect(r.encoding).toBe('latin1');
  });

  it('文件不存在返回错误', async () => {
    const r = await handleReadFile({ path: p('missing.txt') });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('ENOENT');
  });

  it('读取路径被拒绝', async () => {
    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止读取' });
    const r = await handleReadFile({ path: p('x') });
    expect(r.success).toBe(false);
    expect(r.error).toBe('禁止读取');
  });

  it('文本文件超过 5MB 被拒绝', async () => {
    const file = await write('big.txt', 'x');
    await fs.truncate(file, 5 * 1024 * 1024 + 1);
    const r = await handleReadFile({ path: file });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('文件过大');
  });

  it('二进制文件超过 50MB 被拒绝', async () => {
    const file = await write('big.bin', 'x');
    await fs.truncate(file, 50 * 1024 * 1024 + 1);
    const r = await handleReadFile({ path: file, mode: 'binary' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('最大支持 50MB');
  });
});

describe('write_file 统计与错误', () => {
  it('覆盖写入返回旧文件统计', async () => {
    const file = await write('overwrite.txt', 'line1\nline2\n');
    const r = await handleWriteFile({ path: file, content: 'new' });
    expect(r.success).toBe(true);
    expect(r.created).toBe(false);
    expect(r.overwrote).toBe(true);
    expect(r.prevSize).toBe(12);
    expect(r.prevLines).toBe(3);
    expect(r.totalSize).toBe(3);
    expect(r.lines).toBe(1);
  });

  it('追加写入保留旧内容并返回 prevSize', async () => {
    const file = await write('append.txt', 'abc');
    const r = await handleWriteFile({ path: file, content: 'def', mode: 'append' });
    expect(r.success).toBe(true);
    expect(r.appended).toBe(true);
    expect(r.prevSize).toBe(3);
    expect(await fs.readFile(file, 'utf-8')).toBe('abcdef');
  });

  it('base64 写入二进制且 lines 为 0', async () => {
    const file = p('b64.bin');
    const r = await handleWriteFile({
      path: file,
      content: Buffer.from([1, 2, 3]).toString('base64'),
      encoding: 'base64',
    });
    expect(r.success).toBe(true);
    expect(r.lines).toBe(0);
    expect(await fs.readFile(file)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('缺少 path/content 参数', async () => {
    const noPath = await handleWriteFile({ content: 'x' } as never);
    expect(noPath.success).toBe(false);
    expect(String(noPath.error)).toContain('缺少 path');

    const noContent = await handleWriteFile({ path: p('x') } as never);
    expect(noContent.success).toBe(false);
    expect(String(noContent.error)).toContain('缺少 content');
  });

  it('写入路径被拒绝', async () => {
    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止写入' });
    const r = await handleWriteFile({ path: p('x'), content: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('禁止写入');
  });

  it('覆盖内容超过 10MB 被拒绝', async () => {
    const r = await handleWriteFile({ path: p('big.txt'), content: 'x'.repeat(10 * 1024 * 1024 + 1) });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('10MB');
  });

  it('追加内容超过 5MB 被拒绝', async () => {
    const r = await handleWriteFile({
      path: p('big-append.txt'),
      content: 'x'.repeat(5 * 1024 * 1024 + 1),
      mode: 'append',
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('5MB');
  });

  it('目标为目录时写入失败', async () => {
    const dir = p('as-dir');
    await fs.mkdir(dir);
    const r = await handleWriteFile({ path: dir, content: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/EISDIR|EPERM/);
  });
});

describe('list_directory 递归/过滤/分页', () => {
  it('递归列出文件并支持 max_depth', async () => {
    await write('root/a.txt', 'a');
    await write('root/sub/b.txt', 'b');
    await write('root/sub/deep/c.txt', 'c');
    const root = p('root');

    const depth1 = await handleListDir({ path: root, recursive: true, max_depth: 1 });
    expect(depth1.success).toBe(true);
    expect((depth1.entries as Array<{ name: string }>).map((e) => e.name)).toEqual(['a.txt']);

    const depth2 = await handleListDir({ path: root, recursive: true, max_depth: 2 });
    expect((depth2.entries as Array<{ name: string }>).map((e) => e.name).sort()).toEqual([
      'a.txt',
      path.join('sub', 'b.txt'),
    ]);

    const full = await handleListDir({ path: root, recursive: true });
    expect((full.entries as Array<{ name: string }>).map((e) => e.name).sort()).toEqual([
      'a.txt',
      path.join('sub', 'b.txt'),
      path.join('sub', 'deep', 'c.txt'),
    ]);
  });

  it('隐藏文件与扩展名过滤', async () => {
    await write('filter/.hidden.ts', 'x');
    await write('filter/a.ts', 'x');
    await write('filter/b.js', 'x');
    const dir = p('filter');

    const visible = await handleListDir({ path: dir });
    expect((visible.entries as Array<{ name: string }>).map((e) => e.name).sort()).toEqual(['a.ts', 'b.js']);

    const hidden = await handleListDir({ path: dir, include_hidden: true });
    expect((hidden.entries as Array<{ name: string }>).map((e) => e.name)).toContain('.hidden.ts');

    const onlyTs = await handleListDir({ path: dir, filter_extension: '.ts' });
    expect((onlyTs.entries as Array<{ name: string }>).map((e) => e.name).sort()).toEqual(['a.ts']);
  });

  it('offset 分页跳过前面的文件', async () => {
    await write('page/a.txt', 'a');
    await write('page/b.txt', 'b');
    await write('page/c.txt', 'c');
    const r = await handleListDir({ path: p('page'), offset: 1 });
    expect(r.success).toBe(true);
    expect(r.offset).toBe(1);
    expect((r.entries as unknown[]).length).toBe(2);
  });

  it('目录不存在与路径被拒绝', async () => {
    const missing = await handleListDir({ path: p('nope') });
    expect(missing.success).toBe(false);
    expect(String(missing.error)).toContain('ENOENT');

    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止读取' });
    const denied = await handleListDir({ path: p('x') });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('禁止读取');
  });
});

describe('search_files 正则/过滤/分页', () => {
  it('正则搜索支持大小写与列号', async () => {
    const file = await write('search/regex.txt', 'Foo foo\nBAR bar');
    const insensitive = await handleSearchFiles({
      path: p('search'),
      query: 'foo',
      search_type: 'content',
    });
    expect(insensitive.success).toBe(true);
    const matches = (insensitive.results as Array<{ matches: Array<{ line: number; column: number }> }>)[0].matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].line).toBe(1);
    expect(matches[0].column).toBe(1);

    const sensitive = await handleSearchFiles({
      path: p('search'),
      query: 'Foo',
      search_type: 'content',
      case_sensitive: true,
    });
    expect((sensitive.results as Array<{ matches: Array<{ column: number }> }>)[0].matches[0].column).toBe(1);

    const regex = await handleSearchFiles({
      path: p('search'),
      query: 'B.R',
      search_type: 'content',
      use_regex: true,
    });
    expect(regex.total_matches).toBe(1);
    expect((regex.results as Array<{ path: string }>)[0].path).toBe(file);
  });

  it('扩展名过滤与 max_results 截断', async () => {
    await write('ext/a.ts', 'needle one\nneedle two');
    await write('ext/b.js', 'needle three');
    const r = await handleSearchFiles({
      path: p('ext'),
      query: 'needle',
      search_type: 'content',
      file_extensions: ['.ts'],
      max_results: 1,
    });
    expect(r.success).toBe(true);
    expect(r.total_files).toBe(1);
    expect(r.total_matches).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it('文件名搜索命中后不再扫描内容', async () => {
    const file = await write('names/target-file.txt', 'no match inside');
    const r = await handleSearchFiles({
      path: p('names'),
      query: 'target-file',
      search_type: 'both',
    });
    expect(r.success).toBe(true);
    expect(r.total_matches).toBe(1);
    const result = (r.results as Array<{ path: string; matches: Array<{ line: number; text: string }> }>)[0];
    expect(result.path).toBe(file);
    expect(result.matches[0].line).toBe(0);
    expect(result.matches[0].text).toContain('[文件名匹配]');
  });

  it('跳过隐藏文件与超过 500KB 的文件', async () => {
    await write('scan/.hidden.txt', 'needle');
    await write('scan/large.txt', 'needle' + 'x'.repeat(600 * 1024));
    const r = await handleSearchFiles({
      path: p('scan'),
      query: 'needle',
      search_type: 'content',
    });
    expect(r.success).toBe(true);
    expect(r.total_matches).toBe(0);
  });

  it('目录不存在返回空结果，路径被拒绝返回错误', async () => {
    const missing = await handleSearchFiles({ path: p('missing'), query: 'x' });
    expect(missing.success).toBe(true);
    expect(missing.total_files).toBe(0);

    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止读取' });
    const denied = await handleSearchFiles({ path: p('x'), query: 'x' });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('禁止读取');
  });
});

describe('create_dir / delete_file', () => {
  it('创建目录（含已存在）', async () => {
    const dir = p('created/nested');
    const r = await handleCreateDir({ path: dir });
    expect(r.success).toBe(true);
    expect(r.created).toBe(true);
    expect(await fs.stat(dir).then((s) => s.isDirectory())).toBe(true);
    const again = await handleCreateDir({ path: dir });
    expect(again.success).toBe(true);
  });

  it('创建目录路径被拒绝或父路径是文件', async () => {
    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止写入' });
    const denied = await handleCreateDir({ path: p('x') });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('禁止写入');

    const blocker = await write('blocker', 'x');
    const bad = await handleCreateDir({ path: path.join(blocker, 'child') });
    expect(bad.success).toBe(false);
    expect(String(bad.error)).toMatch(/ENOTDIR|EEXIST/);
  });

  it('删除空目录（非递归）', async () => {
    const dir = p('empty-dir');
    await fs.mkdir(dir);
    const r = await handleDeleteFile({ path: dir });
    expect(r.success).toBe(true);
    expect(r.type).toBe('directory');
    expect(r.filesDeleted).toBe(0);
  });

  it('非空目录非递归删除失败', async () => {
    await write('nonempty/a.txt', 'a');
    const r = await handleDeleteFile({ path: p('nonempty') });
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/ENOTEMPTY|EPERM/);
  });

  it('递归删除目录统计文件数与大小', async () => {
    await write('rec/a.txt', '12345');
    await write('rec/sub/b.txt', '678');
    const r = await handleDeleteFile({ path: p('rec'), recursive: true });
    expect(r.success).toBe(true);
    expect(r.type).toBe('directory');
    expect(r.filesDeleted).toBe(2);
    expect(Number(r.deletedSize)).toBeGreaterThanOrEqual(8);
    await expect(fs.stat(p('rec'))).rejects.toThrow();
  });

  it('删除单个文件返回大小', async () => {
    const file = await write('single.txt', '1234');
    const r = await handleDeleteFile({ path: file });
    expect(r.success).toBe(true);
    expect(r.type).toBe('file');
    expect(r.deletedSize).toBe(4);
  });

  it('删除不存在路径与路径被拒绝', async () => {
    const missing = await handleDeleteFile({ path: p('nope') });
    expect(missing.success).toBe(false);
    expect(String(missing.error)).toContain('ENOENT');

    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止写入' });
    const denied = await handleDeleteFile({ path: p('x') });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('禁止写入');
  });

  it('批量删除部分失败返回汇总', async () => {
    const ok = await write('batch-ok.txt', 'x');
    const r = await handleDeleteFile({ paths: [ok, p('batch-missing.txt')] });
    expect(r.success).toBe(false);
    expect(r.batch).toBe(true);
    expect(r.totalPaths).toBe(2);
    expect(r.successCount).toBe(1);
    expect(r.failCount).toBe(1);
    expect(String(r.error)).toContain('1 个路径删除失败');
    expect((r.results as Array<{ success: boolean }>).map((x) => x.success)).toEqual([true, false]);
  });

  it('path 与 paths 合并为批量删除', async () => {
    const a = await write('merge-a.txt', 'a');
    const b = await write('merge-b.txt', 'b');
    const r = await handleDeleteFile({ paths: [a], path: b });
    expect(r.success).toBe(true);
    expect(r.totalPaths).toBe(2);
    expect(r.successCount).toBe(2);
  });
});

describe('edit_file 正则与字面量', () => {
  it('正则全局替换', async () => {
    const file = await write('edit-regex.txt', 'a1 a2 a3');
    const r = await handleEditFile({ path: file, old_text: '\\d', new_text: 'X', use_regex: true, all: true });
    expect(r.success).toBe(true);
    expect(r.replaceCount).toBe(3);
    expect(r.regex).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe('aX aX aX');
  });

  it('正则未匹配与无效正则', async () => {
    const file = await write('edit-regex2.txt', 'abc');
    const noMatch = await handleEditFile({ path: file, old_text: 'z+', new_text: 'x', use_regex: true });
    expect(noMatch.success).toBe(false);
    expect(String(noMatch.error)).toContain('未找到匹配正则');

    const invalid = await handleEditFile({ path: file, old_text: '([', new_text: 'x', use_regex: true });
    expect(invalid.success).toBe(false);
    expect(String(invalid.error)).toContain('无效的正则表达式');
  });

  it('字面量全局替换且 $ 不被解释', async () => {
    const file = await write('edit-dollar.txt', 'foo foo');
    const r = await handleEditFile({ path: file, old_text: 'foo', new_text: '$&X', all: true });
    expect(r.success).toBe(true);
    expect(r.replaceCount).toBe(2);
    expect(await fs.readFile(file, 'utf-8')).toBe('$&X $&X');
  });

  it('字面量单次替换与未找到', async () => {
    const file = await write('edit-single.txt', 'foo foo');
    const ok = await handleEditFile({ path: file, old_text: 'foo', new_text: 'bar' });
    expect(ok.replaceCount).toBe(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('bar foo');

    const missing = await handleEditFile({ path: file, old_text: 'zzz', new_text: 'x' });
    expect(missing.success).toBe(false);
    expect(String(missing.error)).toContain('未找到要替换的文本');
  });

  it('编辑路径被拒绝与文件过大', async () => {
    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止写入' });
    const denied = await handleEditFile({ path: p('x'), old_text: 'a', new_text: 'b' });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('禁止写入');

    const big = await write('edit-big.txt', 'x');
    await fs.truncate(big, 5 * 1024 * 1024 + 1);
    const tooBig = await handleEditFile({ path: big, old_text: 'a', new_text: 'b' });
    expect(tooBig.success).toBe(false);
    expect(String(tooBig.error)).toContain('文件过大');
  });
});

describe('tree', () => {
  it('目录优先排序、隐藏文件与深度限制', async () => {
    await write('tree/z.txt', 'z');
    await write('tree/a.txt', 'a');
    await write('tree/.hidden', 'h');
    await write('tree/dir/nested.txt', 'n');

    const r = await handleTree({ path: p('tree') });
    expect(r.success).toBe(true);
    expect(r.fileCount).toBe(3);
    expect(r.dirCount).toBe(1);
    const lines = String(r.tree).split('\n');
    expect(lines[0]).toContain('tree/');
    expect(lines[1]).toContain('📁 dir');
    expect(r.tree).not.toContain('.hidden');
    expect(r.tree).toContain('nested.txt');

    const hidden = await handleTree({ path: p('tree'), include_hidden: true });
    expect(hidden.fileCount).toBe(4);
    expect(hidden.tree).toContain('.hidden');

    const shallow = await handleTree({ path: p('tree'), max_depth: 1 });
    expect(shallow.tree).not.toContain('nested.txt');
  });

  it('不存在的目录返回空树，路径被拒绝返回错误', async () => {
    const missing = await handleTree({ path: p('no-tree') });
    expect(missing.success).toBe(true);
    expect(missing.fileCount).toBe(0);
    expect(String(missing.tree)).toContain('no-tree/');

    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止读取' });
    const denied = await handleTree({ path: p('x') });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('禁止读取');
  });
});

describe('read_multiple_files', () => {
  it('按 max_chars_per_file 截断', async () => {
    const file = await write('multi/a.txt', 'abcdef');
    const r = await handleReadMultipleFiles({ paths: [file], max_chars_per_file: 3 });
    expect(r.success).toBe(true);
    const item = (r.files as Array<{ content: string }>)[0];
    expect(item.content).toBe('abc\n... (已截断)');
  });

  it('单个文件失败不影响其他文件', async () => {
    const ok = await write('multi/ok.txt', 'ok');
    const big = await write('multi/big.txt', 'x');
    await fs.truncate(big, 1024 * 1024 + 1);
    const r = await handleReadMultipleFiles({ paths: [p('multi/missing.txt'), big, ok] });
    expect(r.success).toBe(true);
    expect(r.total).toBe(3);
    const files = r.files as Array<{ success: boolean; error?: string; content?: string }>;
    expect(files[0].success).toBe(false);
    expect(String(files[0].error)).toContain('ENOENT');
    expect(files[1].success).toBe(false);
    expect(String(files[1].error)).toContain('1MB');
    expect(files[2].success).toBe(true);
    expect(files[2].content).toBe('ok');
  });

  it('最多读取 50 个文件', async () => {
    const file = await write('multi/one.txt', 'x');
    const r = await handleReadMultipleFiles({ paths: Array.from({ length: 51 }, () => file) });
    expect(r.success).toBe(true);
    expect(r.total).toBe(50);
  });

  it('路径被拒绝与空列表', async () => {
    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止读取' });
    const denied = await handleReadMultipleFiles({ paths: [p('x')] });
    expect(denied.success).toBe(true);
    expect((denied.files as Array<{ success: boolean; error?: string }>)[0].error).toBe('禁止读取');

    const empty = await handleReadMultipleFiles({ paths: [] });
    expect(empty.success).toBe(true);
    expect(empty.total).toBe(0);
  });
});

describe('file_transfer move/copy', () => {
  it('移动文件', async () => {
    const src = await write('move/src.txt', 'hello');
    const dest = p('move/dest.txt');
    const r = await handleMoveFile({ source: src, destination: dest });
    expect(r.success).toBe(true);
    expect(await fs.readFile(dest, 'utf-8')).toBe('hello');
    await expect(fs.stat(src)).rejects.toThrow();
  });

  it('移动目录', async () => {
    await write('move-dir/sub/a.txt', 'a');
    const dest = p('moved-dir');
    const r = await handleMoveFile({ source: p('move-dir'), destination: dest });
    expect(r.success).toBe(true);
    expect(await fs.readFile(path.join(dest, 'sub', 'a.txt'), 'utf-8')).toBe('a');
  });

  it('rename EXDEV 时回退 copy+delete（文件）', async () => {
    const src = await write('exdev/src.txt', 'data');
    const dest = p('exdev/dest.txt');
    h.rename.mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    const r = await handleMoveFile({ source: src, destination: dest });
    expect(r.success).toBe(true);
    expect(await fs.readFile(dest, 'utf-8')).toBe('data');
    await expect(fs.stat(src)).rejects.toThrow();
    expect(h.sendLog.mock.calls.some((c) => String(c[1]).includes('跨盘回退'))).toBe(true);
  });

  it('rename EPERM 时回退 copy+delete（目录）', async () => {
    await write('eperm-dir/a.txt', 'a');
    const dest = p('eperm-dest');
    h.rename.mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    const r = await handleMoveFile({ source: p('eperm-dir'), destination: dest });
    expect(r.success).toBe(true);
    expect(await fs.readFile(path.join(dest, 'a.txt'), 'utf-8')).toBe('a');
  });

  it('其他 rename 错误直接失败', async () => {
    const src = await write('move-err/src.txt', 'x');
    h.rename.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const r = await handleMoveFile({ source: src, destination: p('move-err/dest.txt') });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('denied');
  });

  it('移动不存在文件与路径被拒绝', async () => {
    const missing = await handleMoveFile({ source: p('no-src'), destination: p('no-dest') });
    expect(missing.success).toBe(false);
    expect(String(missing.error)).toContain('ENOENT');

    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止读取' });
    const srcDenied = await handleMoveFile({ source: p('a'), destination: p('b') });
    expect(srcDenied.success).toBe(false);
    expect(srcDenied.error).toBe('禁止读取');

    h.allowed.mockReturnValueOnce({ ok: true }).mockReturnValueOnce({ ok: false, reason: '禁止写入' });
    const destDenied = await handleMoveFile({ source: p('a'), destination: p('b') });
    expect(destDenied.success).toBe(false);
    expect(destDenied.error).toBe('禁止写入');
  });

  it('复制文件与目录', async () => {
    const src = await write('copy/src.txt', 'copy');
    const dest = p('copy/nested/dest.txt');
    const file = await handleCopyFile({ source: src, destination: dest });
    expect(file.success).toBe(true);
    expect(file.isDirectory).toBe(false);
    expect(await fs.readFile(dest, 'utf-8')).toBe('copy');

    await write('copy-dir/sub/a.txt', 'a');
    const dir = await handleCopyFile({ source: p('copy-dir'), destination: p('copy-dir-out') });
    expect(dir.success).toBe(true);
    expect(dir.isDirectory).toBe(true);
    expect(await fs.readFile(p('copy-dir-out/sub/a.txt'), 'utf-8')).toBe('a');
  });

  it('目录复制 recursive=false 失败', async () => {
    await write('copy-norec/a.txt', 'a');
    const r = await handleCopyFile({
      source: p('copy-norec'),
      destination: p('copy-norec-out'),
      recursive: false,
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toBeTruthy();
  });

  it('复制源不存在与路径被拒绝', async () => {
    const missing = await handleCopyFile({ source: p('nope'), destination: p('dest') });
    expect(missing.success).toBe(false);
    expect(String(missing.error)).toContain('ENOENT');

    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止读取' });
    const srcDenied = await handleCopyFile({ source: p('a'), destination: p('b') });
    expect(srcDenied.success).toBe(false);

    h.allowed.mockReturnValueOnce({ ok: true }).mockReturnValueOnce({ ok: false, reason: '禁止写入' });
    const destDenied = await handleCopyFile({ source: p('a'), destination: p('b') });
    expect(destDenied.success).toBe(false);
    expect(destDenied.error).toBe('禁止写入');
  });
});

describe('diff', () => {
  it('相同文件返回 identical', async () => {
    const a = await write('diff/a.txt', 'one\ntwo\n');
    const b = await write('diff/b.txt', 'one\ntwo\n');
    const r = await handleDiff({ mode: 'file_vs_file', path1: a, path2: b });
    expect(r.success).toBe(true);
    expect(r.identical).toBe(true);
    expect(r.diff).toBe('');
    expect(String(r.message)).toContain('完全相同');
  });

  it('文件对比生成 unified diff', async () => {
    const a = await write('diff/left.txt', 'a\nb\nc');
    const b = await write('diff/right.txt', 'a\nB\nc');
    const r = await handleDiff({ mode: 'file_vs_file', path1: a, path2: b });
    expect(r.success).toBe(true);
    expect(r.identical).toBe(false);
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
    expect(r.hunk_count).toBe(1);
    expect(String(r.diff)).toContain('--- a/left.txt');
    expect(String(r.diff)).toContain('+++ b/right.txt');
    expect(String(r.diff)).toContain('-b');
    expect(String(r.diff)).toContain('+B');
  });

  it('file_vs_content 与 context_lines=0', async () => {
    const a = await write('diff/base.txt', 'a\nb\nc\nd');
    const r = await handleDiff({
      mode: 'file_vs_content',
      path1: a,
      content: 'a\nX\nc\nd',
      context_lines: 0,
    });
    expect(r.success).toBe(true);
    expect(r.mode).toBe('file_vs_content');
    expect(String(r.diff)).toContain('+++ b/base.txt (new)');
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
  });

  it('file_vs_git_head 成功（使用仓库相对路径）', async () => {
    const a = await write('diff/head.txt', 'new\n');
    h.execFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string) => void) => {
        if (args[0] === 'rev-parse') cb(null, `${tmpDir}\n`);
        else cb(null, 'old\n');
      },
    );
    const r = await handleDiff({ mode: 'file_vs_git_head', path1: a });
    expect(r.success).toBe(true);
    expect(String(r.diff)).toContain('a/head.txt (HEAD)');
    expect(String(r.diff)).toContain('-old');
    expect(String(r.diff)).toContain('+new');
    const showCall = h.execFile.mock.calls.find((call) => (call[1] as string[])[0] === 'show') as [
      string,
      string[],
      { cwd: string },
    ];
    expect(showCall[0]).toBe('git');
    expect(showCall[1]).toEqual(['show', 'HEAD:diff/head.txt']);
    expect(showCall[2].cwd).toBe(tmpDir);
  });

  it('file_vs_git_head 失败返回提示', async () => {
    const a = await write('diff/head-fail.txt', 'new\n');
    h.execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) =>
      cb(new Error('no HEAD')),
    );
    const r = await handleDiff({ mode: 'file_vs_git_head', path1: a });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('无法获取 git HEAD 版本');
  });

  it('缺少 path1/path2 与不支持的模式', async () => {
    const noPath1 = await handleDiff({ mode: 'file_vs_file' });
    expect(noPath1.success).toBe(false);
    expect(String(noPath1.error)).toContain('path1');

    const a = await write('diff/x.txt', 'x');
    const noPath2 = await handleDiff({ mode: 'file_vs_file', path1: a });
    expect(noPath2.success).toBe(false);
    expect(String(noPath2.error)).toContain('path2');

    const badMode = await handleDiff({ mode: 'weird' as never, path1: a });
    expect(badMode.success).toBe(false);
    expect(String(badMode.error)).toContain('不支持的 mode');
  });

  it('目录作为 diff 输入被拒绝', async () => {
    const dir = p('diff-dir');
    await fs.mkdir(dir);
    const r1 = await handleDiff({ mode: 'file_vs_content', path1: dir, content: 'x' });
    expect(r1.success).toBe(false);
    expect(String(r1.error)).toContain('是目录');

    const file = await write('diff/file.txt', 'x');
    const r2 = await handleDiff({ mode: 'file_vs_file', path1: file, path2: dir });
    expect(r2.success).toBe(false);
    expect(String(r2.error)).toContain('是目录');
  });

  it('路径被拒绝与文件行数过多', async () => {
    h.allowed.mockReturnValueOnce({ ok: false, reason: '禁止读取' });
    const denied = await handleDiff({ mode: 'file_vs_content', path1: p('x'), content: 'x' });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('禁止读取');

    const many = Array.from({ length: 5001 }, (_, i) => `line${i}`).join('\n');
    const a = await write('diff/many.txt', many);
    const b = await write('diff/many2.txt', many);
    const tooMany = await handleDiff({ mode: 'file_vs_file', path1: a, path2: b });
    expect(tooMany.success).toBe(false);
    expect(String(tooMany.error)).toContain('行数过多');
  });

  it('文件超过 5MB 被拒绝', async () => {
    const a = await write('diff/big.txt', 'x');
    await fs.truncate(a, 5 * 1024 * 1024 + 1);
    const r = await handleDiff({ mode: 'file_vs_content', path1: a, content: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('文件过大');
  });
});
