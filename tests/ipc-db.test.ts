import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  db: {
    saveSession: vi.fn(() => 's1'),
    getSession: vi.fn(() => ({ id: 's1' })),
    getAllSessions: vi.fn(() => [{ id: 's1' }]),
    deleteSession: vi.fn(),
    clearAllSessions: vi.fn(),
    saveMessage: vi.fn(() => 'm1'),
    saveMessagesBatch: vi.fn(() => 1),
    getMessagesBySession: vi.fn(() => []),
    getMessageIds: vi.fn(() => ['m1']),
    deleteMessages: vi.fn(() => 1),
    getSessionSummaries: vi.fn(() => []),
    searchSessions: vi.fn(() => []),
    getAllSessionsData: vi.fn(() => ({ sessions: [], messages: [] })),
    saveSetting: vi.fn(),
    saveSettingsBatch: vi.fn(),
    getSetting: vi.fn((_k: string, d: unknown) => d),
    saveTrace: vi.fn(() => 't1'),
    saveTracesBatch: vi.fn(() => 1),
    getTracesBySession: vi.fn(() => []),
    exportAllSessions: vi.fn(() => ({ sessions: [], messages: [], settings: [], exportedAt: 1 })),
    importSessions: vi.fn(() => ({ imported: 1, skipped: 0 })),
    getAllSessionsTokenStats: vi.fn(() => ({ sessions: [], totals: {} })),
    saveToolAudit: vi.fn(() => 'a1'),
    getToolAuditsBySession: vi.fn(() => []),
    getAllToolAudits: vi.fn(() => []),
    getAllMemoryEmbeddings: vi.fn(() => []),
    saveMemoryEmbedding: vi.fn(),
    clearMemoryEmbeddings: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, fn),
  },
}));

vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { id: 1, send: vi.fn() }, isDestroyed: () => false },
}));

vi.mock('../src/main/db/sqlite.js', () => hoisted.db);

import { registerDbIPC } from '../src/main/ipc/db.js';

const event = {
  sender: { id: 1, getURL: () => 'file:///index.html' },
  senderFrame: { url: 'file:///index.html' },
};

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = hoisted.handlers.get(channel);
  if (!fn) throw new Error(`missing handler ${channel}`);
  return Promise.resolve(fn(event, ...args));
}

const session = {
  id: 's1',
  title: 't',
  model: 'm',
  system_prompt: null,
  parent_id: null,
  status: 'active',
  created_at: 1,
  updated_at: 2,
};

const message = {
  id: 'm1',
  session_id: 's1',
  role: 'user',
  content: 'hi',
  thinking: null,
  images: null,
  tool_calls: null,
  tool_name: null,
  attachments: null,
  eval_count: 1,
  prompt_eval_count: 2,
  prompt_eval_cached_count: 3,
  total_duration: 4,
  created_at: 5,
};

const trace = {
  id: 't1',
  session_id: 's1',
  step_index: 1,
  thought: 'x',
  action: 'a',
  action_input: '{}',
  observation: 'o',
  loop_count: 1,
  error_pattern: null,
  created_at: 1,
};

beforeEach(() => {
  hoisted.handlers.clear();
  vi.clearAllMocks();
  registerDbIPC();
});

