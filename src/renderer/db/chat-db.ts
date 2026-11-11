/**
 * ChatDB - 桌面端存储仓储（0.18.0）
 * 只走主进程 node:sqlite；IndexedDB fallback 与旧数据迁移已全部删除。
 */

import type { ChatSession, ChatFile, ChatMessage } from '../types.js';

/** 消息级视频元数据（_videos 字段结构） */
interface VideoMeta { fileName: string; frameCount: number; duration: number }

/** 桌面端 DB 桥接 */
function dbBridge() {
  const bridge = window.metonaDesktop;
  if (!bridge?.db) {
    throw new Error('DB bridge 不可用：请在桌面端运行 Metona');
  }
  return bridge.db;
}

export class ChatDB {
  async init(): Promise<void> {
    // 数据库已在主进程初始化；此处仅确认桥接可用
    dbBridge();
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
      prompt_eval_cached_count: msg.prompt_eval_cached_count || null,
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

  private _rowToMessage(r: Record<string, unknown>): ChatMessage {
    const att = this._parseAttachments((r.attachments as string) || null);
    return {
      role: r.role as ChatMessage['role'],
      content: (r.content as string) || '',
      timestamp: r.created_at as number,
      think: (r.thinking as string) || undefined,
      images: r.images ? JSON.parse(r.images as string) : undefined,
      eval_count: (r.eval_count as number) || undefined,
      prompt_eval_count: (r.prompt_eval_count as number) || undefined,
      prompt_eval_cached_count: (r.prompt_eval_cached_count as number) || undefined,
      total_duration: (r.total_duration as number) || undefined,
      toolCalls: r.tool_calls ? JSON.parse(r.tool_calls as string) : undefined,
      ...(att.compressed && { compressed: true as const }),
      ...(att.files?.length && { files: att.files }),
      ...(att.videos?.length && { _videos: att.videos })
    };
  }

  async saveSession(session: ChatSession): Promise<string> {
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
      this._savedIdsBySession.set(session.id, currentIdSet);
    } else {
      const retrySet = new Set(currentIdSet);
      for (const id of removedIds) retrySet.add(id);
      this._savedIdsBySession.set(session.id, retrySet);
    }
    return session.id;
  }

  resetSavedMsgTracking(): void {
    this._savedIdsBySession.clear();
  }

  async getSession(id: string): Promise<ChatSession | null> {
    const row = await dbBridge().getSession(id);
    if (!row) return null;
    const msgRows = await dbBridge().getMessages(id);
    return {
      id: row.id,
      title: row.title,
      model: row.model,
      messages: msgRows.map(r => this._rowToMessage(r as unknown as Record<string, unknown>)),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async getAllSessions(): Promise<ChatSession[]> {
    const data = await dbBridge().getAllSessionsData();
    const bySession = new Map<string, Array<Record<string, unknown>>>();
    for (const r of data.messages) {
      if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
      bySession.get(r.session_id)!.push(r as unknown as Record<string, unknown>);
    }
    const sessions: ChatSession[] = [];
    for (const row of data.sessions) {
      const msgRows = bySession.get(row.id) || [];
      sessions.push({
        id: row.id,
        title: row.title,
        model: row.model,
        messages: msgRows.map(r => this._rowToMessage(r)),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  }

  async listSessionSummaries(): Promise<Array<{ id: string; title: string; model: string; created_at: number; updated_at: number; message_count: number }>> {
    return dbBridge().getSessionSummaries();
  }

  async searchSessions(query: string): Promise<Array<{ id: string; title: string; model: string; created_at: number; updated_at: number; message_count: number }>> {
    return dbBridge().searchSessions(query);
  }

  async deleteSession(id: string): Promise<void> {
    await dbBridge().deleteSession(id);
  }

  async clearAll(): Promise<void> {
    await dbBridge().clearAllSessions();
  }

  async importSessions(sessions: ChatSession[]): Promise<{ imported: number; skipped: number }> {
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
        attachments: JSON.stringify({
          ...(m.files?.length && { files: m.files }),
          ...((m as { _videos?: VideoMeta[] })._videos?.length && { videos: (m as { _videos?: VideoMeta[] })._videos }),
          ...(m.compressed && { compressed: true }),
        }),
        eval_count: m.eval_count || null,
        prompt_eval_count: m.prompt_eval_count || null,
        prompt_eval_cached_count: m.prompt_eval_cached_count || null,
        total_duration: m.total_duration || null, created_at: m.timestamp
      }))),
      memories: [],
      settings: [],
      exportedAt: Date.now()
    };
    return dbBridge().importSessions(data);
  }

  // ── Settings ──

  async saveSetting(key: string, value: unknown): Promise<void> {
    await dbBridge().saveSetting(key, value);
  }

  async saveSettingsBatch(entries: Array<{ key: string; value: unknown }>): Promise<void> {
    await dbBridge().saveSettingsBatch(entries);
  }

  async getSetting<T = unknown>(key: string, defaultValue: T | null = null): Promise<T> {
    return dbBridge().getSetting(key, defaultValue) as Promise<T>;
  }
}
