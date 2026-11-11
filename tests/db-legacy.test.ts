import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const hoisted = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dir },
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metona-db-legacy-'));
  hoisted.dir = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('数据库破坏性升级边界', () => {
  it('旧库 user_version=0 时删除并创建全新 0.18 库', async () => {
    const dbPath = path.join(tmpDir, 'metona.db');
    const old = new DatabaseSync(dbPath);
    old.exec('CREATE TABLE old_stuff(id INTEGER); PRAGMA user_version = 0;');
    old.close();

    const mod = await import('../src/main/db/sqlite.js');
    await mod.initDatabase();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(180);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='old_stuff'").all()).toHaveLength(0);
    db.close();
  });

  it('marker 存在但旧库 user_version=0 时仍删除，不绕过版本校验', async () => {
    const dbPath = path.join(tmpDir, 'metona.db');
    fs.writeFileSync(path.join(tmpDir, 'metona-0.18.schema'), 'schema=180\n');
    const old = new DatabaseSync(dbPath);
    old.exec('CREATE TABLE old_stuff(id INTEGER); PRAGMA user_version = 0;');
    old.close();

    const mod = await import('../src/main/db/sqlite.js');
    await mod.initDatabase();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(180);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='old_stuff'").all()).toHaveLength(0);
    db.close();
  });

  it('marker 丢失但 user_version=180 时保留数据库并补 marker', async () => {
    const dbPath = path.join(tmpDir, 'metona.db');
    const existing = new DatabaseSync(dbPath);
    existing.exec(
      `PRAGMA user_version=180;
       CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT, created_at INTEGER, updated_at INTEGER);`,
    );
    existing.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run('keep', 'keep', 'm', 1, 1);
    existing.close();

    const mod = await import('../src/main/db/sqlite.js');
    await mod.initDatabase();

    expect(fs.existsSync(path.join(tmpDir, 'metona-0.18.schema'))).toBe(true);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect(db.prepare("SELECT id FROM sessions WHERE id='keep'").all()).toHaveLength(1);
    db.close();
  });

  it('旧 0.18 库缺少 prompt_eval_cached_count 时自动补列', async () => {
    const dbPath = path.join(tmpDir, 'metona.db');
    fs.writeFileSync(path.join(tmpDir, 'metona-0.18.schema'), 'schema=180\n');
    const existing = new DatabaseSync(dbPath);
    existing.exec(
      `PRAGMA user_version=180;
       CREATE TABLE messages (
         id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
         content TEXT, thinking TEXT, images TEXT, tool_calls TEXT, tool_name TEXT,
         attachments TEXT, eval_count INTEGER, prompt_eval_count INTEGER,
         total_duration INTEGER, created_at INTEGER NOT NULL
       );`,
    );
    existing.close();

    const mod = await import('../src/main/db/sqlite.js');
    await mod.initDatabase();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === 'prompt_eval_cached_count')).toBe(true);
    db.close();
  });

  it('损坏数据库被重命名为 .corrupt-* 而不是直接删除', async () => {
    const dbPath = path.join(tmpDir, 'metona.db');
    fs.writeFileSync(dbPath, 'not a sqlite database');
    fs.writeFileSync(`${dbPath}-wal`, 'wal');
    fs.writeFileSync(`${dbPath}-shm`, 'shm');

    const mod = await import('../src/main/db/sqlite.js');
    await mod.initDatabase();

    const files = fs.readdirSync(tmpDir);
    expect(files.some((f) => f.startsWith('metona.db.corrupt-'))).toBe(true);
    expect(files.some((f) => f.startsWith('metona.db.corrupt-') && f.endsWith('-wal'))).toBe(true);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(180);
    db.close();
  });

  it('损坏库没有 wal/shm 时也能重命名', async () => {
    fs.writeFileSync(path.join(tmpDir, 'metona.db'), 'not a db');
    const mod = await import('../src/main/db/sqlite.js');
    await mod.initDatabase();
    expect(fs.readdirSync(tmpDir).some((f) => f.startsWith('metona.db.corrupt-'))).toBe(true);
  });

  it('未初始化时 getDb 抛错，flushDatabase 安全返回', async () => {
    const mod = await import('../src/main/db/sqlite.js');
    expect(() => mod.getDb()).toThrow('数据库未初始化');
    expect(() => mod.flushDatabase()).not.toThrow();
  });
});