describe('IPC db', () => {
  it('会话 CRUD 成功路径', async () => {
    await expect(invoke('db:saveSession', session)).resolves.toEqual({ success: true, id: 's1' });
    await expect(invoke('db:getSession', 's1')).resolves.toEqual({ id: 's1' });
    await expect(invoke('db:getAllSessions')).resolves.toEqual([{ id: 's1' }]);
    await expect(invoke('db:deleteSession', 's1')).resolves.toEqual({ success: true });
    await expect(invoke('db:clearAllSessions')).resolves.toEqual({ success: true });
  });

  it('会话校验失败返回错误', async () => {
    await expect(invoke('db:saveSession', {})).resolves.toMatchObject({ success: false });
    await expect(invoke('db:getSession', '')).resolves.toBeNull();
    await expect(invoke('db:deleteSession', '')).resolves.toMatchObject({ success: false });
  });

  it('消息 CRUD 与缓存字段', async () => {
    await expect(invoke('db:saveMessage', message)).resolves.toEqual({ success: true, id: 'm1' });
    await expect(invoke('db:saveMessagesBatch', [message])).resolves.toEqual({ success: true, count: 1 });
    await expect(invoke('db:getMessages', 's1')).resolves.toEqual([]);
    await expect(invoke('db:getMessageIds', 's1')).resolves.toEqual(['m1']);
    await expect(invoke('db:deleteMessages', 's1', ['m1'])).resolves.toEqual({ success: true, deleted: 1 });
  });

  it('消息校验失败', async () => {
    await expect(invoke('db:saveMessage', { ...message, role: '' })).resolves.toMatchObject({ success: false });
    await expect(invoke('db:saveMessagesBatch', 'bad')).resolves.toMatchObject({ success: false });
    await expect(invoke('db:getMessages', '')).resolves.toEqual([]);
    await expect(invoke('db:deleteMessages', 's1', 'bad')).resolves.toMatchObject({ success: false });
  });

  it('摘要/搜索/全量数据', async () => {
    await expect(invoke('db:getSessionSummaries')).resolves.toEqual([]);
    await expect(invoke('db:searchSessions', 'q')).resolves.toEqual([]);
    await expect(invoke('db:getAllSessionsData')).resolves.toEqual({ sessions: [], messages: [] });
  });

  it('设置读写与批量', async () => {
    await expect(invoke('db:saveSetting', 'k', 1)).resolves.toEqual({ success: true });
    await expect(invoke('db:saveSettingsBatch', [{ key: 'k', value: 1 }])).resolves.toEqual({ success: true });
    await expect(invoke('db:getSetting', 'k', 'd')).resolves.toBe('d');
    await expect(invoke('db:saveSetting', '', 1)).resolves.toMatchObject({ success: false });
  });

  it('轨迹读写', async () => {
    await expect(invoke('db:saveTrace', trace)).resolves.toEqual({ success: true, id: 't1' });
    await expect(invoke('db:saveTracesBatch', [trace])).resolves.toEqual({ success: true, count: 1 });
    await expect(invoke('db:getTraces', 's1')).resolves.toEqual([]);
    await expect(invoke('db:saveTrace', {})).resolves.toMatchObject({ success: false });
  });

  it('导出/导入', async () => {
    const data = { sessions: [session], messages: [message], settings: [], exportedAt: 1 };
    await expect(invoke('db:exportSessions')).resolves.toMatchObject({ sessions: [] });
    await expect(invoke('db:importSessions', data)).resolves.toEqual({ imported: 1, skipped: 0 });
    await expect(invoke('db:importSessions', {})).rejects.toThrow();
  });

  it('Token 统计/审计/embedding', async () => {
    await expect(invoke('db:getAllTokenStats')).resolves.toMatchObject({ sessions: [] });
    await expect(
      invoke('db:saveToolAudit', {
        session_id: 's1',
        tool_name: 'x',
        args_json: '{}',
        result_status: 'success',
        result_summary: 'ok',
        duration_ms: 1,
        created_at: 1,
      }),
    ).resolves.toEqual({ success: true, id: 'a1' });
    await expect(invoke('db:getToolAudits', 's1')).resolves.toEqual({ success: true, audits: [] });
    await expect(invoke('db:getAllToolAudits', 10)).resolves.toEqual({ success: true, audits: [] });
    await expect(invoke('db:getMemoryEmbeddings', 'nomic')).resolves.toEqual([]);
    await expect(invoke('db:saveMemoryEmbedding', 'e1', 'nomic', [1, 2])).resolves.toEqual({ success: true });
    await expect(invoke('db:clearMemoryEmbeddings')).resolves.toEqual({ success: true });
  });

  it('审计/embedding 校验失败', async () => {
    await expect(invoke('db:saveToolAudit', {})).resolves.toMatchObject({ success: false });
    await expect(invoke('db:getToolAudits', '')).resolves.toMatchObject({ success: false });
    await expect(invoke('db:getAllToolAudits', 0)).resolves.toMatchObject({ success: false });
    await expect(invoke('db:saveMemoryEmbedding', '', 'm', [1])).resolves.toMatchObject({ success: false });
    await expect(invoke('db:saveMemoryEmbedding', 'e', 'm', [])).resolves.toMatchObject({ success: false });
  });

  it('数据库异常被捕获为错误返回', async () => {
    hoisted.db.getAllSessions.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(invoke('db:getAllSessions')).resolves.toEqual([]);
    hoisted.db.getSessionSummaries.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(invoke('db:getSessionSummaries')).resolves.toEqual([]);
    hoisted.db.searchSessions.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(invoke('db:searchSessions', 'q')).resolves.toEqual([]);
    hoisted.db.getAllSessionsData.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(invoke('db:getAllSessionsData')).resolves.toEqual({ sessions: [], messages: [] });
    hoisted.db.exportAllSessions.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(invoke('db:exportSessions')).resolves.toBeNull();
    hoisted.db.getAllSessionsTokenStats.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(invoke('db:getAllTokenStats')).resolves.toBeNull();
  });
});
