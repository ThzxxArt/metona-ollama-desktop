/**
 * Metona Ollama Desktop - SQLite 数据库层
 * v4.1: 替代 better-sqlite3，使用 sql.js (WASM) 无需原生编译
 */

import * as SQL from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ─── sql.js 兼容层 ───
// 封装 sql.js 的 API，提供与 better-sqlite3 相近的接口

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

function runPragma(db: SQL.Database, expr: string): void {
  db.run(`PRAGMA ${expr}`);
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

/** 持久化数据库到磁盘 */
function persist(): void {
  if (!db || !dbPath) return;
  try {
    const data = db.export();
    const buf = Buffer.from(data);
    // 先写临时文件再 rename，避免写一半崩溃导致数据库损坏
    const tmpPath = dbPath + '.tmp';
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, dbPath);
  } catch (err) {
    // 记录到启动日志文件（console.error 会被 main.ts 的 uncaughtException 捕获）
    console.error(`[SQLite persist] 写入失败: ${(err as Error).message}`);
  }
}

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

  // 性能优化
  runPragma(db, 'journal_mode = WAL');
  runPragma(db, 'synchronous = NORMAL');
  runPragma(db, 'foreign_keys = ON');

  // 创建表
  db.run(`
    -- 会话表
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

    -- 消息表
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

    -- 工具调用记录表
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

    -- 设置表
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 执行轨迹表（Agent 可观测性）
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

  `);

  // 兼容迁移：为已有 messages 表补充 attachments 列（文件/视频等附件 JSON）
  try { db.run('ALTER TABLE messages ADD COLUMN attachments TEXT'); } catch { /* 列已存在，忽略 */ }

  // 兼容迁移：为已有 traces 表补充 error_pattern 列
  try { db.run('ALTER TABLE traces ADD COLUMN error_pattern TEXT'); } catch { /* 列已存在，忽略 */ }


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
  persist();
  return session.id;
}

export function getSession(id: string): SessionRow | null {
  return queryOne(getDb(), 'SELECT * FROM sessions WHERE id = ?', [id]) as unknown as SessionRow | null;
}

export function getAllSessions(): SessionRow[] {
  return queryAll(getDb(), 'SELECT * FROM sessions ORDER BY updated_at DESC') as unknown as SessionRow[];
}

export function deleteSession(id: string): void {
  runExec(getDb(), 'DELETE FROM sessions WHERE id = ?', [id]);
  persist();
}

export function clearAllSessions(): void {
  getDb().run('DELETE FROM sessions');
  persist();
}

// ─── Messages CRUD ───

export function saveMessage(msg: MessageRow): string {
  const d = getDb();
  runExec(d, `INSERT OR REPLACE INTO messages (id, session_id, role, content, thinking, images, tool_calls, tool_name, attachments, eval_count, prompt_eval_count, total_duration, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.session_id, msg.role, msg.content, msg.thinking, msg.images,
     msg.tool_calls, msg.tool_name, msg.attachments, msg.eval_count, msg.prompt_eval_count, msg.total_duration, msg.created_at]
  );
  persist();
  return msg.id;
}

export function getMessagesBySession(sessionId: string): MessageRow[] {
  return queryAll(getDb(), 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]) as unknown as MessageRow[];
}


// ─── Settings CRUD ───

export function saveSetting(key: string, value: unknown): void {
  runExec(getDb(), 'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    [key, JSON.stringify(value), Date.now()]
  );
  persist();
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

// ─── Tool Calls CRUD ───

export function saveToolCall(tc: ToolCallRow): string {
  runExec(getDb(), `INSERT OR REPLACE INTO tool_calls (id, message_id, session_id, tool_name, arguments, result, status, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tc.id, tc.message_id, tc.session_id, tc.tool_name, tc.arguments, tc.result, tc.status, tc.duration_ms, tc.created_at]
  );
  persist();
  return tc.id;
}

export function getToolCallsBySession(sessionId: string): ToolCallRow[] {
  return queryAll(getDb(), 'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at ASC', [sessionId]) as unknown as ToolCallRow[];
}

// ─── Traces CRUD ───

export function saveTrace(trace: TraceRow): string {
  runExec(getDb(), `INSERT OR REPLACE INTO traces (id, session_id, step_index, thought, action, action_input, observation, loop_count, error_pattern, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [trace.id, trace.session_id, trace.step_index, trace.thought, trace.action, trace.action_input, trace.observation, trace.loop_count, trace.error_pattern, trace.created_at]
  );
  persist();
  return trace.id;
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
      COUNT(CASE WHEN m.role = 'assistant' AND (m.eval_count > 0 OR m.prompt_eval_count > 0) THEN 1 END) as round_count
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

  persist();
  return { imported, skipped };
}

