/**
 * ChatDB - 存储兼容层
 * v4.0: 桌面端走 IPC → SQLite，Web 端仍用 IndexedDB
 */

import type { ChatSession, MemoryEntry } from '../types.js';

/** 检查是否在桌面环境 */
function isDesktop(): boolean {
  return !!(window as any).metonaDesktop?.isDesktop;
}

/** 桌面端 DB 桥接 */
function dbBridge() {
  return (window as any).metonaDesktop?.db;
}

export class ChatDB {
  private dbName: string;
  private version: number;
  private idb: IDBDatabase | null = null;

  constructor(dbName = 'metona-ollama', version = 2) {
    this.dbName = dbName;
    this.version = version;
  }

  async init(): Promise<void> {
    if (isDesktop()) {
      // 桌面端：SQLite 已在主进程初始化，这里不需要 IndexedDB
      // 但为了数据迁移，仍打开 IndexedDB（只读）
      await this._openIDB();
      return;
    }
    // Web 端：使用 IndexedDB
    await this._openIDB();
  }

  /** 打开 IndexedDB（用于迁移或 Web 端 fallback） */
  private async _openIDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { this.idb = request.result; resolve(); };
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('sessions')) {
          const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' });
          sessionStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          sessionStore.createIndex('model', 'model', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('memories')) {
          const memoryStore = db.createObjectStore('memories', { keyPath: 'id' });
          memoryStore.createIndex('type', 'type', { unique: false });
          memoryStore.createIndex('importance', 'importance', { unique: false });
          memoryStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          memoryStore.createIndex('lastUsedAt', 'lastUsedAt', { unique: false });
        }
      };
    });
  }

  // ── Sessions ──

  async saveSession(session: ChatSession): Promise<string> {
    if (isDesktop()) {
      const row = {
        id: session.id,
        title: session.title,
        model: session.model,
        system_prompt: null,
        parent_id: null,
        status: 'active',
        created_at: session.createdAt,
        updated_at: session.updatedAt
      };
      await dbBridge().saveSession(row);
      // 同步保存消息
      for (const msg of session.messages) {
        const msgRow = {
          id: `${session.id}_${msg.timestamp}_${msg.role}`,
          session_id: session.id,
          role: msg.role,
          content: msg.content || null,
          thinking: msg.think || null,
          images: msg.images?.length ? JSON.stringify(msg.images) : null,
          tool_calls: msg.toolCalls?.length ? JSON.stringify(msg.toolCalls) : null,
          tool_name: null,
          eval_count: msg.eval_count || null,
          total_duration: msg.total_duration || null,
          created_at: msg.timestamp
        };
        await dbBridge().saveMessage(msgRow);
      }
      return session.id;
    }
    return this._idbSaveSession(session);
  }

  async getSession(id: string): Promise<ChatSession | null> {
    if (isDesktop()) {
      const row = await dbBridge().getSession(id);
      if (!row) return null;
      const msgRows = await dbBridge().getMessages(id);
      const messages = msgRows.map((r: any) => ({
        role: r.role,
        content: r.content || '',
        timestamp: r.created_at,
        think: r.thinking || undefined,
        images: r.images ? JSON.parse(r.images) : undefined,
        eval_count: r.eval_count || undefined,
        total_duration: r.total_duration || undefined,
        toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined
      }));
      return {
        id: row.id,
        title: row.title,
        model: row.model,
        messages,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    }
    return this._idbGetSession(id);
  }

  async getAllSessions(): Promise<ChatSession[]> {
    if (isDesktop()) {
      const rows = await dbBridge().getAllSessions();
      const sessions: ChatSession[] = [];
      for (const row of rows) {
        const session = await this.getSession(row.id);
        if (session) sessions.push(session);
      }
      return sessions;
    }
    return this._idbGetAllSessions();
  }

  async deleteSession(id: string): Promise<void> {
    if (isDesktop()) {
      await dbBridge().deleteSession(id);
      return;
    }
    return this._idbDeleteSession(id);
  }

  async clearAll(): Promise<void> {
    if (isDesktop()) {
      await dbBridge().clearAllSessions();
      return;
    }
    return this._idbClearAll();
  }

  async importSessions(sessions: ChatSession[]): Promise<{ imported: number; skipped: number }> {
    if (isDesktop()) {
      const data = {
        sessions: sessions.map(s => ({
          id: s.id, title: s.title, model: s.model, system_prompt: null,
          parent_id: null, status: 'active', created_at: s.createdAt, updated_at: s.updatedAt
        })),
        messages: sessions.flatMap(s => s.messages.map(m => ({
          id: `${s.id}_${m.timestamp}_${m.role}`,
          session_id: s.id, role: m.role, content: m.content || null,
          thinking: m.think || null,
          images: m.images?.length ? JSON.stringify(m.images) : null,
          tool_calls: m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null,
          tool_name: null, eval_count: m.eval_count || null,
          total_duration: m.total_duration || null, created_at: m.timestamp
        }))),
        memories: [],
        settings: [],
        exportedAt: Date.now()
      };
      return dbBridge().importSessions(data);
    }
    return this._idbImportSessions(sessions);
  }

  async getSessionsByTimeRange(startTime: number, endTime: number): Promise<ChatSession[]> {
    const all = await this.getAllSessions();
    return all.filter(s => s.updatedAt >= startTime && s.updatedAt <= endTime);
  }

  // ── Settings ──

  async saveSetting(key: string, value: unknown): Promise<void> {
    if (isDesktop()) {
      await dbBridge().saveSetting(key, value);
      return;
    }
    return this._idbSaveSetting(key, value);
  }

  async getSetting<T = unknown>(key: string, defaultValue: T | null = null): Promise<T> {
    if (isDesktop()) {
      return dbBridge().getSetting(key, defaultValue);
    }
    return this._idbGetSetting(key, defaultValue);
  }

  // ── Memories ──

  async saveMemory(entry: MemoryEntry): Promise<string> {
    if (isDesktop()) {
      const row = {
        id: entry.id,
        type: entry.type,
        content: entry.content,
        importance: entry.importance,
        tags: entry.tags?.length ? JSON.stringify(entry.tags) : null,
        source: entry.source || null,
        session_id: entry.sessionId || null,
        use_count: entry.useCount,
        embedding: entry.embedding ? JSON.stringify(entry.embedding) : null,
        created_at: entry.createdAt,
        updated_at: entry.updatedAt,
        last_used_at: entry.lastUsedAt
      };
      await dbBridge().saveMemory(row);
      return entry.id;
    }
    return this._idbSaveMemory(entry);
  }

  async getMemory(id: string): Promise<MemoryEntry | null> {
    if (isDesktop()) {
      const row = await dbBridge().getMemory(id);
      return row ? this._rowToMemory(row) : null;
    }
    return this._idbGetMemory(id);
  }

  async getAllMemories(): Promise<MemoryEntry[]> {
    if (isDesktop()) {
      const rows = await dbBridge().getAllMemories();
      return rows.map((r: any) => this._rowToMemory(r));
    }
    return this._idbGetAllMemories();
  }

  async getMemoriesByType(type: string): Promise<MemoryEntry[]> {
    if (isDesktop()) {
      const rows = await dbBridge().getMemoriesByType(type);
      return rows.map((r: any) => this._rowToMemory(r));
    }
    return this._idbGetMemoriesByType(type);
  }

  async deleteMemory(id: string): Promise<void> {
    if (isDesktop()) {
      await dbBridge().deleteMemory(id);
      return;
    }
    return this._idbDeleteMemory(id);
  }

  async clearAllMemories(): Promise<void> {
    if (isDesktop()) {
      await dbBridge().clearAllMemories();
      return;
    }
    return this._idbClearAllMemories();
  }

  // ── Helpers ──

  private _rowToMemory(row: any): MemoryEntry {
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      importance: row.importance,
      tags: row.tags ? JSON.parse(row.tags) : [],
      source: row.source || undefined,
      sessionId: row.session_id || undefined,
      useCount: row.use_count,
      embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at
    };
  }

  // ═══════════════════════════════════════════
  // IndexedDB fallback methods (Web 端兼容)
  // ═══════════════════════════════════════════

  private _ensureIDB(): void {
    if (!this.idb) throw new Error('IndexedDB 未初始化');
  }

  private _idbTx(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
    this._ensureIDB();
    return this.idb!.transaction(storeName, mode).objectStore(storeName);
  }

  private async _idbSaveSession(session: ChatSession): Promise<string> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('sessions', 'readwrite');
      const req = store.put(session);
      req.onsuccess = () => resolve(session.id);
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbGetSession(id: string): Promise<ChatSession | null> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('sessions');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbGetAllSessions(): Promise<ChatSession[]> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('sessions');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbDeleteSession(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('sessions', 'readwrite');
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbClearAll(): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('sessions', 'readwrite');
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbImportSessions(sessions: ChatSession[]): Promise<{ imported: number; skipped: number }> {
    return new Promise((resolve, reject) => {
      const tx = this.idb!.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      let imported = 0; let skipped = 0;
      tx.oncomplete = () => resolve({ imported, skipped });
      tx.onerror = () => reject(tx.error);
      for (const session of sessions) {
        if (!session.id || !Array.isArray(session.messages)) { skipped++; continue; }
        const getReq = store.get(session.id);
        getReq.onsuccess = () => {
          if (getReq.result) { skipped++; } else { store.put(session); imported++; }
        };
      }
    });
  }

  private async _idbSaveSetting(key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('settings', 'readwrite');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbGetSetting<T = unknown>(key: string, defaultValue: T | null = null): Promise<T> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('settings');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbSaveMemory(entry: MemoryEntry): Promise<string> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('memories', 'readwrite');
      const req = store.put(entry);
      req.onsuccess = () => resolve(entry.id);
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbGetMemory(id: string): Promise<MemoryEntry | null> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('memories');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbGetAllMemories(): Promise<MemoryEntry[]> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('memories');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbGetMemoriesByType(type: string): Promise<MemoryEntry[]> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('memories');
      const index = store.index('type');
      const req = index.getAll(type);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbDeleteMemory(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('memories', 'readwrite');
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private async _idbClearAllMemories(): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this._idbTx('memories', 'readwrite');
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /** 获取原始 IndexedDB 实例（用于数据迁移） */
  getRawIDB(): IDBDatabase | null {
    return this.idb;
  }
}
