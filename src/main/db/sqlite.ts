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
let _hasFTS5 = false;

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
    fs.writeFileSync(dbPath, buf);
  } catch { /* 静默失败，不阻断主流程 */ }
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

    -- 记忆表
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER DEFAULT 5,
      tags TEXT,
      source TEXT,
      session_id TEXT,
      use_count INTEGER DEFAULT 0,
      embedding TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);

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
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id, created_at);

    -- v4.2 技能表（自动从成功工具调用链提取）
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      summary TEXT DEFAULT '',
      trigger_keywords TEXT,
      tool_chain TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      avg_duration_ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_skills_updated ON skills(updated_at DESC);
  `);

  // 兼容迁移：为已有 messages 表补充 prompt_eval_count 列（新库已有，旧库需要 ALTER）
  try { db.run('ALTER TABLE messages ADD COLUMN prompt_eval_count INTEGER'); } catch { /* 列已存在，忽略 */ }

  // 兼容迁移：为已有 skills 表补充 summary 列
  try { db.run("ALTER TABLE skills ADD COLUMN summary TEXT DEFAULT ''"); } catch { /* 列已存在，忽略 */ }

  // 尝试创建 FTS5 全文搜索（可选，sql.js 默认 WASM 可能不包含 FTS5）
  try {
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, tags, type,
        content='memories',
        content_rowid='rowid'
      );
    `);
    _hasFTS5 = true;
  } catch {
    _hasFTS5 = false;
    // FTS5 不可用时降级为 LIKE 搜索，状态通过 _hasFTS5 跟踪
  }

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
  eval_count: number | null;
  prompt_eval_count: number | null;
  total_duration: number | null;
  created_at: number;
}

