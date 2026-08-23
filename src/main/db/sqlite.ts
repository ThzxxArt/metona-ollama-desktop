/**
 * Metona Ollama Desktop - SQLite 数据库层
 * 基于 sql.js (WASM 内存库)。
 *
 * 持久化策略：sql.js 是纯内存数据库，db.export() 为全库序列化。
 * 为避免"每次写入都全库写盘"的性能退化，采用防抖落盘：
 * - 写操作只标记脏数据并调度 300ms 防抖刷盘
 * - 应用退出（before-quit）强制刷盘
 * - 崩溃时最多丢失最近 300ms 的写入
 *
 * Schema 版本管理：PRAGMA user_version + 顺序迁移数组。
 */

import * as SQL from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ─── sql.js 兼容层 ───

interface Row { [key: string]: unknown }

function runExec(db: SQL.Database, sql: string, params?: unknown[]): void {
  if (params && params.length) {
    const stmt = db.prepare(sql);
    stmt.bind(params as SQL.BindParams);
    stmt.step();
    stmt.free();
  } else {
    db.run(sql);
  }
}

function queryOne(db: SQL.Database, sql: string, params?: unknown[]): Row | null {
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params as SQL.BindParams);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const row: Row = {};
    cols.forEach((c: string, i: number) => { row[c] = vals[i]; });
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function queryAll(db: SQL.Database, sql: string, params?: unknown[]): Row[] {
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params as SQL.BindParams);
  const cols = stmt.getColumnNames();
  const rows: Row[] = [];
  while (stmt.step()) {
    const vals = stmt.get();
    const row: Row = {};
    cols.forEach((c: string, i: number) => { row[c] = vals[i]; });
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function runTransaction(db: SQL.Database, fn: () => void): void {
  db.run('BEGIN TRANSACTION');
  try {
    fn();
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// ─── 数据库实例 ───

let db: SQL.Database | null = null;
let dbPath: string | null = null;

/** 获取数据库实例 */
export function getDb(): SQL.Database {
  if (!db) throw new Error('数据库未初始化，请先调用 initDatabase()');
  return db;
}

// ─── 防抖持久化 ───

const PERSIST_DEBOUNCE_MS = 300;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _dirty = false;

/** 立即持久化数据库到磁盘（temp 文件 + rename 防崩溃损坏） */
function persist(): void {
  if (!db || !dbPath) return;
  _dirty = false;
  try {
    const data = db.export();
    const buf = Buffer.from(data);
    const tmpPath = dbPath + '.tmp';
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, dbPath);
  } catch (err) {
    _dirty = true;
    console.error(`[SQLite persist] 写入失败: ${(err as Error).message}`);
  }
}

/** 调度防抖刷盘：多次写操作合并为一次全库写盘 */
function schedulePersist(): void {
  _dirty = true;
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    if (_dirty) persist();
  }, PERSIST_DEBOUNCE_MS);
}

/** 强制立即刷盘（应用退出 / 导出前调用） */
export function flushDatabase(): void {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  if (db) persist();
}

// ─── Schema 迁移 ───

/**
 * 顺序迁移数组：MIGRATIONS[v] 将数据库从 user_version=v 升级到 v+1。
 * 新增列/表时只追加迁移项，禁止修改历史迁移。
 */
const MIGRATIONS: Array<(database: SQL.Database) => void> = [
  // v0 → v1：初始表结构
  (database) => {
    database.run(`
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
    `);
  },
  // v1 → v2：消息附件列（历史库通过 ALTER 补列，新库已在 v1 内建）
  (database) => {
    try { database.run('ALTER TABLE messages ADD COLUMN attachments TEXT'); } catch { /* 列已存在 */ }
    try { database.run('ALTER TABLE traces ADD COLUMN error_pattern TEXT'); } catch { /* 列已存在 */ }
  },
];

function applyMigrations(database: SQL.Database): void {
  const row = queryOne(database, 'PRAGMA user_version');
  let current = Number(row?.user_version ?? 0);
  if (Number.isNaN(current)) current = 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    MIGRATIONS[v](database);
  }
  if (current < MIGRATIONS.length || current === 0) {
    database.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }
}

// ─── 初始化 ───

