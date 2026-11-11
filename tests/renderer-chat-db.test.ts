// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatSession } from '../src/renderer/types.js';

const db = {
  saveSession: vi.fn(async () => ({ success: true, id: 's1' })),
  getSession: vi.fn(async () => null),
  getAllSessionsData: vi.fn(async () => ({ sessions: [], messages: [] })),
  getMessageIds: vi.fn(async () => [] as string[]),
  deleteMessages: vi.fn(async () => ({ success: true })),
  saveMessagesBatch: vi.fn(async () => ({ success: true, count: 1 })),
  getMessages: vi.fn(async () => []),
  getSessionSummaries: vi.fn(async () => []),
  searchSessions: vi.fn(async () => []),
  deleteSession: vi.fn(async () => ({ success: true })),
  clearAllSessions: vi.fn(async () => ({ success: true })),
  importSessions: vi.fn(async () => ({ imported: 1, skipped: 0 })),
  saveSetting: vi.fn(async () => ({ success: true })),
  saveSettingsBatch: vi.fn(async () => ({ success: true })),
  getSetting: vi.fn(async (_k: string, d: unknown) => d),
};

function session(partial: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    title: 't',
    model: 'm',
    messages: [],
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { db };
});

import { ChatDB } from '../src/renderer/db/chat-db.js';

describe('ChatDB 桌面端仓储', () => {
  it('init 确认桥接可用', async () => {
    const repo = new ChatDB();
    await expect(repo.init()).resolves.toBeUndefined();
  });

  it('saveSession 差量插入新消息', async () => {
    db.getMessageIds.mockResolvedValueOnce([]);
    const repo = new ChatDB();
    const s = session({
      messages: [{ role: 'user', content: 'hi', timestamp: 10 }],
    });
    await repo.saveSession(s);
    expect(db.saveSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', title: 't' }));
    expect(db.saveMessagesBatch).toHaveBeenCalledWith([
      expect.objectContaining({ session_id: 's1', role: 'user', content: 'hi' }),
    ]);
  });

  it('saveSession 删除被裁剪消息', async () => {
    db.getMessageIds.mockResolvedValueOnce(['s1_10_user_0', 'old']);
    const repo = new ChatDB();
    await repo.saveSession(session({ messages: [{ role: 'user', content: 'hi', timestamp: 10 }] }));
    expect(db.deleteMessages).toHaveBeenCalledWith('s1', ['old']);
  });

  it('saveSession 删除失败时保留旧 ID 追踪', async () => {
    db.getMessageIds.mockResolvedValueOnce(['old']);
    db.deleteMessages.mockResolvedValueOnce({ success: false });
    const repo = new ChatDB();
    await repo.saveSession(session());
    expect(db.deleteMessages).toHaveBeenCalled();
  });

  it('getSession 映射消息字段', async () => {
    db.getSession.mockResolvedValueOnce({
      id: 's1',
      title: 't',
      model: 'm',
      created_at: 1,
      updated_at: 2,
    });
    db.getMessages.mockResolvedValueOnce([
      {
        id: 'm1',
        session_id: 's1',
        role: 'assistant',
        content: 'hello',
        thinking: 'think',
        images: JSON.stringify(['img']),
        tool_calls: JSON.stringify([{ type: 'function' }]),
        tool_name: null,
        attachments: JSON.stringify({ files: [{ name: 'a' }], videos: [{ fileName: 'v' }], compressed: true }),
        eval_count: 1,
        prompt_eval_count: 2,
        total_duration: 3,
        created_at: 10,
      },
    ]);
    const repo = new ChatDB();
    const s = await repo.getSession('s1');
    expect(s?.messages[0]).toMatchObject({
      content: 'hello',
      think: 'think',
      images: ['img'],
      toolCalls: [{ type: 'function' }],
      compressed: true,
      files: [{ name: 'a' }],
      _videos: [{ fileName: 'v' }],
    });
  });

  it('getSession 不存在返回 null', async () => {
    const repo = new ChatDB();
    await expect(repo.getSession('missing')).resolves.toBeNull();
  });

  it('getAllSessions 聚合消息并按更新时间排序', async () => {
    db.getAllSessionsData.mockResolvedValueOnce({
      sessions: [
        {
          id: 'a',
          title: 'A',
          model: 'm',
          system_prompt: null,
          parent_id: null,
          status: 'active',
          created_at: 1,
          updated_at: 1,
        },
        {
          id: 'b',
          title: 'B',
          model: 'm',
          system_prompt: null,
          parent_id: null,
          status: 'active',
          created_at: 2,
          updated_at: 2,
        },
      ],
      messages: [
        {
          id: 'm1',
          session_id: 'a',
          role: 'user',
          content: 'x',
          thinking: null,
          images: null,
          tool_calls: null,
          tool_name: null,
          attachments: null,
          eval_count: null,
          prompt_eval_count: null,
          total_duration: null,
          created_at: 1,
        },
      ],
    });
    const repo = new ChatDB();
    const sessions = await repo.getAllSessions();
    expect(sessions.map((s) => s.id)).toEqual(['b', 'a']);
    expect(sessions.find((s) => s.id === 'a')?.messages).toHaveLength(1);
  });

  it('列表/搜索/删除/清空透传', async () => {
    const repo = new ChatDB();
    await repo.listSessionSummaries();
    await repo.searchSessions('q');
    await repo.deleteSession('s1');
    await repo.clearAll();
    expect(db.getSessionSummaries).toHaveBeenCalled();
    expect(db.searchSessions).toHaveBeenCalledWith('q');
    expect(db.deleteSession).toHaveBeenCalledWith('s1');
    expect(db.clearAllSessions).toHaveBeenCalled();
  });

  it('importSessions 映射完整消息与附件', async () => {
    const repo = new ChatDB();
    await repo.importSessions([
      session({
        messages: [
          {
            role: 'assistant',
            content: 'hi',
            timestamp: 10,
            think: 't',
            images: ['i'],
            toolCalls: [{ type: 'function' }],
            files: [{ name: 'f' }],
            _videos: [{ fileName: 'v', frameCount: 1, duration: 2 }],
            compressed: true,
            eval_count: 1,
            prompt_eval_count: 2,
            prompt_eval_cached_count: 3,
            total_duration: 4,
          },
        ],
      }),
    ]);
    const data = db.importSessions.mock.calls[0][0] as {
      sessions: unknown[];
      messages: Array<Record<string, unknown>>;
    };
    expect(data.sessions).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'hi',
      prompt_eval_cached_count: 3,
      attachments: expect.stringContaining('videos'),
    });
  });

  it('设置读写透传', async () => {
    const repo = new ChatDB();
    await repo.saveSetting('k', 1);
    await repo.saveSettingsBatch([{ key: 'a', value: 1 }]);
    await expect(repo.getSetting('k', 'd')).resolves.toBe('d');
    expect(db.saveSetting).toHaveBeenCalledWith('k', 1);
    expect(db.saveSettingsBatch).toHaveBeenCalledWith([{ key: 'a', value: 1 }]);
  });

  it('resetSavedMsgTracking 清空追踪', async () => {
    const repo = new ChatDB();
    repo.resetSavedMsgTracking();
    expect(() => repo.resetSavedMsgTracking()).not.toThrow();
  });
});