export interface MemoryRow {
  id: string;
  type: string;
  content: string;
  importance: number;
  tags: string | null;
  source: string | null;
  session_id: string | null;
  use_count: number;
  embedding: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number;
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

// v4.2
export interface SkillRow {
  id: string;
  name: string;
  description: string;
  summary: string;
  trigger_keywords: string | null;
  tool_chain: string;
  success_count: number;
  fail_count: number;
  avg_duration_ms: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
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
  runExec(d, `INSERT OR REPLACE INTO messages (id, session_id, role, content, thinking, images, tool_calls, tool_name, eval_count, prompt_eval_count, total_duration, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.session_id, msg.role, msg.content, msg.thinking, msg.images,
     msg.tool_calls, msg.tool_name, msg.eval_count, msg.prompt_eval_count, msg.total_duration, msg.created_at]
  );
  persist();
  return msg.id;
}

export function getMessagesBySession(sessionId: string): MessageRow[] {
  return queryAll(getDb(), 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]) as unknown as MessageRow[];
}


// ─── Memories CRUD ───

export function saveMemory(entry: MemoryRow): string {
  const d = getDb();
  runExec(d, `INSERT OR REPLACE INTO memories (id, type, content, importance, tags, source, session_id, use_count, embedding, created_at, updated_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.type, entry.content, entry.importance, entry.tags,
     entry.source, entry.session_id, entry.use_count, entry.embedding,
     entry.created_at, entry.updated_at, entry.last_used_at]
  );
  // FTS 同步（仅在 FTS5 可用时）
  if (_hasFTS5) {
    try {
      runExec(d, "DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE id = ?)", [entry.id]);
      runExec(d, "INSERT INTO memories_fts(rowid, content, tags, type) SELECT rowid, content, tags, type FROM memories WHERE id = ?", [entry.id]);
    } catch { /* FTS 同步失败不影响主流程 */ }
  }
  persist();
  return entry.id;
}

export function getMemory(id: string): MemoryRow | null {
  return queryOne(getDb(), 'SELECT * FROM memories WHERE id = ?', [id]) as unknown as MemoryRow | null;
}

export function getAllMemories(): MemoryRow[] {
  return queryAll(getDb(), 'SELECT * FROM memories ORDER BY importance DESC, updated_at DESC') as unknown as MemoryRow[];
}

export function getMemoriesByType(type: string): MemoryRow[] {
  return queryAll(getDb(), 'SELECT * FROM memories WHERE type = ? ORDER BY importance DESC', [type]) as unknown as MemoryRow[];
}

export function deleteMemory(id: string): void {
  const d = getDb();
  if (_hasFTS5) {
    try { runExec(d, "DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE id = ?)", [id]); } catch { /* ignore */ }
  }
  runExec(d, 'DELETE FROM memories WHERE id = ?', [id]);
  persist();
}

export function clearAllMemories(): void {
  const d = getDb();
  d.run('DELETE FROM memories');
  if (_hasFTS5) {
    try { d.run('DELETE FROM memories_fts'); } catch { /* ignore */ }
  }
  persist();
}

export function searchMemoriesFTS(query: string, limit = 10): MemoryRow[] {
  const d = getDb();

  // FTS5 不可用时直接走 LIKE
  if (!_hasFTS5) {
    const likeQ = `%${query.replace(/[^\w\u4e00-\u9fff]/g, '%')}%`;
    return queryAll(d, `
      SELECT * FROM memories
      WHERE content LIKE ? OR tags LIKE ?
      ORDER BY importance DESC
      LIMIT ?
    `, [likeQ, likeQ, limit]) as unknown as MemoryRow[];
  }

  try {
    // FTS5 搜索
    const ftsQuery = query.replace(/[^\w\u4e00-\u9fff\s]/g, ' ').split(/\s+/).filter(w => w.length > 0).map(w => `"${w}"*`).join(' OR ');
    if (!ftsQuery) return [];
    return queryAll(d, `
      SELECT m.* FROM memories m
      JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `, [ftsQuery, limit]) as unknown as MemoryRow[];
  } catch {
    // FTS 失败回退到 LIKE 搜索
    return queryAll(d, `
      SELECT * FROM memories
      WHERE content LIKE ? OR tags LIKE ?
      ORDER BY importance DESC
      LIMIT ?
    `, [`%${query}%`, `%${query}%`, limit]) as unknown as MemoryRow[];
  }
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
  runExec(getDb(), `INSERT OR REPLACE INTO traces (id, session_id, step_index, thought, action, action_input, observation, loop_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [trace.id, trace.session_id, trace.step_index, trace.thought, trace.action, trace.action_input, trace.observation, trace.loop_count, trace.created_at]
  );
  persist();
  return trace.id;
}

export function getTracesBySession(sessionId: string): TraceRow[] {
  return queryAll(getDb(), 'SELECT * FROM traces WHERE session_id = ? ORDER BY step_index ASC', [sessionId]) as unknown as TraceRow[];
}

// ─── Skills CRUD (v4.2) ───

export function saveSkill(skill: SkillRow): string {
  runExec(getDb(), `INSERT OR REPLACE INTO skills (id, name, description, summary, trigger_keywords, tool_chain, success_count, fail_count, avg_duration_ms, created_at, updated_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [skill.id, skill.name, skill.description, skill.summary || '', skill.trigger_keywords, skill.tool_chain,
     skill.success_count, skill.fail_count, skill.avg_duration_ms,
     skill.created_at, skill.updated_at, skill.last_used_at]
  );
  persist();
  return skill.id;
}


export function getAllSkills(): SkillRow[] {
  return queryAll(getDb(), 'SELECT * FROM skills ORDER BY success_count DESC, updated_at DESC') as unknown as SkillRow[];
}

export function deleteSkill(id: string): void {
  runExec(getDb(), 'DELETE FROM skills WHERE id = ?', [id]);
  persist();
}

export function clearAllSkills(): void {
  getDb().run('DELETE FROM skills');
  persist();
}

export function searchSkills(keywords: string, limit = 5): SkillRow[] {
  const likeQ = `%${keywords.replace(/[^\w\u4e00-\u9fff]/g, '%')}%`;
  return queryAll(getDb(), `
    SELECT * FROM skills
    WHERE trigger_keywords LIKE ? OR name LIKE ? OR description LIKE ?
    ORDER BY success_count DESC, updated_at DESC
    LIMIT ?
  `, [likeQ, likeQ, likeQ, limit]) as unknown as SkillRow[];
}

export function incrementSkillUsage(id: string, success: boolean, durationMs: number): void {
  const d = getDb();
  const skill = queryOne(d, 'SELECT success_count, fail_count, avg_duration_ms FROM skills WHERE id = ?', [id]) as any;
  if (!skill) return;

  const newSuccess = success ? skill.success_count + 1 : skill.success_count;
  const newFail = success ? skill.fail_count : skill.fail_count + 1;
  const totalUses = newSuccess + newFail;
  // 指数移动平均
  const alpha = 0.3;
  const newAvg = Math.round(alpha * durationMs + (1 - alpha) * (skill.avg_duration_ms || durationMs));

  runExec(d, `UPDATE skills SET success_count = ?, fail_count = ?, avg_duration_ms = ?, updated_at = ?, last_used_at = ? WHERE id = ?`,
    [newSuccess, newFail, newAvg, Date.now(), Date.now(), id]
  );
  persist();
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
  memories: MemoryRow[];
  settings: Array<{ key: string; value: unknown }>;
  exportedAt: number;
}

export function exportAllSessions(): ExportData {
  const d = getDb();
  const sessions = queryAll(d, 'SELECT * FROM sessions') as unknown as SessionRow[];
  const messages = queryAll(d, 'SELECT * FROM messages') as unknown as MessageRow[];
  const memories = queryAll(d, 'SELECT * FROM memories') as unknown as MemoryRow[];
  const settingsRows = queryAll(d, 'SELECT * FROM settings') as unknown as SettingRow[];
  const settings = settingsRows.map(r => ({ key: r.key, value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })() }));
  return { sessions, messages, memories, settings, exportedAt: Date.now() };
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
    for (const mem of data.memories) {
      const existing = queryOne(d, 'SELECT id FROM memories WHERE id = ?', [mem.id]);
      if (!existing) saveMemory(mem);
    }
    for (const s of data.settings) {
      saveSetting(s.key, s.value);
    }
  });

  persist();
  return { imported, skipped };
}

