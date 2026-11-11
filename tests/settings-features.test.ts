// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({
  config: {
    provider: 'ollama' as 'ollama' | 'openai' | 'anthropic',
    mode: 'local' as 'local' | 'remote',
    localUrl: 'http://127.0.0.1:11434',
    remoteUrl: 'https://ollama.com',
    openaiUrl: 'https://api.openai.com',
    anthropicUrl: 'https://api.anthropic.com',
    remoteKind: 'cloud' as 'cloud' | 'self-hosted',
    contextLength: 131072,
    remoteAutoUnload: true,
    requestTimeoutMs: 900000,
    hasApiKey: false,
    keyStorageAvailable: true,
  },
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => ''),
  encrypt: vi.fn(async () => new Blob(['encrypted'])),
  decrypt: vi.fn(async () => ({ sessions: [] })),
  writeFile: vi.fn(async () => ({ success: true })),
  readFileBase64: vi.fn(async () => ({ success: true, content: Buffer.from('x').toString('base64') })),
  saveFile: vi.fn(async () => '/tmp/backup.metona'),
  openFile: vi.fn(async () => ['/tmp/backup.metona']),
}));

vi.mock('../src/renderer/components/header.js', () => ({
  checkConnection: vi.fn(async () => true),
  updateConnectionInfo: vi.fn(),
}));
vi.mock('../src/renderer/components/model-bar.js', () => ({
  loadModels: vi.fn(async () => []),
  formatCtxLen: (n: number) => `${n}`,
  clearModelCapabilityCache: vi.fn(),
}));
vi.mock('../src/renderer/components/toast.js', () => ({ showToast: hoisted.toast }));
vi.mock('../src/renderer/services/log-service.js', () => ({
  logSetting: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
}));
vi.mock('../src/renderer/services/crypto.js', () => ({
  encryptData: hoisted.encrypt,
  decryptData: hoisted.decrypt,
}));
vi.mock('../src/renderer/components/prompt-modal.js', () => ({
  showConfirm: hoisted.confirm,
  showPrompt: hoisted.prompt,
}));
vi.mock('../src/renderer/services/context-manager.js', () => ({
  getSessionSummariesBackup: () => [],
  restoreSessionSummariesBackup: vi.fn(),
}));
vi.mock('../src/renderer/services/agent-metrics.js', () => ({
  getMetricsBackup: () => [],
  restoreMetricsBackup: vi.fn(),
}));
vi.mock('../src/renderer/services/agent-engine.js', () => ({
  getTraceFallbackBackup: () => [],
  restoreTraceFallbackBackup: vi.fn(),
}));

import { initConnectionSettings, refreshConnectionSettingsUI } from '../src/renderer/features/settings/connection.js';
import {
  exportAllSessions,
  importSessions,
  populateSubAgentModels,
  populateEmbeddingModels,
} from '../src/renderer/features/settings/data.js';
import { state, KEYS } from '../src/renderer/state/state.js';

const bridge = {
  isDesktop: true,
  ollama: {
    getConfig: vi.fn(async () => hoisted.config),
    setConfig: vi.fn(async (patch: Record<string, unknown>) => {
      hoisted.config = { ...hoisted.config, ...patch } as typeof hoisted.config;
      return hoisted.config;
    }),
    setApiKey: vi.fn(async () => ({ success: true, hasApiKey: true })),
    clearApiKey: vi.fn(async () => ({ success: true, hasApiKey: false })),
    test: vi.fn(async () => ({ ok: true, version: '0.40.16', modelCount: 0, latencyMs: 1 })),
    models: vi.fn(async () => ({ models: [{ name: 'qwen3' }] })),
  },
  dialog: { saveFile: hoisted.saveFile, openFile: hoisted.openFile },
  fs: { writeFile: hoisted.writeFile, readFileBase64: hoisted.readFileBase64 },
  db: {
    getAllSessions: async () => [{ id: 's1', title: 't', model: 'm', messages: [], createdAt: 1, updatedAt: 2 }],
    getSetting: async (_k: string, d: unknown) => d,
    importSessions: vi.fn(async () => ({ imported: 1, skipped: 0 })),
  },
};

function el<T extends HTMLElement>(id: string): T {
  return document.querySelector(`#${id}`) as T;
}

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf-8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';
});

let initialized = false;

