/**
 * Metona Ollama Desktop - SQLite 数据库层（0.18.0）
 *
 * 使用 Node 24 内置 node:sqlite（同步 API + WAL）。
 * 破坏性策略：不读取 v0.17.2 数据库；首次启动删除旧 metona.db 并创建全新库。
 * 通过 sidecar 标记文件区分 0.18 新库，避免后续启动误删。
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ─── 数据库实例 ───

let db: DatabaseSync | null = null;
let dbPath: string | null = null;

const SCHEMA_MARKER = 'metona-0.18.schema';
const DB_FILENAME = 'metona.db';

export function getDb(): DatabaseSync {
  if (!db) throw new Error('数据库未初始化，请先调用 initDatabase()');
  return db;
}

function runExec(database: DatabaseSync, sql: string, params: Array<string | number | null | Uint8Array> = []): void {
  if (params.length > 0) {
    const stmt = database.prepare(sql);
    stmt.run(...params);
    return;
  }
  database.exec(sql);
}

function queryOne(
  database: DatabaseSync,
  sql: string,
  params: Array<string | number | null | Uint8Array> = [],
): Record<string, unknown> | null {
  const stmt = database.prepare(sql);
  const row = params.length > 0 ? stmt.get(...params) : stmt.get();
  return (row as Record<string, unknown> | undefined) ?? null;
}

function queryAll(
  database: DatabaseSync,
  sql: string,
  params: Array<string | number | null | Uint8Array> = [],
): Record<string, unknown>[] {
  const stmt = database.prepare(sql);
  const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
  return rows as Record<string, unknown>[];
}

function runTransaction(database: DatabaseSync, fn: () => void): void {
  const isOuter = _transactionDepth === 0;
  const savepoint = `metona_sp_${_transactionDepth}`;
  if (isOuter) database.exec('BEGIN IMMEDIATE');
  else database.exec(`SAVEPOINT ${savepoint}`);
  _transactionDepth++;
  try {
    fn();
    if (isOuter) database.exec('COMMIT');
    else database.exec(`RELEASE ${savepoint}`);
  } catch (err) {
    try {
      if (isOuter) database.exec('ROLLBACK');
      else database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  } finally {
    _transactionDepth--;
  }
}

let _cachedStatements = new Map<string, StatementSync>();
let _transactionDepth = 0;

function prepared(database: DatabaseSync, sql: string): StatementSync {
  const cached = _cachedStatements.get(sql);
  if (cached) return cached;
  const stmt = database.prepare(sql);
  _cachedStatements.set(sql, stmt);
  return stmt;
}

// ─── Schema ───

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    system_prompt TEXT,
    parent_id TEXT,
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    thinking TEXT,
    images TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    attachments TEXT,
    eval_count INTEGER,
    prompt_eval_count INTEGER,
    total_duration INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments TEXT,
    result TEXT,
    status TEXT DEFAULT 'pending',
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, tool_name);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    step_index INTEGER,
    thought TEXT,
    action TEXT,
    action_input TEXT,
    observation TEXT,
    loop_count INTEGER,
    error_pattern TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id, created_at);
  CREATE TABLE IF NOT EXISTS tool_audit (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args_json TEXT,
    result_status TEXT,
    result_summary TEXT,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tool_audit_session ON tool_audit(session_id, created_at);
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    entry_id TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (entry_id, model)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(model);
`;

/** 读取已有数据库的 user_version；无法读取时返回 null */
function readDatabaseUserVersion(databasePath: string): number | null {
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(databasePath, { readOnly: true });
    const row = probe.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  } catch {
    return null;
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 删除 v0.17.2 旧库文件（不读取、不解析、不转换） */
function removeLegacyDatabaseIfNeeded(markerPath: string, databasePath: string): void {
  if (fs.existsSync(markerPath)) return;

  // 根因修复：marker 可能因磁盘/权限/崩溃丢失。不能仅凭 marker 缺失就删除数据库，
  // 否则会把已经升级到 0.18 的新库误删。先读 user_version：
  // - 180：确认是 0.18 新库，补写 marker 并保留
  // - 其他：旧库，删除 db/wal/shm
  // - 无法读取：重命名为 .corrupt-* 备份，避免不可恢复的数据丢失
  if (fs.existsSync(databasePath)) {
    const version = readDatabaseUserVersion(databasePath);
    if (version === 180) {
      try {
        fs.writeFileSync(markerPath, `schema=180\nrecovered=${new Date().toISOString()}\n`);
      } catch {
        /* marker 写失败不影响本次运行；下次仍会通过 user_version 识别 */
      }
      return;
    }

    if (version === null) {
      const backupPath = `${databasePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(databasePath, backupPath);
        for (const suffix of ['-wal', '-shm']) {
          if (fs.existsSync(`${databasePath}${suffix}`)) {
            fs.renameSync(`${databasePath}${suffix}`, `${backupPath}${suffix}`);
          }
        }
        console.warn(`[db] 无法识别现有数据库，已备份到 ${backupPath}，0.18.0 将创建全新数据库`);
        return;
      } catch (err) {
        throw new Error(`无法处理旧数据库 ${databasePath}: ${(err as Error).message}`);
      }
    }
  }

  const candidates = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  let removed = false;
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed = true;
      }
    } catch (err) {
      // 删除失败则让后续 open 抛错，避免误读旧库
      throw new Error(`无法删除旧数据库 ${file}: ${(err as Error).message}`);
    }
  }
  if (removed) {
    // 豁免：数据库初始化发生在日志面板就绪前，只能输出到主进程 stderr
    console.log('[db] 已删除旧版数据库文件，0.18.0 将创建全新数据库');
  }
}

/** 初始化数据库（同步） */
export async function initDatabase(): Promise<DatabaseSync> {
  if (db) return db;

  const userData = app.getPath('userData');
  const markerPath = path.join(userData, SCHEMA_MARKER);
  dbPath = path.join(userData, DB_FILENAME);

  removeLegacyDatabaseIfNeeded(markerPath, dbPath);

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  db.exec('PRAGMA user_version = 180');

  try {
    fs.writeFileSync(markerPath, `schema=180\ncreated=${new Date().toISOString()}\n`);
  } catch {
    /* 标记写入失败不影响当前运行 */
  }

  _cachedStatements = new Map();
  return db;
}

/** 兼容旧调用：node:sqlite 使用 WAL 同步落盘，无需手动刷盘 */
export function flushDatabase(): void {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // 退出阶段失败不阻塞
  }
}

// ─── 类型定义 ───

export interface SessionRow {
  id: string;
  title: string;
  model: string;
  system_prompt: string | null;
  parent_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface SessionSummaryRow {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string | null;
  thinking: string | null;
  images: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  attachments: string | null;
  eval_count: number | null;
  prompt_eval_count: number | null;
  total_duration: number | null;
  created_at: number;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

export interface ToolCallRow {
  id: string;
  message_id: string;
  session_id: string;
  tool_name: string;
  arguments: string | null;
  result: string | null;
  status: string;
  duration_ms: number | null;
  created_at: number;
}

export interface TraceRow {
  id: string;
  session_id: string;
  step_index: number | null;
  thought: string | null;
  action: string | null;
  action_input: string | null;
  observation: string | null;
  loop_count: number | null;
  error_pattern: string | null;
  created_at: number;
}

// ─── Sessions CRUD ───

export function saveSession(session: SessionRow): string {
  prepared(
    getDb(),
    `INSERT INTO sessions (id, title, model, system_prompt, parent_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      model = excluded.model,
      system_prompt = excluded.system_prompt,
      parent_id = excluded.parent_id,
      status = excluded.status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`,
  ).run(
    session.id,
    session.title,
    session.model,
    session.system_prompt,
    session.parent_id,
    session.status || 'active',
    session.created_at,
    session.updated_at,
  );
  return session.id;
}

export function getSession(id: string): SessionRow | null {
  return queryOne(getDb(), 'SELECT * FROM sessions WHERE id = ?', [id]) as unknown as SessionRow | null;
}

export function getAllSessions(): SessionRow[] {
  return queryAll(getDb(), 'SELECT * FROM sessions ORDER BY updated_at DESC') as unknown as SessionRow[];
}

export function getSessionSummaries(): SessionSummaryRow[] {
  return queryAll(
    getDb(),
    `
    SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
    FROM sessions s
    ORDER BY s.updated_at DESC
  `,
  ) as unknown as SessionSummaryRow[];
}

export function searchSessions(query: string, limit = 200): SessionSummaryRow[] {
  const esc = (s: string): string => s.replace(/[\\%_]/g, (m) => '\\' + m);
  const pattern = `%${esc(query)}%`;
  return queryAll(
    getDb(),
    `
    SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
    FROM sessions s
    WHERE s.title LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\')
    ORDER BY s.updated_at DESC
    LIMIT ?
  `,
    [pattern, pattern, limit],
  ) as unknown as SessionSummaryRow[];
}

export function getAllSessionsData(): { sessions: SessionRow[]; messages: MessageRow[] } {
  const d = getDb();
  return {
    sessions: queryAll(d, 'SELECT * FROM sessions ORDER BY updated_at ASC') as unknown as SessionRow[],
    messages: queryAll(d, 'SELECT * FROM messages ORDER BY created_at ASC') as unknown as MessageRow[],
  };
}

export function deleteSession(id: string): void {
  runExec(getDb(), 'DELETE FROM sessions WHERE id = ?', [id]);
}

export function clearAllSessions(): void {
  getDb().exec('DELETE FROM sessions');
}

// ─── Messages CRUD ───

export function saveMessage(msg: MessageRow): string {
  saveMessagesBatch([msg]);
  return msg.id;
}

export function saveMessagesBatch(msgs: MessageRow[]): number {
  if (!msgs.length) return 0;
  const d = getDb();
  const stmt = prepared(
    d,
    `INSERT INTO messages (id, session_id, role, content, thinking, images, tool_calls, tool_name, attachments, eval_count, prompt_eval_count, total_duration, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      role = excluded.role,
      content = excluded.content,
      thinking = excluded.thinking,
      images = excluded.images,
      tool_calls = excluded.tool_calls,
      tool_name = excluded.tool_name,
      attachments = excluded.attachments,
      eval_count = excluded.eval_count,
      prompt_eval_count = excluded.prompt_eval_count,
      total_duration = excluded.total_duration,
      created_at = excluded.created_at`,
  );
  runTransaction(d, () => {
    for (const msg of msgs) {
      stmt.run(
        msg.id,
        msg.session_id,
        msg.role,
        msg.content,
        msg.thinking,
        msg.images,
        msg.tool_calls,
        msg.tool_name,
        msg.attachments,
        msg.eval_count,
        msg.prompt_eval_count,
        msg.total_duration,
        msg.created_at,
      );
    }
  });
  return msgs.length;
}

export function getMessagesBySession(sessionId: string): MessageRow[] {
  return queryAll(getDb(), 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [
    sessionId,
  ]) as unknown as MessageRow[];
}

export function getMessageIds(sessionId: string): string[] {
  return queryAll(getDb(), 'SELECT id FROM messages WHERE session_id = ?', [sessionId]).map((r) => String(r.id));
}

export function deleteMessages(sessionId: string, ids: string[]): number {
  const validIds = ids.filter((id) => typeof id === 'string' && id.length > 0);
  if (validIds.length === 0) return 0;
  const d = getDb();
  const CHUNK = 500;
  runTransaction(d, () => {
    for (let i = 0; i < validIds.length; i += CHUNK) {
      const chunk = validIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      runExec(d, `DELETE FROM messages WHERE session_id = ? AND id IN (${placeholders})`, [sessionId, ...chunk]);
    }
  });
  return validIds.length;
}

// ─── Settings CRUD ───

export function saveSetting(key: string, value: unknown): void {
  prepared(
    getDb(),
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), Date.now());
}

export function saveSettingsBatch(entries: Array<{ key: string; value: unknown }>): void {
  if (!entries.length) return;
  const d = getDb();
  const stmt = prepared(
    d,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  runTransaction(d, () => {
    for (const { key, value } of entries) {
      stmt.run(key, JSON.stringify(value), Date.now());
    }
  });
}

export function getSetting<T = unknown>(key: string, defaultValue: T | null = null): T {
  const row = queryOne(getDb(), 'SELECT value FROM settings WHERE key = ?', [key]) as { value: string } | null;
  if (!row) return defaultValue as T;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

// ─── Traces CRUD ───

export function saveTrace(trace: TraceRow): string {
  saveTracesBatch([trace]);
  return trace.id;
}

export function saveTracesBatch(traces: TraceRow[]): number {
  if (!traces.length) return 0;
  const d = getDb();
  const stmt = prepared(
    d,
    `INSERT INTO traces (id, session_id, step_index, thought, action, action_input, observation, loop_count, error_pattern, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      step_index = excluded.step_index,
      thought = excluded.thought,
      action = excluded.action,
      action_input = excluded.action_input,
      observation = excluded.observation,
      loop_count = excluded.loop_count,
      error_pattern = excluded.error_pattern,
      created_at = excluded.created_at`,
  );
  runTransaction(d, () => {
    for (const trace of traces) {
      stmt.run(
        trace.id,
        trace.session_id,
        trace.step_index,
        trace.thought,
        trace.action,
        trace.action_input,
        trace.observation,
        trace.loop_count,
        trace.error_pattern,
        trace.created_at,
      );
    }
  });
  return traces.length;
}

export function getTracesBySession(sessionId: string): TraceRow[] {
  return queryAll(getDb(), 'SELECT * FROM traces WHERE session_id = ? ORDER BY step_index ASC', [
    sessionId,
  ]) as unknown as TraceRow[];
}

// ─── Token 全局统计 ───

export interface SessionTokenStat {
  session_id: string;
  title: string;
  model: string;
  created_at: number;
  total_input: number;
  total_output: number;
  total_duration: number;
  round_count: number;
}

export interface GlobalTokenTotals {
  total_input: number;
  total_output: number;
  total_duration: number;
  total_rounds: number;
  session_count: number;
}

export interface AllSessionsTokenStats {
  sessions: SessionTokenStat[];
  totals: GlobalTokenTotals;
}

export function getAllSessionsTokenStats(): AllSessionsTokenStats {
  const d = getDb();
  const sessionStats = queryAll(
    d,
    `
    SELECT
      s.id as session_id,
      s.title,
      s.model,
      s.created_at,
      COALESCE(SUM(m.prompt_eval_count), 0) as total_input,
      COALESCE(SUM(m.eval_count), 0) as total_output,
      COALESCE(SUM(m.total_duration), 0) as total_duration,
      COUNT(CASE WHEN m.role = 'assistant' AND (m.eval_count IS NOT NULL OR m.prompt_eval_count IS NOT NULL OR m.total_duration IS NOT NULL) THEN 1 END) as round_count
    FROM sessions s
    LEFT JOIN messages m ON s.id = m.session_id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
  `,
  );

  let totalInput = 0,
    totalOutput = 0,
    totalDuration = 0,
    totalRounds = 0;
  for (const s of sessionStats) {
    totalInput += (s.total_input as number) || 0;
    totalOutput += (s.total_output as number) || 0;
    totalDuration += (s.total_duration as number) || 0;
    totalRounds += (s.round_count as number) || 0;
  }

  return {
    sessions: sessionStats as unknown as SessionTokenStat[],
    totals: {
      total_input: totalInput,
      total_output: totalOutput,
      total_duration: totalDuration,
      total_rounds: totalRounds,
      session_count: sessionStats.length,
    },
  };
}

// ─── Export/Import ───

export interface ExportData {
  sessions: SessionRow[];
  messages: MessageRow[];
  settings: Array<{ key: string; value: unknown }>;
  exportedAt: number;
}

const SENSITIVE_SETTING_KEYS = new Set(['searxng_auth_key']);

export function exportAllSessions(): ExportData {
  const d = getDb();
  const sessions = queryAll(d, 'SELECT * FROM sessions') as unknown as SessionRow[];
  const messages = queryAll(d, 'SELECT * FROM messages') as unknown as MessageRow[];
  const settingsRows = queryAll(d, 'SELECT * FROM settings') as unknown as SettingRow[];
  const settings = settingsRows
    .filter((r) => !SENSITIVE_SETTING_KEYS.has(r.key))
    .map((r) => ({
      key: r.key,
      value: (() => {
        try {
          return JSON.parse(r.value);
        } catch {
          return r.value;
        }
      })(),
    }));
  return { sessions, messages, settings, exportedAt: Date.now() };
}

export function importSessions(data: ExportData): { imported: number; skipped: number } {
  const d = getDb();
  let imported = 0;
  let skipped = 0;

  runTransaction(d, () => {
    for (const session of data.sessions) {
      const existing = queryOne(d, 'SELECT id FROM sessions WHERE id = ?', [session.id]);
      if (existing) {
        skipped++;
        continue;
      }
      saveSession(session);
      imported++;
    }
    for (const msg of data.messages) {
      const sessionExists = queryOne(d, 'SELECT id FROM sessions WHERE id = ?', [msg.session_id]);
      if (sessionExists) saveMessage(msg);
    }
    for (const s of data.settings) {
      saveSetting(s.key, s.value);
    }
  });

  return { imported, skipped };
}

// ─── 工具审计日志 ───

export interface ToolAuditRow {
  id: string;
  session_id: string;
  tool_name: string;
  args_json: string | null;
  result_status: string | null;
  result_summary: string | null;
  duration_ms: number | null;
  created_at: number;
}

export function saveToolAudit(audit: Omit<ToolAuditRow, 'id'> & { id?: string }): string {
  const id = audit.id || `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  prepared(
    getDb(),
    `INSERT INTO tool_audit (id, session_id, tool_name, args_json, result_status, result_summary, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    audit.session_id,
    audit.tool_name,
    audit.args_json,
    audit.result_status,
    audit.result_summary,
    audit.duration_ms,
    audit.created_at,
  );
  return id;
}

export function getToolAuditsBySession(sessionId: string): ToolAuditRow[] {
  return queryAll(getDb(), 'SELECT * FROM tool_audit WHERE session_id = ? ORDER BY created_at ASC', [
    sessionId,
  ]) as unknown as ToolAuditRow[];
}

export function getAllToolAudits(limit: number = 200): ToolAuditRow[] {
  return queryAll(getDb(), 'SELECT * FROM tool_audit ORDER BY created_at DESC LIMIT ?', [
    limit,
  ]) as unknown as ToolAuditRow[];
}

// ─── Memory embeddings 缓存（0.18.0 混合记忆检索）───

export interface MemoryEmbeddingRow {
  entry_id: string;
  model: string;
  vector: Uint8Array;
  updated_at: number;
}

export function saveMemoryEmbedding(entryId: string, model: string, vector: number[]): void {
  const buffer = Buffer.from(new Float32Array(vector).buffer);
  prepared(
    getDb(),
    `INSERT OR REPLACE INTO memory_embeddings (entry_id, model, vector, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(entryId, model, buffer, Date.now());
}

export function getMemoryEmbedding(entryId: string, model: string): number[] | null {
  const row = queryOne(getDb(), 'SELECT vector FROM memory_embeddings WHERE entry_id = ? AND model = ?', [
    entryId,
    model,
  ]) as { vector: Uint8Array } | null;
  if (!row?.vector) return null;
  const buf = Buffer.from(row.vector);
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

export function getAllMemoryEmbeddings(model: string): Array<{ entry_id: string; vector: number[] }> {
  const rows = queryAll(getDb(), 'SELECT entry_id, vector FROM memory_embeddings WHERE model = ?', [model]) as Array<{
    entry_id: string;
    vector: Uint8Array;
  }>;
  return rows.map((r) => {
    const buf = Buffer.from(r.vector);
    return {
      entry_id: r.entry_id,
      vector: Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)),
    };
  });
}

export function deleteMemoryEmbedding(entryId: string): void {
  runExec(getDb(), 'DELETE FROM memory_embeddings WHERE entry_id = ?', [entryId]);
}

export function clearMemoryEmbeddings(): void {
  getDb().exec('DELETE FROM memory_embeddings');
}
