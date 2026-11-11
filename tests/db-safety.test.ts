import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/main/db/sqlite.ts'), 'utf-8');

describe('SQLite 写入安全', () => {
  it('sessions / messages / traces 不使用 INSERT OR REPLACE（避免级联删除子表）', () => {
    expect(SOURCE).not.toMatch(/INSERT OR REPLACE INTO (sessions|messages|traces)\b/i);
  });

  it('sessions / messages / traces 使用 ON CONFLICT 增量更新', () => {
    expect(SOURCE).toMatch(/INSERT INTO sessions[\s\S]*ON CONFLICT\(id\) DO UPDATE SET/);
    expect(SOURCE).toMatch(/INSERT INTO messages[\s\S]*ON CONFLICT\(id\) DO UPDATE SET/);
    expect(SOURCE).toMatch(/INSERT INTO traces[\s\S]*ON CONFLICT\(id\) DO UPDATE SET/);
  });
});