beforeEach(() => {
  hoisted.config = {
    provider: 'ollama',
    mode: 'local',
    localUrl: 'http://127.0.0.1:11434',
    remoteUrl: 'https://ollama.com',
    openaiUrl: 'https://api.openai.com',
    anthropicUrl: 'https://api.anthropic.com',
    remoteKind: 'cloud',
    contextLength: 131072,
    remoteAutoUnload: true,
    requestTimeoutMs: 900000,
    hasApiKey: false,
    keyStorageAvailable: true,
  };
  vi.clearAllMocks();
  bridge.db.getAllSessions = async () => [
    { id: 's1', title: 't', model: 'm', messages: [], createdAt: 1, updatedAt: 2 },
  ];
  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = bridge;
  state.set(KEYS.API, {
    refreshConfig: vi.fn(async () => {}),
    listModels: vi.fn(async () => ({ models: [{ name: 'qwen3' }] })),
  });
  state.set(KEYS.DB, bridge.db);
  if (!initialized) {
    initConnectionSettings();
    initialized = true;
  }
});

describe('设置连接面板', () => {
  it('refresh 应用配置到 DOM', async () => {
    await refreshConnectionSettingsUI();
    expect(el<HTMLSelectElement>('selectOllamaMode').value).toBe('local');
    expect(el<HTMLInputElement>('inputServerUrl').value).toBe('http://127.0.0.1:11434');
    expect(el<HTMLInputElement>('inputContextLength').value).toBe('131072');
  });

  it('切换远程并保存模式/地址/卸载偏好', async () => {
    await refreshConnectionSettingsUI();
    el<HTMLSelectElement>('selectOllamaMode').value = 'remote';
    el<HTMLSelectElement>('selectOllamaMode').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    el<HTMLInputElement>('inputServerUrl').value = 'https://ollama.example.com';
    el<HTMLInputElement>('inputServerUrl').dispatchEvent(new Event('input'));
    el<HTMLInputElement>('remoteKindSelf').checked = true;
    el<HTMLInputElement>('remoteKindSelf').dispatchEvent(new Event('change'));
    el<HTMLInputElement>('toggleRemoteUnload').checked = false;
    el<HTMLInputElement>('toggleRemoteUnload').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 600));
    expect(bridge.ollama.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'remote', remoteUrl: 'https://ollama.example.com', remoteKind: 'self-hosted' }),
    );
  });

  it('本地地址保存不重置远程偏好', async () => {
    await refreshConnectionSettingsUI();
    el<HTMLInputElement>('inputServerUrl').value = 'http://localhost:1234';
    el<HTMLInputElement>('inputServerUrl').dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 600));
    const patch = bridge.ollama.setConfig.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(patch).toEqual({ provider: 'ollama', mode: 'local', localUrl: 'http://localhost:1234' });
  });

  it('保存 Key、显示/隐藏、清除', async () => {
    await refreshConnectionSettingsUI();
    el<HTMLSelectElement>('selectOllamaMode').value = 'remote';
    el<HTMLSelectElement>('selectOllamaMode').dispatchEvent(new Event('change'));
    const key = el<HTMLInputElement>('inputApiKey');
    key.value = 'sk-test';
    key.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.ollama.setApiKey).toHaveBeenCalledWith('sk-test');
    el<HTMLButtonElement>('btnToggleApiKey').click();
    expect(key.type).toBe('text');
    el<HTMLButtonElement>('btnClearApiKey').dispatchEvent(new Event('mousedown'));
    el<HTMLButtonElement>('btnClearApiKey').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.ollama.clearApiKey).toHaveBeenCalled();
  });

  it('测试连接前保存 URL 与输入中的 Key', async () => {
    await refreshConnectionSettingsUI();
    el<HTMLInputElement>('inputServerUrl').value = 'http://localhost:9999';
    el<HTMLInputElement>('inputServerUrl').dispatchEvent(new Event('input'));
    el<HTMLInputElement>('inputApiKey').value = 'sk-new';
    el<HTMLButtonElement>('btnTestConnection').dispatchEvent(new Event('mousedown'));
    el<HTMLButtonElement>('btnTestConnection').click();
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.ollama.setApiKey).toHaveBeenCalledWith('sk-new');
    expect(bridge.ollama.test).toHaveBeenCalled();
  });

  it('上下文长度钳制并提示', async () => {
    await refreshConnectionSettingsUI();
    // 等待上一个测试遗留的 debounce 保存结束
    await new Promise((r) => setTimeout(r, 600));
    bridge.ollama.setConfig.mockClear();
    const input = el<HTMLInputElement>('inputContextLength');
    input.value = '1';
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 600));
    expect(bridge.ollama.setConfig).toHaveBeenCalledWith({ contextLength: 1024 });
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('钳制'), 'warning');
  });

  it('safeStorage 不可用时显示警告', async () => {
    hoisted.config.mode = 'remote';
    hoisted.config.remoteKind = 'self-hosted';
    hoisted.config.keyStorageAvailable = false;
    await refreshConnectionSettingsUI();
    expect(el<HTMLElement>('keyStorageWarning').style.display).toBe('');
  });

  it('模式切换、Cloud/自建、HTTP 警告与保存失败', async () => {
    await refreshConnectionSettingsUI();
    el<HTMLSelectElement>('selectOllamaMode').value = 'remote';
    el<HTMLSelectElement>('selectOllamaMode').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    el<HTMLInputElement>('remoteKindCloud').checked = true;
    el<HTMLInputElement>('remoteKindCloud').dispatchEvent(new Event('change'));
    expect(el<HTMLInputElement>('toggleRemoteUnload').disabled).toBe(true);
    expect(el<HTMLElement>('cloudUnloadHint').style.display).toBe('');
    el<HTMLInputElement>('inputServerUrl').value = 'http://remote.test';
    el<HTMLInputElement>('inputServerUrl').dispatchEvent(new Event('input'));
    expect(el<HTMLElement>('remoteHttpWarning').style.display).toBe('');

    bridge.ollama.setConfig.mockRejectedValueOnce(new Error('save failed'));
    el<HTMLInputElement>('inputServerUrl').value = 'https://remote2.test';
    el<HTMLInputElement>('inputServerUrl').dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 600));
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('保存失败'), 'error');
  });

  it('模式切换读取配置失败时保留输入', async () => {
    bridge.ollama.getConfig.mockRejectedValueOnce(new Error('offline'));
    el<HTMLSelectElement>('selectOllamaMode').value = 'remote';
    el<HTMLSelectElement>('selectOllamaMode').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    expect(el<HTMLSelectElement>('selectOllamaMode').value).toBe('remote');
  });

  it('上下文空值/非法值回退默认', async () => {
    await refreshConnectionSettingsUI();
    bridge.ollama.setConfig.mockClear();
    const input = el<HTMLInputElement>('inputContextLength');
    input.value = 'abc';
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 600));
    expect(bridge.ollama.setConfig).toHaveBeenCalledWith({ contextLength: 131072 });
  });

  it('测试连接失败与 Key 保存失败', async () => {
    bridge.ollama.test.mockResolvedValueOnce({ ok: false, error: 'down' });
    el<HTMLButtonElement>('btnTestConnection').click();
    await new Promise((r) => setTimeout(r, 30));
    expect(el<HTMLElement>('connectionTestResult').textContent).toContain('down');

    el<HTMLInputElement>('inputApiKey').value = 'sk-bad';
    bridge.ollama.setApiKey.mockResolvedValueOnce({ success: false, error: 'nope' });
    el<HTMLInputElement>('inputApiKey').dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('保存失败'), 'error');
  });

  it('格式化上下文显示与模型上限提示', async () => {
    hoisted.config.contextLength = 1048576;
    await refreshConnectionSettingsUI();
    expect(el<HTMLElement>('ctxFormatted').textContent).toContain('1M');
    hoisted.config.contextLength = 2048;
    await refreshConnectionSettingsUI();
    expect(el<HTMLElement>('ctxFormatted').textContent).toContain('2K');
    const model = document.querySelector('#modelSelect') as HTMLSelectElement;
    const option = document.createElement('option');
    option.value = 'qwen3';
    option.dataset.contextLength = '32768';
    model.appendChild(option);
    model.value = 'qwen3';
    hoisted.config.contextLength = 131072;
    await refreshConnectionSettingsUI();
    expect(el<HTMLElement>('ctxModelHint').textContent).toContain('模型上限');
  });

  it('Key 空值/回车/显示切换/清除', async () => {
    await refreshConnectionSettingsUI();
    const key = el<HTMLInputElement>('inputApiKey');
    key.type = 'password';
    key.value = '';
    key.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.ollama.setApiKey).not.toHaveBeenCalled();

    key.value = 'sk-enter';
    key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.ollama.setApiKey).toHaveBeenCalledWith('sk-enter');

    el<HTMLButtonElement>('btnToggleApiKey').click();
    expect(key.type).toBe('text');
    el<HTMLButtonElement>('btnToggleApiKey').click();
    expect(key.type).toBe('password');

    el<HTMLButtonElement>('btnClearApiKey').dispatchEvent(new Event('mousedown'));
    el<HTMLButtonElement>('btnClearApiKey').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.ollama.clearApiKey).toHaveBeenCalled();
  });

  it('空 URL 不保存，桥接缺失不抛异常', async () => {
    await refreshConnectionSettingsUI();
    bridge.ollama.setConfig.mockClear();
    el<HTMLInputElement>('inputServerUrl').value = '';
    el<HTMLInputElement>('inputServerUrl').dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 600));
    expect(bridge.ollama.setConfig).not.toHaveBeenCalled();

    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = undefined;
    el<HTMLInputElement>('inputServerUrl').value = 'http://x';
    el<HTMLInputElement>('inputServerUrl').dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('第三方 LLM 设置', () => {
  it('切换 OpenAI 兼容保存独立地址并显示第三方字段', async () => {
    await refreshConnectionSettingsUI();
    const provider = el<HTMLSelectElement>('selectLlmProvider');
    provider.value = 'openai';
    provider.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    expect(el<HTMLInputElement>('inputServerUrl').value).toBe('https://api.openai.com');
    expect(el<HTMLElement>('remoteKindRow').style.display).toBe('none');
    expect(el<HTMLElement>('providerModelRow').style.display).toBe('');

    el<HTMLInputElement>('inputServerUrl').value = 'https://api.deepseek.com';
    el<HTMLInputElement>('inputServerUrl').dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 600));
    expect(bridge.ollama.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', openaiUrl: 'https://api.deepseek.com' }),
    );
  });

  it('第三方 Key 与清除操作携带 provider', async () => {
    await refreshConnectionSettingsUI();
    const provider = el<HTMLSelectElement>('selectLlmProvider');
    provider.value = 'openai';
    provider.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));

    const key = el<HTMLInputElement>('inputApiKey');
    key.value = 'sk-openai';
    key.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.ollama.setApiKey).toHaveBeenCalledWith('sk-openai', 'openai');

    el<HTMLButtonElement>('btnClearApiKey').dispatchEvent(new Event('mousedown'));
    el<HTMLButtonElement>('btnClearApiKey').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.ollama.clearApiKey).toHaveBeenCalledWith('openai');
  });

  it('手动模型名会加入下拉框并选中', async () => {
    await refreshConnectionSettingsUI();
    const provider = el<HTMLSelectElement>('selectLlmProvider');
    provider.value = 'anthropic';
    provider.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));

    const input = el<HTMLInputElement>('inputProviderModel');
    input.value = 'claude-sonnet-4-5';
    el<HTMLButtonElement>('btnApplyProviderModel').click();
    const select = el<HTMLSelectElement>('modelSelect');
    expect(select.value).toBe('claude-sonnet-4-5');
    expect(Array.from(select.options).some((option) => option.value === 'claude-sonnet-4-5')).toBe(true);
  });
});

