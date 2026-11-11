// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state, KEYS } from '../src/renderer/state/state.js';

const hoisted = vi.hoisted(() => ({
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => ''),
  encrypt: vi.fn(async () => new Blob(['x'])),
  decrypt: vi.fn(async () => ({ sessions: [] })),
  writeFile: vi.fn(async () => ({ success: true })),
  readFileBase64: vi.fn(async () => ({ success: true, content: Buffer.from('x').toString('base64') })),
  saveFile: vi.fn(async () => '/tmp/b.metona'),
  restoreSummary: vi.fn(),
  restoreMetrics: vi.fn(),
  restoreTrace: vi.fn(),
}));

vi.mock('../src/renderer/components/toast.js', () => ({ showToast: hoisted.toast }));
vi.mock('../src/renderer/components/prompt-modal.js', () => ({
  showConfirm: hoisted.confirm,
  showPrompt: hoisted.prompt,
}));
vi.mock('../src/renderer/services/crypto.js', () => ({
  encryptData: hoisted.encrypt,
  decryptData: hoisted.decrypt,
}));
vi.mock('../src/renderer/services/log-service.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
}));
vi.mock('../src/renderer/services/context-manager.js', () => ({
  getSessionSummariesBackup: () => [{ id: 'x' }],
  restoreSessionSummariesBackup: hoisted.restoreSummary,
}));
vi.mock('../src/renderer/services/agent-metrics.js', () => ({
  getMetricsBackup: () => [{ id: 'm' }],
  restoreMetricsBackup: hoisted.restoreMetrics,
}));
vi.mock('../src/renderer/services/agent-engine.js', () => ({
  getTraceFallbackBackup: () => [{ id: 't' }],
  restoreTraceFallbackBackup: hoisted.restoreTrace,
}));

import {
  exportAllSessions,
  importSessions,
  populateSubAgentModels,
  populateEmbeddingModels,
} from '../src/renderer/features/settings/data.js';

const db = {
  getAllSessions: vi.fn(async () => [{ id: 's1', title: 't', model: 'm', messages: [], createdAt: 1, updatedAt: 2 }]),
  importSessions: vi.fn(async () => ({ imported: 1, skipped: 0 })),
  getSetting: vi.fn(async (_k: string, d: unknown) => d),
};

function bridge(overrides: Record<string, unknown> = {}) {
  return {
    isDesktop: true,
    dialog: { saveFile: hoisted.saveFile },
    fs: { writeFile: hoisted.writeFile, readFileBase64: hoisted.readFileBase64 },
    db,
    ollama: { listModels: vi.fn(async () => ({ models: [{ name: 'qwen3' }] })) },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.set(KEYS.DB, db);
  state.set(KEYS.API, { listModels: vi.fn(async () => ({ models: [{ name: 'qwen3' }] })) });
  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = bridge();
  db.getAllSessions.mockResolvedValue([{ id: 's1', title: 't', model: 'm', messages: [], createdAt: 1, updatedAt: 2 }]);
  db.importSessions.mockResolvedValue({ imported: 1, skipped: 0 });
  hoisted.decrypt.mockResolvedValue({ sessions: [] });
  hoisted.encrypt.mockResolvedValue(new Blob(['x']));
  hoisted.writeFile.mockResolvedValue({ success: true });
  hoisted.readFileBase64.mockResolvedValue({ success: true, content: Buffer.from('x').toString('base64') });
  hoisted.saveFile.mockResolvedValue('/tmp/b.metona');
  hoisted.prompt.mockResolvedValue('pw');
  hoisted.confirm.mockResolvedValue(true);
});

