import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dir },
}));

import {
  initDatabase,
  getDb,
  saveSession,
  getSession,
  getAllSessions,
  getSessionSummaries,
  searchSessions,
  getAllSessionsData,
  deleteSession,
  clearAllSessions,
  saveMessage,
  saveMessagesBatch,
  getMessagesBySession,
  getMessageIds,
  deleteMessages,
  saveSetting,
  getSetting,
  saveSettingsBatch,
  saveTrace,
  saveTracesBatch,
  getTracesBySession,
  exportAllSessions,
  importSessions,
  getAllSessionsTokenStats,
  saveToolAudit,
  getToolAuditsBySession,
  getAllToolAudits,
  saveMemoryEmbedding,
  getMemoryEmbedding,
  getAllMemoryEmbeddings,
  deleteMemoryEmbedding,
  clearMemoryEmbeddings,
  flushDatabase,
} from '../src/main/db/sqlite.js';
import type { MessageRow, SessionRow, TraceRow } from '../src/main/db/sqlite.js';

let tmpDir: string;

function session(id: string, title = id): SessionRow {
  return {
    id,
    title,
    model: 'qwen3',
    system_prompt: null,
    parent_id: null,
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function message(id: string, sessionId: string, content = 'hello'): MessageRow {
  return {
    id,
    session_id: sessionId,
    role: 'user',
    content,
    thinking: null,
    images: null,
    tool_calls: null,
    tool_name: null,
    attachments: null,
    eval_count: 10,
    prompt_eval_count: 20,
    prompt_eval_cached_count: 5,
    total_duration: 100,
    created_at: Date.now(),
  };
}

function trace(id: string, sessionId: string): TraceRow {
  return {
    id,
    session_id: sessionId,
    step_index: 0,
    thought: 'think',
    action: 'read_file',
    action_input: '{}',
    observation: 'ok',
    loop_count: 1,
    error_pattern: null,
    created_at: Date.now(),
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metona-db-test-'));
  hoisted.dir = tmpDir;
  await initDatabase();
});

afterAll(() => {
  flushDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SQLite sessions', () => {
  it('保存/读取/更新会话，upsert 不删除消息', () => {
    saveSession(session('s1', 'first'));
    saveMessage(message('m1', 's1'));
    saveSession(session('s1', 'updated'));
    expect(getSession('s1')?.title).toBe('updated');
    expect(getMessagesBySession('s1')).toHaveLength(1);
  });

  it('列出、搜索、摘要与全量数据', () => {
    saveSession(session('s2', 'Rust 项目'));
    saveMessage(message('m2', 's2', 'Rust backend'));
    expect(getAllSessions().length).toBeGreaterThanOrEqual(2);
    expect(getSessionSummaries().some((s) => s.id === 's2')).toBe(true);
    expect(searchSessions('Rust').some((s) => s.id === 's2')).toBe(true);
    expect(searchSessions('%_').length).toBe(0);
    const all = getAllSessionsData();
    expect(all.sessions.length).toBeGreaterThanOrEqual(2);
    expect(all.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('删除单会话与清空全部', () => {
    saveSession(session('s3'));
    deleteSession('s3');
    expect(getSession('s3')).toBeNull();
    saveSession(session('s4'));
    clearAllSessions();
    expect(getAllSessions()).toHaveLength(0);
  });
});

describe('SQLite messages', () => {
  it('批量保存、ID 列表、按 ID 删除', () => {
    saveSession(session('s10'));
    saveMessagesBatch([message('m10', 's10'), message('m11', 's10')]);
    expect(getMessageIds('s10').sort()).toEqual(['m10', 'm11']);
    expect(deleteMessages('s10', ['m10', 'missing'])).toBe(2);
    expect(getMessageIds('s10')).toEqual(['m11']);
    expect(deleteMessages('s10', [])).toBe(0);
  });

  it('缓存命中字段持久化', () => {
    saveSession(session('s11'));
    saveMessage(message('m12', 's11'));
    expect(getMessagesBySession('s11')[0].prompt_eval_cached_count).toBe(5);
  });

  it('外键失败时事务回滚，不留下部分消息', () => {
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(() => saveMessagesBatch([message('bad', 'missing-session')])).toThrow();
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('空批次安全返回 0', () => {
    expect(saveMessagesBatch([])).toBe(0);
    expect(saveTracesBatch([])).toBe(0);
    expect(() => saveSettingsBatch([])).not.toThrow();
  });

  it('状态为空时回退 active，重复 init 幂等', async () => {
    saveSession({ ...session('s14'), status: '' });
    expect(getSession('s14')?.status).toBe('active');
    const again = await initDatabase();
    expect(again).toBe(getDb());
  });

  it('导入时内层 savepoint 失败会回滚且不破坏外层事务', () => {
    clearAllSessions();
    saveSession(session('s12'));
    expect(() =>
      importSessions({
        sessions: [session('s13')],
        messages: [{ ...message('bad-import', 's12'), created_at: null as unknown as number }],
        settings: [],
        exportedAt: Date.now(),
      }),
    ).toThrow();
    expect(getSession('s13')).toBeNull();
  });
});

describe('SQLite settings / traces', () => {
  it('设置 upsert 与批量写入', () => {
    saveSetting('a', 1);
    saveSetting('a', 2);
    expect(getSetting('a')).toBe(2);
    saveSettingsBatch([
      { key: 'b', value: true },
      { key: 'c', value: 'x' },
    ]);
    expect(getSetting('b')).toBe(true);
    expect(getSetting('missing', 'fallback')).toBe('fallback');
    expect(getSetting('raw')).toBeNull();
    // 直接写入非 JSON 文本，覆盖容错读取分支
    getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)')
      .run('raw', 'not-json', Date.now());
    expect(getSetting('raw')).toBe('not-json');
  });

  it('轨迹单条/批量与查询', () => {
    saveSession(session('s20'));
    saveTrace(trace('t1', 's20'));
    saveTracesBatch([trace('t2', 's20')]);
    expect(getTracesBySession('s20')).toHaveLength(2);
  });
});

describe('SQLite export / import', () => {
  it('导出过滤敏感设置，导入会话与消息', () => {
    clearAllSessions();
    saveSession(session('s30', '导出'));
    saveMessage(message('m30', 's30'));
    saveSetting('searxng_auth_key', 'secret');
    getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)')
      .run('raw', 'not-json', Date.now());
    const data = exportAllSessions();
    expect(data.sessions).toHaveLength(1);
    expect(data.messages).toHaveLength(1);
    expect(data.settings.some((s) => s.key === 'searxng_auth_key')).toBe(false);
    expect(data.settings.find((s) => s.key === 'raw')?.value).toBe('not-json');

    clearAllSessions();
    const result = importSessions(data);
    expect(result.imported).toBe(1);
    expect(getSession('s30')?.title).toBe('导出');
    expect(getMessagesBySession('s30')).toHaveLength(1);
    const again = importSessions(data);
    expect(again.skipped).toBe(1);
    // 消息引用的会话不存在时跳过，不抛错
    const skippedMessage = importSessions({
      sessions: [],
      messages: [message('orphan', 'missing-session')],
      settings: [],
      exportedAt: Date.now(),
    });
    expect(skippedMessage.imported).toBe(0);
  });
});

describe('SQLite token stats / audit / embeddings', () => {
  it('全局 Token 统计', () => {
    clearAllSessions();
    const empty = getAllSessionsTokenStats();
    expect(empty.totals.total_input).toBe(0);
    expect(empty.totals.total_output).toBe(0);
    expect(empty.totals.total_duration).toBe(0);
    expect(empty.totals.total_rounds).toBe(0);

    saveSession(session('s40'));
    saveMessage({ ...message('m40', 's40'), role: 'assistant' });
    const stats = getAllSessionsTokenStats();
    expect(stats.totals.total_input).toBe(20);
    expect(stats.totals.total_output).toBe(10);
    expect(stats.sessions[0].round_count).toBe(1);
  });

  it('工具审计日志', () => {
    const id = saveToolAudit({
      session_id: 's40',
      tool_name: 'write_file',
      args_json: '{}',
      result_status: 'success',
      result_summary: 'ok',
      duration_ms: 12,
      created_at: Date.now(),
    });
    expect(id).toMatch(/^audit_/);
    expect(getToolAuditsBySession('s40')).toHaveLength(1);
    expect(getAllToolAudits(10)).toHaveLength(1);
  });

  it('embedding 缓存 CRUD', () => {
    saveMemoryEmbedding('e1', 'nomic', [0.1, 0.2, 0.3]);
    const vector = getMemoryEmbedding('e1', 'nomic')!;
    expect(vector).toHaveLength(3);
    expect(vector[0]).toBeCloseTo(0.1);
    expect(vector[1]).toBeCloseTo(0.2);
    expect(vector[2]).toBeCloseTo(0.3);
    expect(getMemoryEmbedding('missing', 'nomic')).toBeNull();
    expect(getAllMemoryEmbeddings('nomic')).toHaveLength(1);
    deleteMemoryEmbedding('e1');
    expect(getAllMemoryEmbeddings('nomic')).toHaveLength(0);
    saveMemoryEmbedding('e2', 'nomic', [1]);
    clearMemoryEmbeddings();
    expect(getAllMemoryEmbeddings('nomic')).toHaveLength(0);
  });

  it('数据库实例可用且 WAL 生效', () => {
    expect(getDb()).toBeTruthy();
    const mode = getDb().prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
  });
});
