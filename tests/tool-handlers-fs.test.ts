import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// 隔离 tool-handlers-fs 的依赖：屏蔽 workspace/main.js/electron 等主进程耦合
vi.mock('../src/main/tool-handlers-shared.js', () => ({
  sendLog: () => {},
  resolvePath: (p: string) => p,
  isUrl: (s: string) => typeof s === 'string' && /^https?:\/\//.test(s),
}));
vi.mock('../src/main/tool-security.js', () => ({
  checkPathAllowed: () => ({ ok: true }),
}));
vi.mock('../src/main/workspace.js', () => ({
  getWorkspaceDir: () => '/tmp/ws',
}));

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
} from '../src/main/tool-handlers-fs.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metona-fs-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('handleWriteFile / handleReadFile', () => {
  it('写入并读回文本文件', async () => {
    const p = path.join(tmpDir, 'a.txt');
    const w = await handleWriteFile({ path: p, content: 'hello 世界' });
    expect(w.success).toBe(true);
    expect(w.created).toBe(true);

    const r = await handleReadFile({ path: p });
    expect(r.success).toBe(true);
    expect(r.content).toBe('hello 世界');
  });

  it('写入空内容会创建空文件（content 有值即合法）', async () => {
    const p = path.join(tmpDir, 'empty.txt');
    const r = await handleWriteFile({ path: p, content: '' });
    expect(r.success).toBe(true);
    expect(r.bytesWritten).toBe(0);
  });

  it('缺 content 参数会报错', async () => {
    const r = await handleWriteFile({ path: path.join(tmpDir, 'nope.txt') } as any);
    expect(r.success).toBe(false);
    expect(r.error).toContain('content');
  });

  it('追加模式不覆盖原内容', async () => {
    const p = path.join(tmpDir, 'append.txt');
    await handleWriteFile({ path: p, content: '第一行' });
    await handleWriteFile({ path: p, content: '第二行', mode: 'append' });
    const r = await handleReadFile({ path: p });
    expect(r.content).toBe('第一行第二行');
  });

  it('base64 二进制读写', async () => {
    const p = path.join(tmpDir, 'bin.dat');
    const b64 = Buffer.from('hello').toString('base64');
    const w = await handleWriteFile({ path: p, content: b64, encoding: 'base64' });
    expect(w.success).toBe(true);
    const r = await handleReadFile({ path: p, encoding: 'base64', mode: 'binary' });
    expect(Buffer.from(r.content as string, 'base64').toString()).toBe('hello');
  });

  it('read_file 拒绝 URL', async () => {
    const r = await handleReadFile({ path: 'http://example.com/x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('web_fetch');
  });
});

describe('handleListDir', () => {
  it('列出目录条目', async () => {
    const dir = path.join(tmpDir, 'list');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'f1.txt'), 'x');
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });

    const r = await handleListDir({ path: dir });
    expect(r.success).toBe(true);
    expect(r.entries.some((e: any) => e.name === 'f1.txt' && e.type === 'file')).toBe(true);
    expect(r.entries.some((e: any) => e.name === 'sub' && e.type === 'directory')).toBe(true);
  });

  it('空目录返回空列表', async () => {
    const dir = path.join(tmpDir, 'empty-list');
    await fs.mkdir(dir, { recursive: true });
    const r = await handleListDir({ path: dir });
    expect(r.success).toBe(true);
    expect(r.total).toBe(0);
  });
});

describe('handleSearchFiles', () => {
  it('按内容搜索文件', async () => {
    const dir = path.join(tmpDir, 'search');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'code.ts'), 'const foo = 42;');
    await fs.writeFile(path.join(dir, 'other.ts'), 'let bar = 7;');

    const r = await handleSearchFiles({ path: dir, query: 'foo', search_type: 'content' });
    expect(r.success).toBe(true);
    expect(r.total_matches).toBeGreaterThanOrEqual(1);
  });

  it('按文件名搜索', async () => {
    const r = await handleSearchFiles({ path: tmpDir, query: 'a.txt', search_type: 'filename' });
    expect(r.success).toBe(true);
    expect(r.total_matches).toBeGreaterThanOrEqual(0);
  });

  it('无效正则报错', async () => {
    const r = await handleSearchFiles({ path: tmpDir, query: '([', search_type: 'filename', use_regex: true });
    expect(r.success).toBe(false);
    expect(r.error).toContain('正则');
  });
});

