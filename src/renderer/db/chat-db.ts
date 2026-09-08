/**
 * ChatDB - 存储兼容层
 * v4.0: 桌面端走 IPC → SQLite，Web 端仍用 IndexedDB
 */

import type { ChatSession, ChatFile, ChatMessage } from '../types.js';

/** 消息级视频元数据（_videos 字段结构） */
interface VideoMeta { fileName: string; frameCount: number; duration: number }

/** 检查是否在桌面环境 */
function isDesktop(): boolean {
  return !!window.metonaDesktop?.isDesktop;
}

/** 桌面端 DB 桥接（isDesktop 已检查，安全断言非空） */
function dbBridge() {
  const bridge = window.metonaDesktop;
  if (!bridge?.db) {
    throw new Error('DB bridge 不可用：非桌面环境或 SQLite 未初始化');
  }
  return bridge.db;
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

  // P1-P1 修复：追踪已保存的消息 ID，避免每次 saveSession 全量重写所有消息。
  // 0.17.2：按会话追踪 + 差量删除——/undo、/retry、/compress 裁剪掉的消息
  // 同步从 SQLite 删除，防止重载后"复活"或新旧消息交织。
  private _savedIdsBySession = new Map<string, Set<string>>();

  /** 会话消息的持久化 ID（确定性：时间戳+角色+索引，同一消息跨次保存 ID 不变） */
  private _messageRowId(sessionId: string, msg: ChatMessage, index: number): string {
    return `${sessionId}_${msg.timestamp}_${msg.role}_${index}`;
  }

  /** 会话消息行 → SQLite 行（attachments 携带文件/视频/压缩摘要标记） */
  private _messageToRow(sessionId: string, msg: ChatMessage, index: number): Record<string, unknown> {
    return {
      id: this._messageRowId(sessionId, msg, index),
      session_id: sessionId,
      role: msg.role,
      content: msg.content || null,
      thinking: msg.think || null,
      images: msg.images?.length ? JSON.stringify(msg.images) : null,
      tool_calls: msg.toolCalls?.length ? JSON.stringify(msg.toolCalls) : null,
      tool_name: null,
      attachments: JSON.stringify({
        ...(msg.files?.length && { files: msg.files }),
        ...((msg as { _videos?: VideoMeta[] })._videos?.length && { videos: (msg as { _videos?: VideoMeta[] })._videos }),
        ...(msg.compressed && { compressed: true }),
      }),
      eval_count: msg.eval_count || null,
      prompt_eval_count: msg.prompt_eval_count || null,
      total_duration: msg.total_duration || null,
      created_at: msg.timestamp
    };
  }

  /** 解析 attachments JSON（容错） */
  private _parseAttachments(raw: string | null): { files?: ChatFile[]; videos?: Array<{ fileName: string; frameCount: number; duration: number }>; compressed?: boolean } {
    try {
      const a = JSON.parse(raw || '{}');
      return { files: a.files, videos: a.videos, compressed: a.compressed === true };
    } catch {
      return {};
    }
  }

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

      // ── 差量同步：插入新增消息 + 删除被裁剪的消息 ──
      let saved = this._savedIdsBySession.get(session.id);
      if (!saved) {
        // 首次接触该会话（应用重启后 / 加载历史）：以 DB 现有行 ID 为基线，
        // 否则之前运行遗留的已裁剪行无法被 diff 出来
        saved = new Set(await dbBridge().getMessageIds(session.id));
      }

      const currentIds: string[] = [];
      const newMsgs: Array<Record<string, unknown>> = [];
      for (let mi = 0; mi < session.messages.length; mi++) {
        const msg = session.messages[mi];
        const msgId = this._messageRowId(session.id, msg, mi);
        currentIds.push(msgId);
        if (saved.has(msgId)) continue;
        newMsgs.push(this._messageToRow(session.id, msg, mi));
      }

      const currentIdSet = new Set(currentIds);
      const removedIds = [...saved].filter(id => !currentIdSet.has(id));
      let deleteOk = true;
      if (removedIds.length > 0) {
        const delResult = await dbBridge().deleteMessages(session.id, removedIds);
        deleteOk = !delResult || delResult.success !== false;
      }
      if (newMsgs.length > 0) {
        await dbBridge().saveMessagesBatch(newMsgs as never[]);
      }

      if (deleteOk) {
        // 同步成功才提交追踪集
        this._savedIdsBySession.set(session.id, currentIdSet);
      } else {
        // 删除失败：把被删 ID 保留在追踪集中，下次保存时重试差量删除，
        // 否则这些行将永远失去清理机会（重载后"复活"）
        const retrySet = new Set(currentIdSet);
        for (const id of removedIds) retrySet.add(id);
        this._savedIdsBySession.set(session.id, retrySet);
      }
      return session.id;
    }
    return this._idbSaveSession(session);
  }

  /** P1-P1 修复：切换会话时重置已保存消息追踪，释放内存 */
  resetSavedMsgTracking(): void {
    this._savedIdsBySession.clear();
  }

  async getSession(id: string): Promise<ChatSession | null> {
    if (isDesktop()) {
      const row = await dbBridge().getSession(id);
      if (!row) return null;
      const msgRows = await dbBridge().getMessages(id);
      const messages = msgRows.map((r: any) => {
        const att = this._parseAttachments(r.attachments);
        // 旧版 /compress 曾以 role:'system' 存储摘要（不渲染也不进入后续上下文），
        // 读取时归一化为 user + compressed，保存后自愈
        const legacySummary = r.role === 'system';
        return {
          role: legacySummary ? 'user' : r.role,
          content: r.content || '',
          timestamp: r.created_at,
          think: r.thinking || undefined,
          images: r.images ? JSON.parse(r.images) : undefined,
          eval_count: r.eval_count || undefined,
          prompt_eval_count: r.prompt_eval_count || undefined,
          total_duration: r.total_duration || undefined,
          toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
          ...((legacySummary || att.compressed) && { compressed: true as const }),
          ...(att.files?.length && { files: att.files }),
          ...(att.videos?.length && { _videos: att.videos })
        };
      });
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
      // 一次 IPC 取回全部会话+消息行，本地组装（取代 N+1 逐会话往返）
      const data = await dbBridge().getAllSessionsData();
      const bySession = new Map<string, any[]>();
      for (const r of data.messages) {
        if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
        bySession.get(r.session_id)!.push(r);
      }
      const sessions: ChatSession[] = [];
      for (const row of data.sessions) {
        const msgRows = bySession.get(row.id) || [];
        const messages = msgRows.map((r: any) => {
          const att = this._parseAttachments(r.attachments);
          // 与 getSession 一致：旧版 system 摘要行归一化为 user + compressed
          const legacySummary = r.role === 'system';
          return {
            role: legacySummary ? 'user' : r.role,
            content: r.content || '',
            timestamp: r.created_at,
            think: r.thinking || undefined,
            images: r.images ? JSON.parse(r.images) : undefined,
            eval_count: r.eval_count || undefined,
            prompt_eval_count: r.prompt_eval_count || undefined,
            total_duration: r.total_duration || undefined,
            toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
            ...((legacySummary || att.compressed) && { compressed: true as const }),
            ...(att.files?.length && { files: att.files }),
            ...(att.videos?.length && { _videos: att.videos })
          };
        });
        sessions.push({
          id: row.id,
          title: row.title,
          model: row.model,
          messages,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        });
      }
      // 与旧版行为一致：按更新时间倒序
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return sessions;
    }
    return this._idbGetAllSessions();
  }

  /** 会话摘要列表（历史列表/搜索用，不再全量加载消息） */
  async listSessionSummaries(): Promise<Array<{ id: string; title: string; model: string; created_at: number; updated_at: number; message_count: number }>> {
    if (isDesktop()) {
      return dbBridge().getSessionSummaries();
    }
    // Web 端回退：从全量会话派生摘要
    const all = await this.getAllSessions();
    return all.map(s => ({
      id: s.id,
      title: s.title,
      model: s.model,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      message_count: s.messages.length,
    }));
  }

  /** 按标题或消息内容搜索会话（桌面端 SQL LIKE，Web 端本地过滤） */
  async searchSessions(query: string): Promise<Array<{ id: string; title: string; model: string; created_at: number; updated_at: number; message_count: number }>> {
    if (isDesktop()) {
      return dbBridge().searchSessions(query);
    }
    const all = await this.listSessionSummaries();
    const q = query.toLowerCase();
    return all.filter(s => s.title.toLowerCase().includes(q));
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
        messages: sessions.flatMap(s => s.messages.map((m, mi) => ({
          id: `${s.id}_${m.timestamp}_${m.role}_${mi}`,
          session_id: s.id, role: m.role, content: m.content || null,
          thinking: m.think || null,
          images: m.images?.length ? JSON.stringify(m.images) : null,
          tool_calls: m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null,
          tool_name: null,
          // 导入路径同样携带 attachments，避免备份恢复丢失文件/视频/摘要标记
          attachments: JSON.stringify({
            ...(m.files?.length && { files: m.files }),
            ...((m as { _videos?: VideoMeta[] })._videos?.length && { videos: (m as { _videos?: VideoMeta[] })._videos }),
            ...(m.compressed && { compressed: true }),
          }),
          eval_count: m.eval_count || null,
          prompt_eval_count: m.prompt_eval_count || null,
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

  // ── Settings ──

  async saveSetting(key: string, value: unknown): Promise<void> {
    if (isDesktop()) {
      await dbBridge().saveSetting(key, value);
      return;
    }
    return this._idbSaveSetting(key, value);
  }

  /** 批量保存设置（单事务 + 单次刷盘；Web 端逐条写入） */
  async saveSettingsBatch(entries: Array<{ key: string; value: unknown }>): Promise<void> {
    if (isDesktop()) {
      await dbBridge().saveSettingsBatch(entries);
      return;
    }
    for (const { key, value } of entries) {
      await this._idbSaveSetting(key, value);
    }
  }

  async getSetting<T = unknown>(key: string, defaultValue: T | null = null): Promise<T> {
    if (isDesktop()) {
      return dbBridge().getSetting(key, defaultValue) as Promise<T>;
    }
    return this._idbGetSetting(key, defaultValue);
  }

  // ── Helpers ──

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

  /** 获取原始 IndexedDB 实例（用于数据迁移） */
  getRawIDB(): IDBDatabase | null {
    return this.idb;
  }
}
