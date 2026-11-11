import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const hoisted = vi.hoisted(() => ({ dir: '', failRename: false, failUnlink: false }));

vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dir },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (hoisted.failRename) throw new Error('rename failed');
      return actual.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (hoisted.failUnlink) throw new Error('unlink failed');
      return actual.unlinkSync(...args);
    },
  };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metona-db-fs-err-'));
  hoisted.dir = tmpDir;
  hoisted.failRename = false;
  hoisted.failUnlink = false;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('数据库文件操作失败路径', () => {
  it('损坏库重命名失败时抛出明确错误', async () => {
    fs.writeFileSync(path.join(tmpDir, 'metona.db'), 'not a db');
    hoisted.failRename = true;
    const mod = await import('../src/main/db/sqlite.js');
    await expect(mod.initDatabase()).rejects.toThrow('无法处理旧数据库');
  });

  it('旧库删除失败时抛出明确错误', async () => {
    const dbPath = path.join(tmpDir, 'metona.db');
    const old = new DatabaseSync(dbPath);
    old.exec('PRAGMA user_version = 0;');
    old.close();
    hoisted.failUnlink = true;
    const mod = await import('../src/main/db/sqlite.js');
    await expect(mod.initDatabase()).rejects.toThrow('无法删除旧数据库');
  });
});