describe('handleCreateDir / handleTree', () => {
  it('创建目录', async () => {
    const dir = path.join(tmpDir, 'newdir');
    const r = await handleCreateDir({ path: dir });
    expect(r.success).toBe(true);
    expect(await fs.stat(dir).then((s) => s.isDirectory())).toBe(true);
  });

  it('tree 返回目录结构', async () => {
    const dir = path.join(tmpDir, 'tree-root');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'file.txt'), 'x');
    const r = await handleTree({ path: dir });
    expect(r.success).toBe(true);
    expect(r.fileCount).toBe(1);
    expect(r.tree).toContain('file.txt');
  });
});

describe('handleEditFile', () => {
  it('字面量替换', async () => {
    const p = path.join(tmpDir, 'edit.txt');
    await handleWriteFile({ path: p, content: 'hello world' });
    const r = await handleEditFile({ path: p, old_text: 'world', new_text: 'metona' });
    expect(r.success).toBe(true);
    expect(r.replaceCount).toBe(1);
    const read = await handleReadFile({ path: p });
    expect(read.content).toBe('hello metona');
  });

  it('正则替换', async () => {
    const p = path.join(tmpDir, 'regex.txt');
    await handleWriteFile({ path: p, content: 'foo123bar' });
    const r = await handleEditFile({ path: p, old_text: '\\d+', new_text: 'X', use_regex: true });
    expect(r.success).toBe(true);
    const read = await handleReadFile({ path: p });
    expect(read.content).toBe('fooXbar');
  });

  it('未找到文本报错', async () => {
    const p = path.join(tmpDir, 'nomatch.txt');
    await handleWriteFile({ path: p, content: 'abc' });
    const r = await handleEditFile({ path: p, old_text: 'zzz', new_text: 'x' });
    expect(r.success).toBe(false);
  });
});

describe('handleDeleteFile', () => {
  it('删除单个文件', async () => {
    const p = path.join(tmpDir, 'del.txt');
    await handleWriteFile({ path: p, content: 'x' });
    const r = await handleDeleteFile({ path: p });
    expect(r.success).toBe(true);
    expect(r.deleted).toBe(true);
  });

  it('批量删除', async () => {
    const dir = path.join(tmpDir, 'batch-del');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '1.txt'), 'a');
    await fs.writeFile(path.join(dir, '2.txt'), 'b');
    const r = await handleDeleteFile({ paths: [path.join(dir, '1.txt'), path.join(dir, '2.txt')] });
    expect(r.success).toBe(true);
    expect(r.successCount).toBe(2);
  });

  it('无 path/paths 报错', async () => {
    const r = await handleDeleteFile({});
    expect(r.success).toBe(false);
  });
});

describe('handleReadMultipleFiles', () => {
  it('批量读取多个文件', async () => {
    const p1 = path.join(tmpDir, 'm1.txt');
    const p2 = path.join(tmpDir, 'm2.txt');
    await handleWriteFile({ path: p1, content: 'one' });
    await handleWriteFile({ path: p2, content: 'two' });
    const r = await handleReadMultipleFiles({ paths: [p1, p2] });
    expect(r.success).toBe(true);
    expect(r.total).toBe(2);
    const contents = (r.files as Array<{ path: string; success: boolean; content?: string }>).map((f) => f.content);
    expect(contents).toContain('one');
    expect(contents).toContain('two');
  });

  it('拒绝 URL 路径', async () => {
    const r = await handleReadMultipleFiles({ paths: ['http://example.com/x'] });
    expect(r.success).toBe(false);
    expect(r.error).toContain('URL');
  });
});