/** 初始化数据库（异步，需加载 WASM） */
export async function initDatabase(): Promise<SQL.Database> {
  if (db) return db;

  // 定位 sql-wasm.wasm 文件（开发时在 node_modules，打包后在 resources）
  const wasmPath = app.isPackaged
    ? path.join(process.resourcesPath, 'sql-wasm.wasm')
    : path.join(app.getAppPath(), 'node_modules/sql.js/dist/sql-wasm.wasm');

  const SQLJS = await SQL.default({
    locateFile: () => wasmPath,
  });
  dbPath = path.join(app.getPath('userData'), 'metona.db');

  // 从磁盘加载已有数据库，或创建新的
  let data: Uint8Array | undefined;
  if (fs.existsSync(dbPath)) {
    data = fs.readFileSync(dbPath);
  }
  db = new SQLJS.Database(data);

  // 外键约束（sql.js 内存库不支持 WAL，journal_mode 设置无实际意义故省略）
  db.run('PRAGMA foreign_keys = ON');

  // Schema 迁移
  applyMigrations(db);

  // 写入一次确保文件存在
  persist();

  return db;
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
  const d = getDb();
  runExec(d, `INSERT OR REPLACE INTO sessions (id, title, model, system_prompt, parent_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [session.id, session.title, session.model, session.system_prompt, session.parent_id,
     session.status || 'active', session.created_at, session.updated_at]
  );
  schedulePersist();
  return session.id;
}

export function getSession(id: string): SessionRow | null {
  return queryOne(getDb(), 'SELECT * FROM sessions WHERE id = ?', [id]) as unknown as SessionRow | null;
}

export function getAllSessions(): SessionRow[] {
  return queryAll(getDb(), 'SELECT * FROM sessions ORDER BY updated_at DESC') as unknown as SessionRow[];
}

/** 会话摘要列表（单条 SQL，避免 N+1 全量加载消息） */
export function getSessionSummaries(): SessionSummaryRow[] {
  return queryAll(getDb(), `
    SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
    FROM sessions s
    ORDER BY s.updated_at DESC
  `) as unknown as SessionSummaryRow[];
}

/** 按标题或消息内容搜索会话（LIKE 转义，返回摘要） */
export function searchSessions(query: string, limit = 200): SessionSummaryRow[] {
  const esc = (s: string): string => s.replace(/[\\%_]/g, m => '\\' + m);
  const pattern = `%${esc(query)}%`;
  return queryAll(getDb(), `
    SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
    FROM sessions s
    WHERE s.title LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\')
    ORDER BY s.updated_at DESC
    LIMIT ?
  `, [pattern, pattern, limit]) as unknown as SessionSummaryRow[];
}

/** 一次性取出全部会话与消息行（导出用，替代渲染端 N+1 IPC 往返） */
export function getAllSessionsData(): { sessions: SessionRow[]; messages: MessageRow[] } {
  const d = getDb();
  return {
    sessions: queryAll(d, 'SELECT * FROM sessions ORDER BY updated_at ASC') as unknown as SessionRow[],
    messages: queryAll(d, 'SELECT * FROM messages ORDER BY created_at ASC') as unknown as MessageRow[],
  };
}

export function deleteSession(id: string): void {
  runExec(getDb(), 'DELETE FROM sessions WHERE id = ?', [id]);
  schedulePersist();
}

export function clearAllSessions(): void {
  getDb().run('DELETE FROM sessions');
  schedulePersist();
}

// ─── Messages CRUD ───

export function saveMessage(msg: MessageRow): string {
  saveMessagesBatch([msg]);
  return msg.id;
}

/** 批量保存消息（单事务 + 单次调度刷盘） */
export function saveMessagesBatch(msgs: MessageRow[]): number {
  if (!msgs.length) return 0;
  const d = getDb();
  runTransaction(d, () => {
    for (const msg of msgs) {
      runExec(d, `INSERT OR REPLACE INTO messages (id, session_id, role, content, thinking, images, tool_calls, tool_name, attachments, eval_count, prompt_eval_count, total_duration, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [msg.id, msg.session_id, msg.role, msg.content, msg.thinking, msg.images,
         msg.tool_calls, msg.tool_name, msg.attachments, msg.eval_count, msg.prompt_eval_count, msg.total_duration, msg.created_at]
      );
    }
  });
  schedulePersist();
  return msgs.length;
}

