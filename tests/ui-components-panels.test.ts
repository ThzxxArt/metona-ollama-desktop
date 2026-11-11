// @vitest-environment jsdom
/**
 * UI 组件测试（面板）：settings-modal / memory-modal / searxng-modal /
 * token-dashboard / metrics-dashboard
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const noop = () => {};

const hoisted = vi.hoisted(() => ({
  toast: vi.fn(),
  showConfirm: vi.fn(async () => true),
  showPrompt: vi.fn(async () => ''),
  refreshConnectionSettingsUI: vi.fn(async () => {}),
  initConnectionSettings: vi.fn(),
  exportAllSessions: vi.fn(async () => {}),
  importSessions: vi.fn(async () => {}),
  populateSubAgentModels: vi.fn(async () => {}),
  populateEmbeddingModels: vi.fn(async () => {}),
  checkConnection: vi.fn(async () => true),
  updateConnectionInfo: vi.fn(async () => {}),
  updateRunningModels: vi.fn(async () => {}),
  refreshMCPTools: vi.fn(async () => {}),
  getMCPServers: vi.fn(async () => [] as Array<Record<string, unknown>>),
  getMCPServerStatuses: vi.fn(async () => [] as Array<Record<string, unknown>>),
  toggleMCPServer: vi.fn(async () => {}),
  removeMCPServer: vi.fn(async () => {}),
  addMCPServer: vi.fn(async () => {}),
  loadAllEntries: vi.fn(async () => [] as Array<Record<string, unknown>>),
  addEntry: vi.fn(async () => ({})),
  removeEntryById: vi.fn(async () => ({ success: true, message: 'ok' })),
  initMemoryFile: vi.fn(async () => ({ action: 'ok' })),
  getMetricsHistory: vi.fn(() => [] as Array<Record<string, unknown>>),
  aggregateMetrics: vi.fn(() => ({
    totalSessions: 0,
    avgIterationsPerTask: 0,
    toolSuccessRate: 0,
    frequentErrors: [],
    tokenEfficiency: 0,
    collectedAt: 0,
  })),
  generateImprovementSuggestions: vi.fn(() => [] as Array<Record<string, unknown>>),
  exportMetricsJSON: vi.fn(() => '{"metrics":true}'),
  exportMetricsPrometheus: vi.fn(() => 'metona_sessions_total 0\n'),
  estimateTokens: vi.fn((s: string) => Math.ceil((s || '').length / 4)),
  effectiveCtx: 131072,
  modelCtx: 0,
  mediaMatches: false,
  saveSetting: vi.fn(async () => {}),
  saveSettingsBatch: vi.fn(async () => {}),
  getSetting: vi.fn(async (_key: string, def: unknown) => def),
  getAllSessions: vi.fn(async () => [] as unknown[]),
  clearAll: vi.fn(async () => {}),
  importSessionsDb: vi.fn(async () => ({ imported: 0, skipped: 0 })),
  getAllTokenStats: vi.fn(async () => null as unknown),
  getConfig: vi.fn(async () => ({
    mode: 'local',
    localUrl: 'http://127.0.0.1:11434',
    remoteUrl: 'https://ollama.com',
    remoteKind: 'cloud',
    contextLength: 131072,
    remoteAutoUnload: true,
    requestTimeoutMs: 900000,
    hasApiKey: false,
    keyStorageAvailable: true,
  })),
  getWorkspaceDir: vi.fn(async () => ({ dir: '/tmp/ws', defaultDir: '/tmp/ws' })),
  setWorkspaceDir: vi.fn(async () => ({ success: true, dir: '/tmp/ws2' })),
  openDirectory: vi.fn(async () => null as string[] | null),
  openFile: vi.fn(async () => null as string[] | null),
  saveFile: vi.fn(async () => '/tmp/out.json' as string | null),
  writeFile: vi.fn(async () => ({ success: true })),
  setTimeouts: vi.fn(async () => {}),
  unloadModels: vi.fn(async () => ({ success: true, unloaded: 2 })),
}));

vi.mock('../src/renderer/services/log-service.js', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logSession: vi.fn(),
  logWarn: vi.fn(),
  logSuccess: vi.fn(),
  logStream: vi.fn(),
  logSetting: vi.fn(),
  logConnection: vi.fn(),
  logModel: vi.fn(),
  logToolStart: vi.fn(),
  logToolResult: vi.fn(),
  logMemory: vi.fn(),
  logRAG: vi.fn(),
  logInit: vi.fn(),
  logThink: vi.fn(),
  logAgentLoop: vi.fn(),
  logModelResponse: vi.fn(),
  resetStreamProgress: vi.fn(),
  logStreamProgress: vi.fn(),
  resetVideoProgress: vi.fn(),
  updateVideoProgress: vi.fn(),
  addLog: vi.fn(),
  initLogPanel: vi.fn(),
}));

vi.mock('../src/renderer/components/toast.js', () => ({ showToast: hoisted.toast }));
vi.mock('../src/renderer/components/prompt-modal.js', () => ({
  showConfirm: hoisted.showConfirm,
  showPrompt: hoisted.showPrompt,
  showHtmlConfirm: hoisted.showConfirm,
}));
vi.mock('../src/renderer/components/header.js', () => ({
  checkConnection: hoisted.checkConnection,
  updateConnectionInfo: hoisted.updateConnectionInfo,
  updateRunningModels: hoisted.updateRunningModels,
}));
vi.mock('../src/renderer/features/settings/connection.js', () => ({
  initConnectionSettings: hoisted.initConnectionSettings,
  refreshConnectionSettingsUI: hoisted.refreshConnectionSettingsUI,
}));
vi.mock('../src/renderer/features/settings/data.js', () => ({
  exportAllSessions: hoisted.exportAllSessions,
  importSessions: hoisted.importSessions,
  populateSubAgentModels: hoisted.populateSubAgentModels,
  populateEmbeddingModels: hoisted.populateEmbeddingModels,
}));
vi.mock('../src/renderer/services/mcp-client.js', () => ({
  getMCPServers: hoisted.getMCPServers,
  getMCPServerStatuses: hoisted.getMCPServerStatuses,
  toggleMCPServer: hoisted.toggleMCPServer,
  removeMCPServer: hoisted.removeMCPServer,
  addMCPServer: hoisted.addMCPServer,
  startAllMCPServers: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/services/tool-registry.js', () => ({
  refreshMCPTools: hoisted.refreshMCPTools,
  getToolIcon: (n: string) => n,
  formatToolName: (n: string) => n,
  TOOL_DEFINITIONS: [],
  MODE_TOOLS: [],
  setToolMode: vi.fn(),
}));
vi.mock('../src/renderer/services/memory-service.js', () => ({
  loadAllEntries: hoisted.loadAllEntries,
  addEntry: hoisted.addEntry,
  removeEntryById: hoisted.removeEntryById,
  initMemoryFile: hoisted.initMemoryFile,
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor() {
      super('duplicate');
      this.name = 'DuplicateEntryError';
    }
  },
}));
vi.mock('../src/renderer/services/agent-metrics.js', () => ({
  getMetricsHistory: hoisted.getMetricsHistory,
  aggregateMetrics: hoisted.aggregateMetrics,
  generateImprovementSuggestions: hoisted.generateImprovementSuggestions,
  exportMetricsJSON: hoisted.exportMetricsJSON,
  exportMetricsPrometheus: hoisted.exportMetricsPrometheus,
  setAppVersion: vi.fn(),
  loadMetricsHistory: vi.fn(),
}));
vi.mock('../src/renderer/components/model-bar.js', () => ({
  getEffectiveNumCtx: () => hoisted.effectiveCtx,
  getModelContextLength: () => hoisted.modelCtx,
  getSelectedModel: () => 'test-model',
  formatCtxLen: (n: number) => `${n}`,
  clearModelCapabilityCache: vi.fn(),
  loadModels: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/services/context-manager.js', () => ({
  estimateTokens: hoisted.estimateTokens,
}));

import { initSettingsModal, openSettingsModal, closeSettingsModal } from '../src/renderer/components/settings-modal.js';
import { initMemoryModal, openMemoryModal, closeMemoryModal } from '../src/renderer/components/memory-modal.js';
import {
  initSearxngModal,
  loadSearxngConfig,
  closeSearxngModal,
  searxngConfig,
} from '../src/renderer/components/searxng-modal.js';
import {
  initTokenDashboard,
  openTokenDashboard,
  closeTokenDashboard,
} from '../src/renderer/components/token-dashboard.js';
import { initMetricsDashboard } from '../src/renderer/components/metrics-dashboard.js';
import { state, KEYS } from '../src/renderer/state/state.js';
import type { ChatSession, ChatMessage } from '../src/renderer/types.js';

function el<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}

function makeSession(messages: ChatMessage[] = [], overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    title: '测试会话',
    model: 'test-model',
    messages,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  } as ChatSession;
}

function msg(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, timestamp: 1700000001000, ...extra } as ChatMessage;
}

function memoryEntry(
  id: string,
  type: string,
  content: string,
  importance: number,
  tags: string[] = [],
): Record<string, unknown> {
  return { id, type, content, importance, tags };
}

function globalStats(sessions: Array<Record<string, unknown>>) {
  const totals = sessions.reduce(
    (acc, s) => {
      acc.total_input += Number(s.total_input || 0);
      acc.total_output += Number(s.total_output || 0);
      acc.total_duration += Number(s.total_duration || 0);
      acc.total_rounds += Number(s.round_count || 0);
      return acc;
    },
    { total_input: 0, total_output: 0, total_duration: 0, total_rounds: 0, session_count: sessions.length },
  );
  return { sessions, totals };
}

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf-8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';

  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: hoisted.mediaMatches,
    addEventListener: noop,
    removeEventListener: noop,
  })) as unknown as typeof window.matchMedia;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame;
  window.scrollTo = noop;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
    escape: (s: string) => s.replace(/["\\]/g, '\\$&'),
  };

  // index.html 缺少设置面板的子代理权限下拉与 Metrics 导出按钮：
  // 组件通过可选查询绑定，这里补上 DOM 以覆盖对应分支。
  const perm = document.createElement('select');
  perm.id = 'selectSubAgentPermission';
  perm.innerHTML =
    '<option value="readonly">只读</option><option value="limited_write">有限写入</option><option value="full_write">完整写入</option>';
  document.querySelector('#settingsModal .modal-body')!.appendChild(perm);

  const metricsBody = document.querySelector('#metricsDashboardModal .modal-body')!;
  const exportJson = document.createElement('button');
  exportJson.id = 'btnExportMetricsJson';
  exportJson.textContent = 'JSON';
  const exportProm = document.createElement('button');
  exportProm.id = 'btnExportMetricsPrometheus';
  exportProm.textContent = 'Prometheus';
  metricsBody.appendChild(exportJson);
  metricsBody.appendChild(exportProm);

  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = '#FAF7F2';
  document.head.appendChild(meta);

  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = {
    isDesktop: true,
    ollama: {
      getConfig: hoisted.getConfig,
      setConfig: vi.fn(async (p: unknown) => ({ ...(await hoisted.getConfig()), ...(p as object) })),
      setApiKey: vi.fn(async () => ({ success: true })),
      clearApiKey: vi.fn(async () => ({ success: true })),
      test: vi.fn(async () => ({ ok: true })),
      unload: vi.fn(async () => ({ success: true })),
    },
    workspace: { getDir: hoisted.getWorkspaceDir, setDir: hoisted.setWorkspaceDir },
    dialog: { openDirectory: hoisted.openDirectory, openFile: hoisted.openFile, saveFile: hoisted.saveFile },
    fs: { writeFile: hoisted.writeFile },
    tool: { setTimeouts: hoisted.setTimeouts },
    db: { getAllTokenStats: hoisted.getAllTokenStats },
  };

  initSettingsModal();
  initMemoryModal();
  initSearxngModal();
  initTokenDashboard();
  initMetricsDashboard();
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.mediaMatches = false;
  hoisted.effectiveCtx = 131072;
  hoisted.modelCtx = 0;
  hoisted.getSetting.mockImplementation(async (_key: string, def: unknown) => def);
  hoisted.getWorkspaceDir.mockResolvedValue({ dir: '/tmp/ws', defaultDir: '/tmp/ws' });
  hoisted.setWorkspaceDir.mockResolvedValue({ success: true, dir: '/tmp/ws2' });
  hoisted.openDirectory.mockResolvedValue(null);
  hoisted.openFile.mockResolvedValue(null);
  hoisted.saveFile.mockResolvedValue('/tmp/out.json');
  hoisted.writeFile.mockResolvedValue({ success: true });
  hoisted.getAllTokenStats.mockResolvedValue(null);
  hoisted.loadAllEntries.mockResolvedValue([]);
  hoisted.getMCPServers.mockResolvedValue([]);
  hoisted.getMCPServerStatuses.mockResolvedValue([]);
  hoisted.getMetricsHistory.mockReturnValue([]);
  hoisted.aggregateMetrics.mockReturnValue({
    totalSessions: 0,
    avgIterationsPerTask: 0,
    toolSuccessRate: 0,
    frequentErrors: [],
    tokenEfficiency: 0,
    collectedAt: 0,
  });
  hoisted.generateImprovementSuggestions.mockReturnValue([]);
  hoisted.showConfirm.mockResolvedValue(true);
  hoisted.showPrompt.mockResolvedValue('');

  state.set(KEYS.DB, {
    getSetting: hoisted.getSetting,
    saveSetting: hoisted.saveSetting,
    saveSettingsBatch: hoisted.saveSettingsBatch,
    getAllSessions: hoisted.getAllSessions,
    clearAll: hoisted.clearAll,
    importSessions: hoisted.importSessionsDb,
  } as never);
  state.set(KEYS.API, { unloadModels: hoisted.unloadModels } as never);
  state.set(KEYS.CURRENT_SESSION, makeSession());
  state.set(KEYS.IS_STREAMING, false);
  state.set(KEYS.NUM_CTX, 131072);
  state.set('connection', { mode: 'local' });

  Object.assign(searxngConfig, {
    enabled: false,
    url: '',
    engines: '',
    language: 'zh-CN',
    safesearch: 1,
    time_range: '',
    max_results: 0,
    auth_key: '',
    auth_type: 'bearer',
    format: 'json',
    fetch_count: 0,
    fetch_mode: 'sequential',
  });

  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#FAF7F2');
  el('#settingsModal').style.display = 'none';
  el('#memoryModal').style.display = 'none';
  el('#searxngModal').style.display = 'none';
  el('#tokenDashboardModal').style.display = 'none';
  el('#metricsDashboardModal').style.display = 'none';
  el('#toastContainer').innerHTML = '';
  el<HTMLInputElement>('#inputMaxTurns').value = '85';
  el<HTMLInputElement>('#inputHttpTimeout').value = '';
  el<HTMLInputElement>('#inputStreamTimeout').value = '';
  el<HTMLInputElement>('#inputMCPTimeout').value = '';
  el<HTMLInputElement>('#inputSubAgentMaxLoops').value = '';
  el<HTMLInputElement>('#inputSubAgentTimeout').value = '';
  el<HTMLInputElement>('#inputLoopWatchdog').value = '';
  el<HTMLInputElement>('#inputMCPName').value = '';
  el<HTMLInputElement>('#inputMCPCommand').value = '';
  el<HTMLInputElement>('#inputMCPArgs').value = '';
  el<HTMLSelectElement>('#selectTheme').value = 'auto';
  el<HTMLSelectElement>('#selectSubAgentPermission').value = 'readonly';
  el<HTMLSelectElement>('#selectSubAgentModel').value = '';
  el<HTMLSelectElement>('#selectMemoryEmbeddingModel').value = '';
  el<HTMLInputElement>('#toggleMemoryEmbedding').checked = false;
  el<HTMLInputElement>('#toggleCheckUpdates').checked = true;
  el<HTMLInputElement>('#searxngUrl').value = '';
  el<HTMLSelectElement>('#searxngFormat').value = 'json';
  el<HTMLInputElement>('#toggleSearxngEnabled').checked = false;
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────── settings-modal ───────────────────────────

describe('settings-modal 打开/主题', () => {
  it('打开面板刷新连接、运行模型、超时、看门狗、主题与工作空间', async () => {
    hoisted.getSetting.mockImplementation(async (key: string, def: unknown) => {
      if (key === 'httpTimeout') return 10;
      if (key === 'streamTimeout') return 0;
      if (key === 'mcpTimeout') return -1;
      if (key === 'loopWatchdogMs') return 90000;
      if (key === 'checkUpdates') return false;
      return def;
    });
    localStorage.setItem('metona-theme', 'dark');
    el('#btnSettings').click();
    await new Promise((r) => setTimeout(r, 20));

    expect(el('#settingsModal').style.display).toBe('');
    expect(hoisted.refreshConnectionSettingsUI).toHaveBeenCalled();
    expect(hoisted.updateConnectionInfo).toHaveBeenCalled();
    expect(hoisted.updateRunningModels).toHaveBeenCalled();
    expect(hoisted.populateSubAgentModels).toHaveBeenCalled();
    expect(hoisted.populateEmbeddingModels).toHaveBeenCalled();
    expect(el<HTMLInputElement>('#inputHttpTimeout').value).toBe('10');
    expect(el<HTMLInputElement>('#inputStreamTimeout').value).toBe('0');
    expect(el<HTMLInputElement>('#inputMCPTimeout').value).toBe('');
    expect(el<HTMLInputElement>('#inputLoopWatchdog').value).toBe('2');
    expect(el<HTMLSelectElement>('#selectTheme').value).toBe('dark');
    expect(el<HTMLInputElement>('#inputWorkspaceDir').value).toBe('/tmp/ws');
    expect(el<HTMLInputElement>('#toggleCheckUpdates').checked).toBe(false);
  });

  it('关闭按钮、遮罩关闭，无 bridge 时打开不抛异常', () => {
    openSettingsModal();
    el('#btnCloseSettings').click();
    expect(el('#settingsModal').style.display).toBe('none');
    openSettingsModal();
    el('#settingsModal').click();
    expect(el('#settingsModal').style.display).toBe('none');
    closeSettingsModal();
    expect(el('#settingsModal').style.display).toBe('none');

    const bridge = (window as unknown as { metonaDesktop?: unknown }).metonaDesktop;
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = undefined;
    expect(() => openSettingsModal()).not.toThrow();
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = bridge;
  });

  it('主题切换写入 localStorage/DOM/数据库', async () => {
    const select = el<HTMLSelectElement>('#selectTheme');
    select.value = 'dark';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(localStorage.getItem('metona-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#1A1B26');
    expect(hoisted.saveSetting).toHaveBeenCalledWith('themeMode', 'dark');

    select.value = 'light';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#FAF7F2');

    hoisted.mediaMatches = true;
    select.value = 'auto';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(hoisted.saveSetting).toHaveBeenCalledWith('themeMode', 'auto');
  });
});

describe('settings-modal 参数保存', () => {
  it('Agent 最大轮数 debounce 保存与默认值', async () => {
    vi.useFakeTimers();
    const input = el<HTMLInputElement>('#inputMaxTurns');
    input.value = '42';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('maxTurns')).toBe(42);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('maxTurns', 42);

    input.value = '';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('maxTurns')).toBe(85);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('maxTurns', 85);
  });

  it('HTTP/流式/MCP 超时保存、默认值与禁用', async () => {
    vi.useFakeTimers();
    const http = el<HTMLInputElement>('#inputHttpTimeout');
    http.value = '5';
    http.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('httpTimeout', 5);
    expect(hoisted.setTimeouts).toHaveBeenCalledWith({ http: 5000 });

    http.value = '';
    http.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('httpTimeout', -1);
    expect(hoisted.setTimeouts).toHaveBeenCalledWith({ http: 900000 });

    http.value = '0';
    http.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('httpTimeout', 0);
    expect(hoisted.setTimeouts).toHaveBeenCalledWith({ http: 0 });

    const stream = el<HTMLInputElement>('#inputStreamTimeout');
    stream.value = '7';
    stream.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('streamTimeout')).toBe(7000);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('streamTimeout', 7);
    stream.value = '';
    stream.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('streamTimeout')).toBe(-1);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('streamTimeout', -1);

    const mcp = el<HTMLInputElement>('#inputMCPTimeout');
    mcp.value = '3';
    mcp.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(hoisted.setTimeouts).toHaveBeenCalledWith({ mcp: 3000 });
    mcp.value = '';
    mcp.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(hoisted.setTimeouts).toHaveBeenCalledWith({ mcp: 60000 });
    expect(hoisted.saveSetting).toHaveBeenCalledWith('mcpTimeout', -1);
  });

  it('子代理轮次/超时与看门狗保存', async () => {
    vi.useFakeTimers();
    const loops = el<HTMLInputElement>('#inputSubAgentMaxLoops');
    loops.value = '5';
    loops.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('subAgentMaxLoops')).toBe(5);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('subAgentMaxLoops', 5);
    loops.value = '';
    loops.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('subAgentMaxLoops')).toBe(10);

    const timeout = el<HTMLInputElement>('#inputSubAgentTimeout');
    timeout.value = '9';
    timeout.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('subAgentTimeout')).toBe(9000);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('subAgentTimeout', 9);
    timeout.value = '0';
    timeout.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('subAgentTimeout')).toBe(0);
    timeout.value = '';
    timeout.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('subAgentTimeout')).toBe(300000);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('subAgentTimeout', -1);

    const watchdog = el<HTMLInputElement>('#inputLoopWatchdog');
    watchdog.value = '2';
    watchdog.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('loopWatchdogMs')).toBe(120000);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('loopWatchdogMs', 120000);
    watchdog.value = '0';
    watchdog.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('loopWatchdogMs')).toBe(0);
    watchdog.value = '';
    watchdog.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(600);
    expect(state.get('loopWatchdogMs')).toBe(1800000);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('loopWatchdogMs', 1800000);
  });

  it('子代理权限/模型、记忆 embedding、更新检查切换', async () => {
    const perm = el<HTMLSelectElement>('#selectSubAgentPermission');
    perm.value = 'full_write';
    perm.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.get('subAgentMaxPermission')).toBe('full_write');
    expect(hoisted.saveSetting).toHaveBeenCalledWith('subAgentMaxPermission', 'full_write');

    const model = el<HTMLSelectElement>('#selectSubAgentModel');
    model.innerHTML = '<option value="">跟随</option><option value="fast">fast</option>';
    model.value = 'fast';
    model.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.saveSetting).toHaveBeenCalledWith('subAgentModel', 'fast');

    const embedding = el<HTMLInputElement>('#toggleMemoryEmbedding');
    embedding.checked = true;
    embedding.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.get('memoryEmbeddingEnabled')).toBe(true);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('memoryEmbeddingEnabled', true);

    const embeddingModel = el<HTMLSelectElement>('#selectMemoryEmbeddingModel');
    embeddingModel.innerHTML = '<option value="">无</option><option value="nomic">nomic</option>';
    embeddingModel.value = 'nomic';
    embeddingModel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.get('memoryEmbeddingModel')).toBe('nomic');
    expect(hoisted.saveSetting).toHaveBeenCalledWith('memoryEmbeddingModel', 'nomic');

    const updates = el<HTMLInputElement>('#toggleCheckUpdates');
    updates.checked = false;
    updates.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.saveSetting).toHaveBeenCalledWith('checkUpdates', false);
  });

  it('auto 主题在系统亮色下回退 light', async () => {
    hoisted.mediaMatches = false;
    const select = el<HTMLSelectElement>('#selectTheme');
    select.value = 'auto';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('无数据库时各设置保存与加载安全返回', async () => {
    state.set(KEYS.DB, null);
    const model = el<HTMLSelectElement>('#selectSubAgentModel');
    model.innerHTML = '<option value="x">x</option>';
    model.value = 'x';
    model.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));

    const embeddingModel = el<HTMLSelectElement>('#selectMemoryEmbeddingModel');
    embeddingModel.innerHTML = '<option value="">无</option>';
    embeddingModel.value = '';
    embeddingModel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));

    const updates = el<HTMLInputElement>('#toggleCheckUpdates');
    updates.checked = true;
    updates.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));

    expect(() => openSettingsModal()).not.toThrow();
  });

  it('看门狗 -1 显示空，输入框缺失时跳过', async () => {
    hoisted.getSetting.mockImplementation(async (key: string, def: unknown) => {
      if (key === 'loopWatchdogMs') return -1;
      return def;
    });
    openSettingsModal();
    await new Promise((r) => setTimeout(r, 10));
    expect(el<HTMLInputElement>('#inputLoopWatchdog').value).toBe('');

    const input = el<HTMLInputElement>('#inputLoopWatchdog');
    const parent = input.parentElement!;
    input.remove();
    hoisted.getSetting.mockImplementation(async (key: string, def: unknown) => {
      if (key === 'loopWatchdogMs') return 60000;
      return def;
    });
    openSettingsModal();
    await new Promise((r) => setTimeout(r, 10));
    expect(() => openSettingsModal()).not.toThrow();
    parent.appendChild(input);
  });
});

describe('settings-modal 显存/数据/工作空间/MCP', () => {
  it('释放显存：未连接、Cloud、远程取消、成功/失败/异常', async () => {
    state.set(KEYS.API, null);
    el('#btnReleaseVRAM').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('Ollama API 未连接', 'warning');

    state.set(KEYS.API, { unloadModels: hoisted.unloadModels });
    state.set('connection', { mode: 'remote', remoteKind: 'cloud' });
    el('#btnReleaseVRAM').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('Ollama Cloud 模型由服务端管理，不支持本地卸载', 'warning');

    state.set('connection', { mode: 'remote', remoteKind: 'self-hosted' });
    hoisted.showConfirm.mockResolvedValueOnce(false);
    el('#btnReleaseVRAM').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.unloadModels).not.toHaveBeenCalled();

    state.set('connection', { mode: 'local' });
    hoisted.unloadModels.mockResolvedValueOnce({ success: true, unloaded: 2 });
    el('#btnReleaseVRAM').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('已释放 2 个模型', 'success');
    expect(hoisted.updateRunningModels).toHaveBeenCalled();

    hoisted.unloadModels.mockResolvedValueOnce({ success: true, unloaded: 0 });
    el('#btnReleaseVRAM').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('没有运行中的模型', 'success');

    hoisted.unloadModels.mockResolvedValueOnce({ success: false, error: 'boom' });
    el('#btnReleaseVRAM').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('释放失败: boom', 'error');

    hoisted.unloadModels.mockRejectedValueOnce(new Error('network'));
    el('#btnReleaseVRAM').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('释放失败: network', 'error');
  });

  it('清空历史：无 DB、取消、确认', async () => {
    state.set(KEYS.DB, null);
    el('#btnClearAllHistory').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('数据库未就绪', 'warning');

    state.set(KEYS.DB, { clearAll: hoisted.clearAll } as never);
    hoisted.showConfirm.mockResolvedValueOnce(false);
    el('#btnClearAllHistory').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.clearAll).not.toHaveBeenCalled();

    const newChatSpy = vi.fn();
    el('#btnNewChat').addEventListener('click', newChatSpy);
    el('#btnClearAllHistory').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.clearAll).toHaveBeenCalled();
    expect(newChatSpy).toHaveBeenCalled();
    expect(hoisted.toast).toHaveBeenCalledWith('已清空所有历史记录', 'success');
    el('#btnNewChat').removeEventListener('click', newChatSpy);
  });

  it('导出全部与导入会话', async () => {
    el('#btnExportAll').click();
    expect(hoisted.exportAllSessions).toHaveBeenCalled();

    hoisted.openFile.mockResolvedValueOnce(['/tmp/backup.metona']);
    el('#btnImportSessions').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.openFile).toHaveBeenCalledWith({
      filters: [{ name: 'Metona 备份', extensions: ['metona'] }],
    });
    expect(hoisted.importSessions).toHaveBeenCalledWith('/tmp/backup.metona');

    hoisted.openFile.mockResolvedValueOnce([]);
    el('#btnImportSessions').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.importSessions).toHaveBeenCalledTimes(1);
  });

  it('工作空间目录：浏览、双击解锁、失焦保存成功/失败/空值', async () => {
    const input = el<HTMLInputElement>('#inputWorkspaceDir');
    openSettingsModal();
    await new Promise((r) => setTimeout(r, 10));
    expect(input.value).toBe('/tmp/ws');
    expect(input.hasAttribute('readonly')).toBe(true);

    const events: string[] = [];
    const onDir = (e: Event) => events.push((e as CustomEvent).detail.dir);
    window.addEventListener('workspaceDirChanged', onDir);
    hoisted.openDirectory.mockResolvedValueOnce(['/tmp/newdir']);
    hoisted.setWorkspaceDir.mockResolvedValueOnce({ success: true, dir: '/tmp/newdir' });
    el('#btnBrowseWorkspace').click();
    await new Promise((r) => setTimeout(r, 30));
    expect(input.value).toBe('/tmp/newdir');
    expect(hoisted.setWorkspaceDir).toHaveBeenCalledWith('/tmp/newdir');
    expect(hoisted.toast).toHaveBeenCalledWith('工作空间目录已更新', 'success');
    expect(events).toContain('/tmp/newdir');

    input.dispatchEvent(new MouseEvent('dblclick'));
    expect(input.hasAttribute('readonly')).toBe(false);
    input.value = '/tmp/manual';
    input.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 10));
    expect(input.hasAttribute('readonly')).toBe(true);
    expect(hoisted.setWorkspaceDir).toHaveBeenCalledWith('/tmp/manual');

    hoisted.setWorkspaceDir.mockResolvedValueOnce({ success: false, error: 'denied' });
    hoisted.getWorkspaceDir.mockResolvedValueOnce({ dir: '/tmp/original', defaultDir: '/tmp/original' });
    input.value = '/tmp/bad';
    input.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('设置失败: denied', 'error');
    expect(input.value).toBe('/tmp/original');

    hoisted.setWorkspaceDir.mockClear();
    input.value = '   ';
    input.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.setWorkspaceDir).not.toHaveBeenCalled();
    window.removeEventListener('workspaceDirChanged', onDir);
  });

  it('MCP 列表：空、运行状态、切换与删除', async () => {
    vi.useFakeTimers();
    hoisted.getMCPServers.mockResolvedValue([
      { name: 's1', command: 'npx', args: ['a', 'b'], enabled: true },
      { name: 's2', command: 'node', args: [], enabled: false },
    ]);
    hoisted.getMCPServerStatuses.mockResolvedValue([{ name: 's1', running: true, toolCount: 3 }]);
    el('#btnSettings').click();
    await vi.advanceTimersByTimeAsync(150);
    const list = el('#mcpServerList');
    expect(list.textContent).toContain('s1');
    expect(list.textContent).toContain('npx a b (3 工具)');
    expect(list.textContent).toContain('s2');
    expect(list.querySelectorAll('.mcp-toggle').length).toBe(2);
    expect(list.querySelector('.mcp-toggle')?.textContent).toBe('禁用');

    (list.querySelector('.mcp-toggle') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(20);
    expect(hoisted.toggleMCPServer).toHaveBeenCalledWith('s1');
    expect(hoisted.refreshMCPTools).toHaveBeenCalled();

    (el('#mcpServerList').querySelector('.mcp-delete') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(20);
    expect(hoisted.removeMCPServer).toHaveBeenCalledWith('s1');

    hoisted.getMCPServers.mockResolvedValue([]);
    el('#btnSettings').click();
    await vi.advanceTimersByTimeAsync(150);
    expect(el('#mcpServerList').textContent).toContain('未配置 MCP 服务器');
  });

  it('添加 MCP 服务器：校验与成功清空输入', async () => {
    el('#btnAddMCPServer').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('请填写名称和命令', 'warning');
    expect(hoisted.addMCPServer).not.toHaveBeenCalled();

    el<HTMLInputElement>('#inputMCPName').value = 'my-mcp';
    el<HTMLInputElement>('#inputMCPCommand').value = 'npx';
    el<HTMLInputElement>('#inputMCPArgs').value = ' -y   pkg  ';
    el('#btnAddMCPServer').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.addMCPServer).toHaveBeenCalledWith({
      name: 'my-mcp',
      command: 'npx',
      args: ['-y', 'pkg'],
      enabled: true,
    });
    expect(hoisted.refreshMCPTools).toHaveBeenCalled();
    expect(el<HTMLInputElement>('#inputMCPName').value).toBe('');
    expect(el<HTMLInputElement>('#inputMCPCommand').value).toBe('');
    expect(el<HTMLInputElement>('#inputMCPArgs').value).toBe('');
    expect(hoisted.toast).toHaveBeenCalledWith('MCP 服务器已添加: my-mcp', 'success');
  });

  it('添加 MCP 空参数、导入取消、浏览取消与 connection 为空', async () => {
    el<HTMLInputElement>('#inputMCPName').value = 'n';
    el<HTMLInputElement>('#inputMCPCommand').value = 'c';
    el<HTMLInputElement>('#inputMCPArgs').value = '';
    el('#btnAddMCPServer').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.addMCPServer).toHaveBeenCalledWith({ name: 'n', command: 'c', args: [], enabled: true });

    hoisted.openFile.mockResolvedValueOnce(null);
    el('#btnImportSessions').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.importSessions).not.toHaveBeenCalled();

    hoisted.openDirectory.mockResolvedValueOnce(null);
    el('#btnBrowseWorkspace').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.setWorkspaceDir).not.toHaveBeenCalled();

    state.set('connection', null);
    hoisted.getConfig.mockResolvedValueOnce({
      mode: 'remote',
      remoteKind: 'cloud',
      localUrl: '',
      remoteUrl: '',
      contextLength: 1,
      remoteAutoUnload: true,
      requestTimeoutMs: 1,
      hasApiKey: false,
      keyStorageAvailable: true,
    });
    state.set(KEYS.API, { unloadModels: hoisted.unloadModels });
    el('#btnReleaseVRAM').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('Ollama Cloud 模型由服务端管理，不支持本地卸载', 'warning');
  });
});

// ─────────────────────────── memory-modal ───────────────────────────

describe('memory-modal', () => {
  it('空记忆与加载失败', async () => {
    hoisted.loadAllEntries.mockResolvedValueOnce([]);
    el('#btnMemory').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#memoryModal').style.display).toBe('');
    expect(el('#memoryListSimple').textContent).toContain('暂无记忆');
    expect(el('#memoryFooterSimple').textContent).toContain('在对话中让 AI');

    hoisted.loadAllEntries.mockRejectedValueOnce(new Error('read fail'));
    await openMemoryModal();
    expect(el('#memoryListSimple').textContent).toContain('加载失败: read fail');
    closeMemoryModal();
    expect(el('#memoryModal').style.display).toBe('none');
    el('#btnCloseMemoryModal').click();
    expect(el('#memoryModal').style.display).toBe('none');
    openMemoryModal();
    el('#memoryModal').click();
    expect(el('#memoryModal').style.display).toBe('none');
  });

  it('按类型分组渲染、星级、标签与转义', async () => {
    hoisted.loadAllEntries.mockResolvedValueOnce([
      memoryEntry('mem_1', 'rule', '规则 <b>', 3, ['安全']),
      memoryEntry('mem_2', 'preference', '偏好B', 12),
      memoryEntry('mem_3', 'fact', '事实C', 1),
    ]);
    await openMemoryModal();
    const html = el('#memoryListSimple');
    expect(html.textContent).toContain('📏 规则 (1)');
    expect(html.textContent).toContain('⚙️ 偏好 (1)');
    expect(html.textContent).toContain('📌 事实 (1)');
    expect(html.querySelector('b')).toBeNull();
    expect(html.textContent).toContain('规则 <b>');
    expect(html.textContent).toContain('★★★');
    expect(html.textContent).toContain('🏷 安全');
    expect(html.textContent).toContain('mem_2');
    expect(el('#memoryFooterSimple').textContent).toContain('共 3 条记忆');
    closeMemoryModal();
  });

  it('删除记忆：确认/取消', async () => {
    hoisted.loadAllEntries.mockResolvedValue([memoryEntry('mem_1', 'fact', '要删除', 5)]);
    await openMemoryModal();
    hoisted.showConfirm.mockResolvedValueOnce(false);
    (el('#memoryListSimple .memory-item-delete') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.removeEntryById).not.toHaveBeenCalled();

    hoisted.showConfirm.mockResolvedValueOnce(true);
    (el('#memoryListSimple .memory-item-delete') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.removeEntryById).toHaveBeenCalledWith('mem_1');
    expect(hoisted.toast).toHaveBeenCalledWith('记忆已删除', 'info', 1500);
  });

  it('添加记忆：类型/内容/重要性、取消与空内容', async () => {
    hoisted.loadAllEntries.mockResolvedValue([]);
    await openMemoryModal();
    hoisted.showPrompt
      .mockResolvedValueOnce('preference')
      .mockResolvedValueOnce('  新记忆内容  ')
      .mockResolvedValueOnce('99');
    el('#btnAddMemoryLg').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.addEntry).toHaveBeenCalledWith('preference', '新记忆内容', 10);
    expect(hoisted.toast).toHaveBeenCalledWith('记忆已添加', 'success', 1500);

    hoisted.showPrompt.mockResolvedValueOnce(null);
    el('#btnAddMemoryLg').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.addEntry).toHaveBeenCalledTimes(1);

    hoisted.showPrompt.mockResolvedValueOnce('fact').mockResolvedValueOnce('   ');
    el('#btnAddMemoryLg').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.addEntry).toHaveBeenCalledTimes(1);

    hoisted.showPrompt.mockResolvedValueOnce('fact').mockResolvedValueOnce('内容').mockResolvedValueOnce('abc');
    el('#btnAddMemoryLg').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.addEntry).toHaveBeenCalledWith('fact', '内容', 5);
  });

  it('重复与失败提示', async () => {
    hoisted.loadAllEntries.mockResolvedValue([]);
    await openMemoryModal();
    const { DuplicateEntryError } = await import('../src/renderer/services/memory-service.js');
    hoisted.showPrompt.mockResolvedValueOnce('fact').mockResolvedValueOnce('重复内容').mockResolvedValueOnce('5');
    hoisted.addEntry.mockRejectedValueOnce(new (DuplicateEntryError as new () => Error)());
    el('#btnAddMemoryLg').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.toast).toHaveBeenCalledWith('该记忆已存在，无需重复添加', 'info', 2000);

    hoisted.showPrompt.mockResolvedValueOnce('fact').mockResolvedValueOnce('失败内容').mockResolvedValueOnce('5');
    hoisted.addEntry.mockRejectedValueOnce(new Error('disk full'));
    el('#btnAddMemoryLg').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.toast).toHaveBeenCalledWith('添加失败: disk full', 'error');
  });
});

// ─────────────────────────── searxng-modal ───────────────────────────

describe('searxng-modal', () => {
  it('loadSearxngConfig 加载字段并刷新启用 UI', async () => {
    hoisted.getSetting.mockImplementation(async (key: string, def: unknown) => {
      const values: Record<string, unknown> = {
        searxng_enabled: true,
        searxng_url: 'https://s.example.com',
        searxng_engines: 'google,bing',
        searxng_language: 'en',
        searxng_safesearch: 2,
        searxng_time_range: 'week',
        searxng_max_results: 10,
        searxng_auth_key: 'key',
        searxng_auth_type: 'basic',
        searxng_format: 'json',
        fetch_count: 3,
        fetch_mode: 'random',
      };
      return key in values ? values[key] : def;
    });
    await loadSearxngConfig(state.get(KEYS.DB) as never);
    expect(searxngConfig.enabled).toBe(true);
    expect(searxngConfig.url).toBe('https://s.example.com');
    expect(searxngConfig.fetch_mode).toBe('random');
    expect(el('#searxngBadge').textContent).toBe('🟢 已启用');
    expect(el('#searxngIconDot').className).toContain('enabled');
    expect(el<HTMLInputElement>('#toggleSearxngEnabled').checked).toBe(true);
  });

  it('打开同步表单、关闭按钮/遮罩/外部关闭', async () => {
    searxngConfig.url = 'https://s.example.com';
    searxngConfig.engines = 'google';
    searxngConfig.language = 'en';
    searxngConfig.safesearch = 2;
    searxngConfig.time_range = 'day';
    searxngConfig.max_results = 5;
    searxngConfig.auth_key = 'k';
    searxngConfig.auth_type = 'basic';
    searxngConfig.format = 'html';
    searxngConfig.fetch_count = 2;
    searxngConfig.fetch_mode = 'random';
    searxngConfig.enabled = true;
    hoisted.getSetting.mockImplementation(async (key: string, def: unknown) => {
      const values: Record<string, unknown> = {
        searxng_enabled: true,
        searxng_url: 'https://s.example.com',
        searxng_engines: 'google',
        searxng_language: 'en',
        searxng_safesearch: 2,
        searxng_time_range: 'day',
        searxng_max_results: 5,
        searxng_auth_key: 'k',
        searxng_auth_type: 'basic',
        searxng_format: 'html',
        fetch_count: 2,
        fetch_mode: 'random',
      };
      return key in values ? values[key] : def;
    });
    el('#btnSearxng').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#searxngModal').style.display).toBe('');
    expect(el<HTMLInputElement>('#searxngUrl').value).toBe('https://s.example.com');
    expect(el<HTMLSelectElement>('#searxngFormat').value).toBe('html');
    expect(el<HTMLInputElement>('#searxngMaxResults').disabled).toBe(true);

    el('#btnCloseSearxng').click();
    expect(el('#searxngModal').style.display).toBe('none');
    el('#btnSearxng').click();
    await new Promise((r) => setTimeout(r, 10));
    el('#searxngModal').click();
    expect(el('#searxngModal').style.display).toBe('none');
    closeSearxngModal();
    expect(el('#searxngModal').style.display).toBe('none');
  });

  it('启用开关与格式切换更新 UI/数据库', async () => {
    const toggle = el<HTMLInputElement>('#toggleSearxngEnabled');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(searxngConfig.enabled).toBe(true);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('searxng_enabled', true);
    expect(el('#searxngBadge').textContent).toBe('🟢 已启用');
    expect(el('#searxngIconDot').className).toContain('enabled');

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(searxngConfig.enabled).toBe(false);
    expect(el('#searxngBadge').textContent).toBe('⚪ 未启用');

    const format = el<HTMLSelectElement>('#searxngFormat');
    format.value = 'html';
    format.dispatchEvent(new Event('change'));
    expect(el<HTMLInputElement>('#searxngMaxResults').disabled).toBe(true);
    expect(el<HTMLInputElement>('#searxngMaxResults').style.opacity).toBe('0.4');
    expect(el('#searxngMaxResultsHint').style.display).toBe('');
    format.value = 'json';
    format.dispatchEvent(new Event('change'));
    expect(el<HTMLInputElement>('#searxngMaxResults').disabled).toBe(false);
    expect(el('#searxngMaxResultsHint').style.display).toBe('none');
  });

  it('保存校验与成功批量写入', async () => {
    el('#btnSaveSearxng').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('SearXNG API 地址不能为空', 'error');

    el<HTMLInputElement>('#searxngUrl').value = 'ftp://bad';
    el('#btnSaveSearxng').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('SearXNG API 地址格式不正确，需以 http:// 或 https:// 开头', 'error');

    el<HTMLInputElement>('#searxngUrl').value = 'https://s.example.com';
    el<HTMLInputElement>('#searxngEngines').value = 'google, bing';
    el<HTMLSelectElement>('#searxngLanguage').value = 'en';
    el<HTMLSelectElement>('#searxngSafeSearch').value = '2';
    el<HTMLSelectElement>('#searxngTimeRange').value = 'week';
    el<HTMLInputElement>('#searxngMaxResults').value = '8';
    el<HTMLInputElement>('#searxngAuthKey').value = ' secret ';
    el<HTMLSelectElement>('#searxngAuthType').value = 'basic';
    el<HTMLSelectElement>('#searxngFormat').value = 'json';
    el<HTMLInputElement>('#searxngFetchCount').value = '3';
    el<HTMLSelectElement>('#searxngFetchMode').value = 'random';
    el('#btnSaveSearxng').click();
    await new Promise((r) => setTimeout(r, 20));

    expect(hoisted.saveSettingsBatch).toHaveBeenCalled();
    const batch = hoisted.saveSettingsBatch.mock.calls.at(-1)![0] as Array<{ key: string; value: unknown }>;
    expect(batch).toContainEqual({ key: 'searxng_url', value: 'https://s.example.com' });
    expect(batch).toContainEqual({ key: 'searxng_max_results', value: 8 });
    expect(batch).toContainEqual({ key: 'searxng_auth_key', value: 'secret' });
    expect(batch).toContainEqual({ key: 'fetch_mode', value: 'random' });
    expect(searxngConfig.url).toBe('https://s.example.com');
    expect(searxngConfig.auth_type).toBe('basic');
  });

  it('未启用/零值配置同步为空表单并支持重复初始化', async () => {
    initSearxngModal();
    hoisted.getSetting.mockImplementation(async (_key: string, def: unknown) => def);
    el('#btnSearxng').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#searxngBadge').textContent).toBe('⚪ 未启用');
    expect(el<HTMLInputElement>('#searxngMaxResults').value).toBe('');
    expect(el<HTMLInputElement>('#searxngFetchCount').value).toBe('');
    expect(el<HTMLSelectElement>('#searxngTimeRange').value).toBe('');

    el<HTMLInputElement>('#searxngUrl').value = 'https://s.example.com';
    el<HTMLInputElement>('#searxngMaxResults').value = '';
    el<HTMLInputElement>('#searxngFetchCount').value = '';
    el('#btnSaveSearxng').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(searxngConfig.max_results).toBe(0);
    expect(searxngConfig.fetch_count).toBe(0);
  });
});

// ─────────────────────────── token-dashboard ───────────────────────────

describe('token-dashboard', () => {
  it('全局统计失败时显示重试提示', async () => {
    hoisted.getAllTokenStats.mockResolvedValueOnce(null);
    el('#btnTokenDashboard').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#tokenDashboardModal').style.display).toBe('');
    expect(el('#tdOverview').textContent).toContain('全局统计加载失败');
    expect(el('#tdChart').textContent).toContain('全局统计加载失败');
    expect(el('#tdTableBody').textContent).toContain('全局统计加载失败');
    closeTokenDashboard();
    expect(el('#tokenDashboardModal').style.display).toBe('none');
  });

  it('全局统计成功渲染概览、图表与表格', async () => {
    const sessions = [
      {
        session_id: 's1',
        title: '会话一号',
        model: 'qwen',
        created_at: 1,
        total_input: 1000,
        total_output: 500,
        total_duration: 1500000,
        round_count: 2,
      },
    ];
    hoisted.getAllTokenStats.mockResolvedValueOnce(globalStats(sessions));
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#tdOverview').textContent).toContain('全局 Token 总计');
    expect(el('#tdOverview').textContent).toContain('1.5k');
    expect(el('#tdChartTitle').textContent).toContain('按会话');
    expect(el('#tdChart').querySelectorAll('.td-bar-col').length).toBe(1);
    expect(el('#tdChart').textContent).toContain('共 1 个会话');
    expect(el('#tdTableBody').textContent).toContain('会话一号');
    expect(el('#tdTableBody').textContent).toContain('qwen');
    expect(document.querySelector('.td-table thead')?.textContent).toContain('创建时间');
    closeTokenDashboard();
  });

  it('全局会话/表格超限显示截断说明', async () => {
    const sessions = Array.from({ length: 55 }, (_, i) => ({
      session_id: `s${i}`,
      title: `会话${i}`,
      model: 'm',
      created_at: i,
      total_input: 10,
      total_output: 5,
      total_duration: 0,
      round_count: 1,
    }));
    hoisted.getAllTokenStats.mockResolvedValueOnce(globalStats(sessions));
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#tdChart').textContent).toContain('最近 30 / 共 55 个会话');
    expect(el('#tdChart').querySelectorAll('.td-bar-col').length).toBe(30);
    expect(el('#tdTableTitle').textContent).toContain('最近 50 条 / 共 55 条');
    expect(el('#tdTableBody').querySelectorAll('tr').length).toBe(50);
    closeTokenDashboard();
  });

  it('合并当前会话内存数据并显示缓存命中', async () => {
    hoisted.getAllTokenStats.mockResolvedValueOnce(globalStats([]));
    state.set(
      KEYS.CURRENT_SESSION,
      makeSession([
        msg('user', 'q1'),
        msg('assistant', 'a1', {
          prompt_eval_count: 100,
          eval_count: 50,
          prompt_eval_cached_count: 20,
          total_duration: 1000,
        }),
        msg('user', 'q2'),
        msg('assistant', 'a2', {
          prompt_eval_count: 200,
          eval_count: 100,
          prompt_eval_cached_count: 30,
          total_duration: 2000,
        }),
      ]),
    );
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#tdOverview').textContent).toContain('本会话缓存命中');
    expect(el('#tdOverview').textContent).toContain('17%');
    expect(el('#tdTableBody').textContent).toContain('测试会话');
    expect(el('#tdChart').querySelectorAll('.td-bar-col').length).toBe(1);
    closeTokenDashboard();
  });

  it('当前会话视图：环形图、轮次表、流式与估算提示', async () => {
    hoisted.modelCtx = 65536;
    state.set(
      KEYS.CURRENT_SESSION,
      makeSession([
        msg('user', 'q1'),
        msg('assistant', 'a1', {
          prompt_eval_count: 500,
          eval_count: 100,
          prompt_eval_cached_count: 10,
          total_duration: 1_500_000,
          model: 'qwen3',
          toolCalls: [{ name: 'read_file' }] as ChatMessage['toolCalls'],
          images: ['img'],
        }),
        msg('user', 'q2'),
        msg('assistant', 'a2', {
          prompt_eval_count: 600,
          eval_count: 200,
          total_duration: 65_000_000_000,
          model: 'qwen3',
        }),
        msg('user', 'q3'),
        msg('assistant', 'a3', { prompt_eval_count: 10, eval_count: 5, total_duration: 500_000, model: 'qwen3' }),
      ]),
    );
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 20));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));

    expect(el('#tdCtxRingSection').style.display).toBe('');
    expect(el('#tdOverview').textContent).toContain('用户 / AI 消息');
    expect(el('#tdOverview').textContent).toContain('3 / 3');
    expect(el('#tdOverview').textContent).toContain('qwen3');
    expect(el('#tdChartTitle').textContent).toContain('按轮次');
    expect(el('#tdChart').textContent).toContain('共 3 轮');
    expect(el('#tdTableBody').textContent).toContain('R2');
    expect(el('#tdTableBody').textContent).toContain('1m5s');
    expect(el('#tdTableBody').textContent).toContain('2ms');
    expect(el('#tdTableBody').textContent).toContain('1ms');
    expect(el('#tdCtxRing').textContent).toContain('已用上下文');
    expect(el('#tdCtxRing').textContent).toContain('基于 Ollama 实际计数');
    expect(el('#tdCtxRing').textContent).toContain('模型标称');

    state.set(KEYS.IS_STREAMING, true);
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdCtxRing').textContent).toContain('实时更新中');
    expect(el('#tdTableTitle').textContent).toContain('AI 回复中');
    expect(el('#tdChart').textContent).toContain('AI 回复中');
    closeTokenDashboard();
  });

  it('无实际 token 时使用估算，空会话与流式空状态', async () => {
    hoisted.effectiveCtx = 1000;
    hoisted.modelCtx = 500;
    state.set(KEYS.NUM_CTX, 1000);
    state.set(
      KEYS.CURRENT_SESSION,
      makeSession([
        msg('user', 'x'.repeat(100), { images: ['a', 'b'] }),
        msg('assistant', 'y'.repeat(200), { toolCalls: [{ name: 'a' }, { name: 'b' }] as ChatMessage['toolCalls'] }),
      ]),
    );
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 20));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdCtxRing').textContent).toContain('基于估算（含工具/图片开销）');
    expect(el('#tdCtxRing').textContent).toContain('模型标称');

    state.set(KEYS.CURRENT_SESSION, makeSession([]));
    state.set(KEYS.IS_STREAMING, false);
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdChart').textContent).toContain('暂无数据');
    expect(el('#tdTableBody').textContent).toContain('暂无数据');

    state.set(KEYS.IS_STREAMING, true);
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdTableBody').textContent).toContain('AI 正在回复中');
    closeTokenDashboard();
  });

  it('会话轮次超过 50 显示最近 50 轮', async () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 55; i++) {
      messages.push(msg('user', `q${i}`));
      messages.push(msg('assistant', `a${i}`, { prompt_eval_count: 10, eval_count: 5, total_duration: 1000 }));
    }
    state.set(KEYS.CURRENT_SESSION, makeSession(messages));
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 20));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdChart').textContent).toContain('最近 50 / 共 55 轮');
    expect(el('#tdChart').querySelectorAll('.td-bar-col').length).toBe(50);
    expect(el('#tdTableBody').querySelectorAll('tr').length).toBe(55);
    closeTokenDashboard();
  });

  it('全局刷新失败时保留上次成功数据', async () => {
    const sessions = [
      {
        session_id: 's1',
        title: '保留数据',
        model: 'm',
        created_at: 1,
        total_input: 10,
        total_output: 5,
        total_duration: 0,
        round_count: 1,
      },
    ];
    hoisted.getAllTokenStats.mockResolvedValueOnce(globalStats(sessions));
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 20));
    hoisted.getAllTokenStats.mockResolvedValueOnce(null);
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#tdTableBody').textContent).toContain('保留数据');
    closeTokenDashboard();
  });

  it('自动刷新每 2 秒触发，关闭后停止', async () => {
    vi.useFakeTimers();
    hoisted.getAllTokenStats.mockResolvedValue(globalStats([]));
    openTokenDashboard();
    await vi.advanceTimersByTimeAsync(20);
    const first = hoisted.getAllTokenStats.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2100);
    expect(hoisted.getAllTokenStats.mock.calls.length).toBeGreaterThan(first);
    closeTokenDashboard();
    const afterClose = hoisted.getAllTokenStats.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2100);
    expect(hoisted.getAllTokenStats.mock.calls.length).toBe(afterClose);
  });

  it('遮罩关闭仪表盘', async () => {
    hoisted.getAllTokenStats.mockResolvedValueOnce(globalStats([]));
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 10));
    el('#tokenDashboardModal').click();
    expect(el('#tokenDashboardModal').style.display).toBe('none');
  });

  it('全局边界：标题截断、created_at=0、当前会话覆盖、滚动位置恢复', async () => {
    const sessions = Array.from({ length: 35 }, (_, i) => ({
      session_id: i === 0 ? 's1' : `s${i}`,
      title: `这是一个非常非常长的会话标题用于测试截断效果-${i}`,
      model: 'm',
      created_at: i === 1 ? 0 : i,
      total_input: i === 0 ? 1 : 10,
      total_output: 5,
      total_duration: 1000,
      round_count: 1,
    }));
    state.set(
      KEYS.CURRENT_SESSION,
      makeSession(
        [msg('user', 'q'), msg('assistant', 'a', { prompt_eval_count: 1000, eval_count: 500, total_duration: 2000 })],
        { id: 's1', title: '当前会话覆盖' },
      ),
    );
    hoisted.getAllTokenStats.mockResolvedValueOnce(globalStats(sessions));
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#tdTableBody').textContent).toContain('…');
    expect(el('#tdTableBody').textContent).toContain('-');
    expect(el('#tdTableBody').textContent).toContain('当前会话覆盖');

    const bars = el('#tdChart').querySelector('.td-chart-bars') as HTMLElement;
    bars.scrollLeft = 120;
    const wrap = document.querySelector('.td-table-wrap') as HTMLElement;
    wrap.scrollTop = 80;
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect((el('#tdChart').querySelector('.td-chart-bars') as HTMLElement).scrollLeft).toBe(120);
    expect((document.querySelector('.td-table-wrap') as HTMLElement).scrollTop).toBe(80);
  });

  it('全局请求竞态：旧响应被丢弃', async () => {
    let resolveOld: ((v: unknown) => void) | null = null;
    let resolveNew: ((v: unknown) => void) | null = null;
    hoisted.getAllTokenStats
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
      );
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));

    resolveNew!(
      globalStats([
        {
          session_id: 'new',
          title: '新响应',
          model: 'm',
          created_at: 2,
          total_input: 1,
          total_output: 1,
          total_duration: 0,
          round_count: 1,
        },
      ]),
    );
    await new Promise((r) => setTimeout(r, 10));
    resolveOld!(
      globalStats([
        {
          session_id: 'old',
          title: '旧响应',
          model: 'm',
          created_at: 1,
          total_input: 9,
          total_output: 9,
          total_duration: 0,
          round_count: 1,
        },
      ]),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdTableBody').textContent).toContain('新响应');
    expect(el('#tdTableBody').textContent).not.toContain('旧响应');
  });

  it('当前会话空/无模型、AI 先行、多次调用、高使用率与缺失环形图', async () => {
    state.set(KEYS.CURRENT_SESSION, null);
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdOverview').textContent).toContain('-');
    expect(el('#tdTableBody').textContent).toContain('暂无数据');

    hoisted.effectiveCtx = 1000;
    state.set(
      KEYS.CURRENT_SESSION,
      makeSession(
        [
          msg('assistant', 'a1', { prompt_eval_count: 500, eval_count: 400 }),
          msg('assistant', 'a2', { prompt_eval_count: 500, eval_count: 400 }),
          msg('user', 'q', { timestamp: 0 }),
          msg('assistant', 'a3', { prompt_eval_count: 900, eval_count: 100 }),
        ],
        { model: '' },
      ),
    );
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdTableBody').textContent).toContain('2次');
    expect(el('#tdCtxRing').innerHTML).toContain('#E8734A');
    expect(el('#tdCtxRing').textContent).toContain('100%');
    expect(el('#tdOverview').textContent).toContain('-');

    const ring = el('#tdCtxRing');
    const ringParent = ring.parentElement!;
    ring.remove();
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    expect(() => el('#tdTableBody')).not.toThrow();
    ringParent.appendChild(ring);
  });

  it('橙色阈值、零耗时与表头缺失', async () => {
    hoisted.effectiveCtx = 10000;
    state.set(
      KEYS.CURRENT_SESSION,
      makeSession([
        msg('user', 'q'),
        msg('assistant', 'a'.repeat(30000), { prompt_eval_count: 8000, eval_count: 0, total_duration: 0 }),
      ]),
    );
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdCtxRing').innerHTML).toContain('#F0A040');
    expect(el('#tdTableBody').textContent).toContain('-');

    const thead = document.querySelector('.td-table thead')!;
    const table = thead.parentElement!;
    thead.remove();
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    expect(el('#tdTableBody').textContent).toContain('R');
    table.prepend(thead);
  });

  it('bridge 缺少 db 或查询抛异常时降级', async () => {
    const bridge = (window as unknown as { metonaDesktop: { db?: unknown } }).metonaDesktop;
    const db = bridge.db;
    bridge.db = undefined;
    openTokenDashboard();
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    // 已成功加载过数据：失败时保留旧数据而不是显示错误
    expect(el('#tdOverview').textContent).toContain('全局 Token 总计');
    bridge.db = db;

    hoisted.getAllTokenStats.mockRejectedValueOnce(new Error('db down'));
    (el('#tdViewToggle [data-view="session"]') as HTMLElement).click();
    (el('#tdViewToggle [data-view="global"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#tdOverview').textContent).toContain('全局 Token 总计');
  });

  it('视图切换容器自身点击被忽略', async () => {
    openTokenDashboard();
    await new Promise((r) => setTimeout(r, 10));
    const toggle = el('#tdViewToggle');
    (toggle.querySelector('[data-view="global"]') as HTMLElement).click();
    toggle.click();
    expect(toggle.querySelector('.active')?.getAttribute('data-view')).toBe('global');
  });
});

// ─────────────────────────── metrics-dashboard ───────────────────────────

describe('metrics-dashboard', () => {
  it('无数据时显示空状态', async () => {
    el('#btnMetrics').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#metricsDashboardModal').style.display).toBe('');
    expect(el('#mdOverview').textContent).toContain('暂无度量数据');
    expect(el('#mdToolHeatmap').textContent).toContain('暂无工具调用数据');
    expect(el('#mdTokenTrend').textContent).toContain('暂无 Token 趋势数据');
    expect(el('#mdSuggestions').textContent).toContain('暂无改进建议');
    el('#btnCloseMetrics').click();
    expect(el('#metricsDashboardModal').style.display).toBe('none');
    el('#btnMetrics').click();
    el('#metricsDashboardModal').click();
    expect(el('#metricsDashboardModal').style.display).toBe('none');
  });

  it('有数据时渲染概览、热力图、趋势与建议', async () => {
    hoisted.getMetricsHistory.mockReturnValue([
      {
        sessionId: 's1',
        model: 'm',
        startTime: 0,
        endTime: 100,
        totalIterations: 3,
        toolCalls: [
          { name: 'read_file', status: 'success' },
          { name: 'read_file', status: 'error' },
          { name: 'run_command', status: 'cancelled' },
        ],
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        errorPatterns: ['read_file:error'],
      },
      {
        sessionId: 's2',
        model: 'm',
        startTime: 0,
        endTime: 100,
        totalIterations: 4,
        toolCalls: [{ name: 'read_file', status: 'success' }],
        totalInputTokens: 200,
        totalOutputTokens: 100,
        errorPatterns: [],
      },
    ]);
    hoisted.aggregateMetrics.mockReturnValue({
      totalSessions: 2,
      avgIterationsPerTask: 3.5,
      toolSuccessRate: 0.75,
      frequentErrors: [{ pattern: 'read_file:error', count: 1 }],
      tokenEfficiency: 0.5,
      collectedAt: 1,
    });
    hoisted.generateImprovementSuggestions.mockReturnValue([
      { pattern: 'a', frequency: 3, suggestion: '建议A', severity: 'high' },
      { pattern: 'b', frequency: 2, suggestion: '建议B', severity: 'medium' },
      { pattern: 'c', frequency: 1, suggestion: '建议C', severity: 'low' },
    ]);
    el('#btnMetrics').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#mdOverview').textContent).toContain('会话总数');
    expect(el('#mdOverview').textContent).toContain('3.5');
    expect(el('#mdOverview').textContent).toContain('75.0%');
    expect(el('#mdOverview').textContent).toContain('0.50');
    const bars = el('#mdToolHeatmap').querySelectorAll('.md-bar-row');
    expect(bars.length).toBe(2);
    expect(bars[0].textContent).toContain('read_file');
    expect(bars[0].textContent).toContain('2/3');
    expect(el('#mdTokenTrend').querySelectorAll('.md-token-bar').length).toBe(2);
    expect(el('#mdSuggestions').textContent).toContain('建议A');
    expect(el('#mdSuggestions').querySelector('.md-severity-high')).not.toBeNull();
    expect(el('#mdSuggestions').querySelector('.md-severity-low')).not.toBeNull();
    el('#btnCloseMetrics').click();
  });

  it('导出 JSON/Prometheus 成功、取消、写入失败与异常', async () => {
    el('#btnExportMetricsJson').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^metona-metrics-.*\.json$/),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      }),
    );
    expect(hoisted.writeFile).toHaveBeenCalledWith('/tmp/out.json', '{"metrics":true}', 'utf-8');
    expect(hoisted.toast).toHaveBeenCalledWith('指标已导出', 'success');

    hoisted.saveFile.mockResolvedValueOnce(null);
    const writes = hoisted.writeFile.mock.calls.length;
    el('#btnExportMetricsJson').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.writeFile.mock.calls.length).toBe(writes);

    hoisted.writeFile.mockResolvedValueOnce({ success: false, error: 'disk' });
    el('#btnExportMetricsJson').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('导出失败: disk', 'error');

    hoisted.saveFile.mockRejectedValueOnce(new Error('dialog fail'));
    el('#btnExportMetricsPrometheus').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.toast).toHaveBeenCalledWith('导出失败: dialog fail', 'error');

    el('#btnExportMetricsPrometheus').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^metona-metrics-.*\.prom$/),
        filters: [{ name: 'Prometheus 文本', extensions: ['prom', 'txt'] }],
      }),
    );
    expect(hoisted.writeFile).toHaveBeenCalledWith('/tmp/out.json', 'metona_sessions_total 0\n', 'utf-8');
  });

  it('无 bridge 时回退浏览器下载', async () => {
    const bridge = (window as unknown as { metonaDesktop?: unknown }).metonaDesktop;
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = undefined;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    el('#btnExportMetricsJson').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = bridge;
  });

  it('缺少可选 DOM 节点与 modal 时安全返回', () => {
    for (const id of ['mdOverview', 'mdToolHeatmap', 'mdTokenTrend', 'mdSuggestions']) {
      document.querySelector(`#${id}`)?.remove();
    }
    el('#btnMetrics').click();
    expect(el('#metricsDashboardModal').style.display).toBe('');
    el('#btnCloseMetrics').click();

    el('#metricsDashboardModal').remove();
    initMetricsDashboard();
    el('#btnMetrics').click();
    expect(document.querySelector('#metricsDashboardModal')).toBeNull();
  });
});