describe('设置数据功能', () => {
  it('导出会话成功', async () => {
    hoisted.prompt.mockResolvedValueOnce('pw');
    await exportAllSessions();
    expect(hoisted.encrypt).toHaveBeenCalled();
    expect(hoisted.saveFile).toHaveBeenCalled();
    expect(hoisted.writeFile).toHaveBeenCalled();
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('已导出'), 'success');
  });

  it('无会话导出提示 warning', async () => {
    bridge.db.getAllSessions = async () => [];
    await exportAllSessions();
    expect(hoisted.toast).toHaveBeenCalledWith('没有可导出的会话', 'warning');
  });

  it('无密码导出需要二次确认，取消则停止', async () => {
    hoisted.prompt.mockResolvedValueOnce('');
    hoisted.confirm.mockResolvedValueOnce(false);
    await exportAllSessions();
    expect(hoisted.saveFile).not.toHaveBeenCalled();
  });

  it('导入合法备份', async () => {
    await importSessions('/tmp/backup.metona');
    expect(hoisted.decrypt).toHaveBeenCalled();
    expect(bridge.db.importSessions).toHaveBeenCalled();
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('导入完成'), 'success', 4000);
  });

  it('导入扩展名错误/读取失败/内容错误', async () => {
    await importSessions('/tmp/backup.txt');
    expect(hoisted.toast).toHaveBeenCalledWith('仅支持导入 .metona 格式文件', 'error');
    hoisted.readFileBase64.mockResolvedValueOnce({ success: false, error: 'read fail' });
    await importSessions('/tmp/backup.metona');
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('读取文件失败'), 'error');
    hoisted.decrypt.mockResolvedValueOnce({ foo: 1 });
    await importSessions('/tmp/backup.metona');
    expect(hoisted.toast).toHaveBeenCalledWith(expect.stringContaining('未找到会话数据'), 'error');
  });

  it('导入需要密码时提示输入', async () => {
    hoisted.decrypt.mockRejectedValueOnce(new Error('该备份已设置密码'));
    hoisted.prompt.mockResolvedValueOnce('pw');
    await importSessions('/tmp/backup.metona');
    expect(hoisted.prompt).toHaveBeenCalled();
  });

  it('填充子代理/embedding 模型下拉', async () => {
    await populateSubAgentModels();
    expect(el<HTMLSelectElement>('selectSubAgentModel').options.length).toBeGreaterThan(1);
    await populateEmbeddingModels();
    expect(el<HTMLSelectElement>('selectMemoryEmbeddingModel').options.length).toBeGreaterThan(1);
  });
});