export function getMessagesBySession(sessionId: string): MessageRow[] {
  return queryAll(getDb(), 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]) as unknown as MessageRow[];
}

// ─── Settings CRUD ───

export function saveSetting(key: string, value: unknown): void {
  runExec(getDb(), 'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    [key, JSON.stringify(value), Date.now()]
  );
  schedulePersist();
}

/** 批量保存设置（单事务 + 单次调度刷盘） */
export function saveSettingsBatch(entries: Array<{ key: string; value: unknown }>): void {
  if (!entries.length) return;
  const d = getDb();
  runTransaction(d, () => {
    for (const { key, value } of entries) {
      runExec(d, 'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        [key, JSON.stringify(value), Date.now()]
      );
    }
  });
  schedulePersist();
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
  runExec(getDb(), `INSERT OR REPLACE INTO traces (id, session_id, step_index, thought, action, action_input, observation, loop_count, error_pattern, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [trace.id, trace.session_id, trace.step_index, trace.thought, trace.action, trace.action_input, trace.observation, trace.loop_count, trace.error_pattern, trace.created_at]
  );
  schedulePersist();
  return trace.id;
}

/** 批量保存轨迹（单事务 + 单次调度刷盘） */
export function saveTracesBatch(traces: TraceRow[]): number {
  if (!traces.length) return 0;
  const d = getDb();
  runTransaction(d, () => {
    for (const trace of traces) {
      runExec(d, `INSERT OR REPLACE INTO traces (id, session_id, step_index, thought, action, action_input, observation, loop_count, error_pattern, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [trace.id, trace.session_id, trace.step_index, trace.thought, trace.action, trace.action_input, trace.observation, trace.loop_count, trace.error_pattern, trace.created_at]
      );
    }
  });
  schedulePersist();
  return traces.length;
}

export function getTracesBySession(sessionId: string): TraceRow[] {
  return queryAll(getDb(), 'SELECT * FROM traces WHERE session_id = ? ORDER BY step_index ASC', [sessionId]) as unknown as TraceRow[];
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
  const sessionStats = queryAll(d, `
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
  `);

  let totalInput = 0, totalOutput = 0, totalDuration = 0, totalRounds = 0;
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
    }
  };
}

// ─── Export/Import ───

export interface ExportData {
  sessions: SessionRow[];
  messages: MessageRow[];
  settings: Array<{ key: string; value: unknown }>;
  exportedAt: number;
}

export function exportAllSessions(): ExportData {
  const d = getDb();
  const sessions = queryAll(d, 'SELECT * FROM sessions') as unknown as SessionRow[];
  const messages = queryAll(d, 'SELECT * FROM messages') as unknown as MessageRow[];
  const settingsRows = queryAll(d, 'SELECT * FROM settings') as unknown as SettingRow[];
  const settings = settingsRows.map(r => ({ key: r.key, value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })() }));
  return { sessions, messages, settings, exportedAt: Date.now() };
}

export function importSessions(data: ExportData): { imported: number; skipped: number } {
  const d = getDb();
  let imported = 0;
  let skipped = 0;

  runTransaction(d, () => {
    for (const session of data.sessions) {
      const existing = queryOne(d, 'SELECT id FROM sessions WHERE id = ?', [session.id]);
      if (existing) { skipped++; continue; }
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

  schedulePersist();
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
  const d = getDb();
  const id = audit.id || `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  runExec(d,
    `INSERT INTO tool_audit (id, session_id, tool_name, args_json, result_status, result_summary, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, audit.session_id, audit.tool_name, audit.args_json, audit.result_status, audit.result_summary, audit.duration_ms, audit.created_at]
  );
  schedulePersist();
  return id;
}

export function getToolAuditsBySession(sessionId: string): ToolAuditRow[] {
  return queryAll(getDb(), 'SELECT * FROM tool_audit WHERE session_id = ? ORDER BY created_at ASC', [sessionId]) as unknown as ToolAuditRow[];
}

export function getAllToolAudits(limit: number = 200): ToolAuditRow[] {
  return queryAll(getDb(), 'SELECT * FROM tool_audit ORDER BY created_at DESC LIMIT ?', [limit]) as unknown as ToolAuditRow[];
}
