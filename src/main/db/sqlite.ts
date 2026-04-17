/**
 * Metona Ollama Desktop - SQLite 数据库层
 * v4.0: 替代 IndexedDB，使用 better-sqlite3
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';

let db: Database.Database | null = null;

/** 获取数据库实例 */
export function getDb(): Database.Database {
  if (!db) throw new Error('数据库未初始化，请先调用 initDatabase()');
  return db;
}

/** 初始化数据库 */
export function initDatabase(): Database.Database {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'metona.db');
  db = new Database(dbPath);

  // 性能优化
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // 创建表
  db.exec(`
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

    -- 记忆 FTS5 全文搜索
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, tags, type,
      content='memories',
      content_rowid='rowid'
    );

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
  `);

  return db;
}

// ─── Sessions CRUD ───

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

export function saveSession(session: SessionRow): string {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO sessions (id, title, model, system_prompt, parent_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    session.id, session.title, session.model, session.system_prompt, session.parent_id,
    session.status || 'active', session.created_at, session.updated_at
  );
  return session.id;
}

export function getSession(id: string): SessionRow | null {
  const d = getDb();
  return d.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | null;
}

export function getAllSessions(): SessionRow[] {
  const d = getDb();
  return d.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as SessionRow[];
}

export function deleteSession(id: string): void {
  const d = getDb();
  d.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function clearAllSessions(): void {
  const d = getDb();
  d.exec('DELETE FROM sessions');
}

// ─── Messages CRUD ───

export function saveMessage(msg: MessageRow): string {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO messages (id, session_id, role, content, thinking, images, tool_calls, tool_name, eval_count, total_duration, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    msg.id, msg.session_id, msg.role, msg.content, msg.thinking, msg.images,
    msg.tool_calls, msg.tool_name, msg.eval_count, msg.total_duration, msg.created_at
  );
  return msg.id;
}

export function getMessagesBySession(sessionId: string): MessageRow[] {
  const d = getDb();
  return d.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as MessageRow[];
}

export function deleteMessagesBySession(sessionId: string): void {
  const d = getDb();
  d.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
}

// ─── Memories CRUD ───

export function saveMemory(entry: MemoryRow): string {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO memories (id, type, content, importance, tags, source, session_id, use_count, embedding, created_at, updated_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    entry.id, entry.type, entry.content, entry.importance, entry.tags,
    entry.source, entry.session_id, entry.use_count, entry.embedding,
    entry.created_at, entry.updated_at, entry.last_used_at
  );
  // FTS 同步
  try {
    d.prepare("DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE id = ?)").run(entry.id);
    d.prepare("INSERT INTO memories_fts(rowid, content, tags, type) SELECT rowid, content, tags, type FROM memories WHERE id = ?").run(entry.id);
  } catch { /* FTS 同步失败不影响主流程 */ }
  return entry.id;
}

export function getMemory(id: string): MemoryRow | null {
  const d = getDb();
  return d.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | null;
}

export function getAllMemories(): MemoryRow[] {
  const d = getDb();
  return d.prepare('SELECT * FROM memories ORDER BY importance DESC, updated_at DESC').all() as MemoryRow[];
}

export function getMemoriesByType(type: string): MemoryRow[] {
  const d = getDb();
  return d.prepare('SELECT * FROM memories WHERE type = ? ORDER BY importance DESC').all(type) as MemoryRow[];
}

export function deleteMemory(id: string): void {
  const d = getDb();
  try {
    d.prepare("DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE id = ?)").run(id);
  } catch { /* ignore */ }
  d.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function clearAllMemories(): void {
  const d = getDb();
  d.exec('DELETE FROM memories');
  try { d.exec('DELETE FROM memories_fts'); } catch { /* ignore */ }
}

export function searchMemoriesFTS(query: string, limit = 10): MemoryRow[] {
  const d = getDb();
  try {
    // FTS5 搜索
    const ftsQuery = query.replace(/[^\w\u4e00-\u9fff\s]/g, ' ').split(/\s+/).filter(w => w.length > 0).map(w => `"${w}"*`).join(' OR ');
    if (!ftsQuery) return [];
    return d.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as MemoryRow[];
  } catch {
    // FTS 失败回退到 LIKE 搜索
    return d.prepare(`
      SELECT * FROM memories
      WHERE content LIKE ? OR tags LIKE ?
      ORDER BY importance DESC
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit) as MemoryRow[];
  }
}

// ─── Settings CRUD ───

export function saveSetting(key: string, value: unknown): void {
  const d = getDb();
  d.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    key, JSON.stringify(value), Date.now()
  );
}

export function getSetting<T = unknown>(key: string, defaultValue: T | null = null): T {
  const d = getDb();
  const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return defaultValue as T;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

// ─── Tool Calls CRUD ───

export function saveToolCall(tc: ToolCallRow): string {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO tool_calls (id, message_id, session_id, tool_name, arguments, result, status, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    tc.id, tc.message_id, tc.session_id, tc.tool_name, tc.arguments, tc.result, tc.status, tc.duration_ms, tc.created_at
  );
  return tc.id;
}

export function getToolCallsBySession(sessionId: string): ToolCallRow[] {
  const d = getDb();
  return d.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as ToolCallRow[];
}

// ─── Traces CRUD ───

export function saveTrace(trace: TraceRow): string {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO traces (id, session_id, step_index, thought, action, action_input, observation, loop_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    trace.id, trace.session_id, trace.step_index, trace.thought, trace.action, trace.action_input, trace.observation, trace.loop_count, trace.created_at
  );
  return trace.id;
}

export function getTracesBySession(sessionId: string): TraceRow[] {
  const d = getDb();
  return d.prepare('SELECT * FROM traces WHERE session_id = ? ORDER BY step_index ASC').all(sessionId) as TraceRow[];
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
  const sessions = d.prepare('SELECT * FROM sessions').all() as SessionRow[];
  const messages = d.prepare('SELECT * FROM messages').all() as MessageRow[];
  const memories = d.prepare('SELECT * FROM memories').all() as MemoryRow[];
  const settingsRows = d.prepare('SELECT * FROM settings').all() as SettingRow[];
  const settings = settingsRows.map(r => ({ key: r.key, value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })() }));
  return { sessions, messages, memories, settings, exportedAt: Date.now() };
}

export function importSessions(data: ExportData): { imported: number; skipped: number } {
  const d = getDb();
  let imported = 0;
  let skipped = 0;

  const txn = d.transaction(() => {
    for (const session of data.sessions) {
      const existing = d.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id);
      if (existing) { skipped++; continue; }
      saveSession(session);
      imported++;
    }
    for (const msg of data.messages) {
      const sessionExists = d.prepare('SELECT id FROM sessions WHERE id = ?').get(msg.session_id);
      if (sessionExists) saveMessage(msg);
    }
    for (const mem of data.memories) {
      const existing = d.prepare('SELECT id FROM memories WHERE id = ?').get(mem.id);
      if (!existing) saveMemory(mem);
    }
    for (const s of data.settings) {
      saveSetting(s.key, s.value);
    }
  });
  txn();

  return { imported, skipped };
}

// ─── Close ───

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