describe('设置数据分支', () => {
  it('无 DB 直接返回', async () => {
    state.set(KEYS.DB, null);
    await exportAllSessions();
    await importSessions('/tmp/a.metona');
    expect(hoisted.toast).not.toHaveBeenCalled();
  });

  it('导出无会话提示', async () => {
    db.getAllSessions.mockResolvedValueOnce([]);
    await exportAllSessions();
    expect(hoisted.toast).toHaveBeenCalledWith('没有可导出的会话', 'warning');
  });

  it('导出取消密码/无密码取消确认/写盘失败/加密异常', async () => {
    hoisted.prompt.mockResolvedValueOnce(null);
    await exportAllSessions();
    expect(hoisted.saveFile).not.toHaveBeenCalled();

    hoisted.prompt.mockResolvedValueOnce('');
    hoisted.confirm.mockResolvedValueOnce(false);
    await exportAllSessions();
    expect(hoisted.saveFile).not.toHaveBeenCalled();

    hoisted.prompt.mockResolvedValueOnce('pw');
    hoisted.writeFile.mockResolvedValueOnce({ success: false, error: 'disk full' });
    await exportAllSessions();
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('导出失败'), 'error');

    hoisted.prompt.mockResolvedValueOnce('pw');
    hoisted.encrypt.mockRejectedValueOnce(new Error('encrypt fail'));
    await exportAllSessions();
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('导出失败'), 'error');
  });

  it('浏览器回退下载', async () => {
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = undefined;
    const click = vi.fn();
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = createElement(tag) as HTMLElement & { click: () => void };
      if (tag === 'a') el.click = click;
      return el;
    });
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', { ...URL, createObjectURL });
    await exportAllSessions();
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
  });

  it('导入扩展名/桌面桥/读取失败/密码取消/密码重试/内容非法', async () => {
    await importSessions('/tmp/a.txt');
    expect(hoisted.toast).toHaveBeenCalledWith('仅支持导入 .metona 格式文件', 'error');

    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = undefined;
    await importSessions('/tmp/a.metona');
    expect(hoisted.toast).toHaveBeenCalledWith('仅桌面端支持导入', 'warning');

    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = bridge();
    hoisted.readFileBase64.mockResolvedValueOnce({ success: false, error: 'read' });
    await importSessions('/tmp/a.metona');
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('读取文件失败'), 'error');

    hoisted.decrypt.mockRejectedValueOnce(new Error('需要密码'));
    hoisted.prompt.mockResolvedValueOnce(null);
    await importSessions('/tmp/a.metona');
    expect(hoisted.prompt).toHaveBeenCalled();

    hoisted.decrypt.mockRejectedValueOnce(new Error('需要密码'));
    hoisted.prompt.mockResolvedValueOnce('pw');
    hoisted.decrypt.mockResolvedValueOnce({ foo: 1 });
    await importSessions('/tmp/a.metona');
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('未找到会话数据'), 'error');

    hoisted.decrypt.mockRejectedValueOnce(new Error('corrupt'));
    await importSessions('/tmp/a.metona');
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('导入失败'), 'error');
  });

  it('导入数组格式、sessions 格式、跳过数与 localStorage 恢复', async () => {
    hoisted.decrypt.mockResolvedValueOnce([{ id: 's1' }]);
    await importSessions('/tmp/a.metona');
    expect(db.importSessions).toHaveBeenCalled();

    hoisted.decrypt.mockResolvedValueOnce({
      sessions: [{ id: 's1' }],
      sessionSummaries: [{ id: 'x' }],
      metricsHistory: [{ id: 'm' }],
      traceFallback: [{ id: 't' }],
      theme: 'dark',
    });
    db.importSessions.mockResolvedValueOnce({ imported: 1, skipped: 2 });
    await importSessions('/tmp/a.metona');
    expect(hoisted.restoreSummary).toHaveBeenCalled();
    expect(hoisted.restoreMetrics).toHaveBeenCalled();
    expect(hoisted.restoreTrace).toHaveBeenCalled();
    expect(localStorage.getItem('metona-theme')).toBe('dark');
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('跳过 2 个'), 'success', 4000);
  });

  it('模型下拉缺失/无 API/无模型/保存值', async () => {
    document.body.innerHTML = '';
    await populateSubAgentModels();
    await populateEmbeddingModels();

    document.body.innerHTML =
      '<select id="selectSubAgentModel"><option>follow</option></select><select id="selectMemoryEmbeddingModel"><option>none</option></select>';
    state.set(KEYS.API, null);
    await populateSubAgentModels();
    await populateEmbeddingModels();

    state.set(KEYS.API, { listModels: vi.fn(async () => ({ models: [] })) });
    await populateSubAgentModels();
    await populateEmbeddingModels();

    state.set(KEYS.API, { listModels: vi.fn(async () => ({ models: [{ name: 'qwen3' }, { name: 'llama' }] })) });
    db.getSetting.mockResolvedValue('llama');
    await populateSubAgentModels();
    await populateEmbeddingModels();
    expect((document.querySelector('#selectSubAgentModel') as HTMLSelectElement).options.length).toBeGreaterThan(1);
  });
});
