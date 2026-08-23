/**
 * App - 主入口模块
 * 负责初始化所有组件、协调事件流、管理生命周期
 */

import './styles/style.css';
import './styles/dark-theme.css';

import { ChatDB } from './db/chat-db.js';
import { OllamaAPI } from './api/ollama.js';
import { state, KEYS } from './state/state.js';
import { generateId } from './utils/utils.js';

// 组件
import { initToast, showToast } from './components/toast.js';
import { initLightbox, closeLightbox } from './components/lightbox.js';
import { initHeader, checkConnection } from './components/header.js';
import { initModelBar, loadModels, setSelectedModel } from './components/model-bar.js';
import { initChatArea, renderMessages, clearMessages, enableAutoScroll, initSearchBar } from './components/chat-area.js';
import { initInputArea } from './components/input-area.js';
import { initSettingsModal, closeSettingsModal } from './components/settings-modal.js';
import { initHistoryModal, closeHistoryModal } from './components/history-modal.js';
import { initMemoryModal } from './components/memory-modal.js';
import { initToolsModal, closeToolsModal } from './components/tools-modal.js';
import { initTokenDashboard, closeTokenDashboard } from './components/token-dashboard.js';
import { initGlobalToolMode, refreshMCPTools } from './services/tool-registry.js';
import { startAllMCPServers } from './services/mcp-client.js';
import { initToolConfirmModal } from './components/tool-confirm-modal.js';
import { initWorkspacePanel, clearToolCardsExternal, clearTerminalExternal, switchToTab } from './components/workspace-panel.js';
import { initLogPanel, addLog } from './services/log-service.js';
import { logInfo, logSuccess, logError, logDebug, logInit, logWarn } from './services/log-service.js';
import { initGlobalErrorHandler } from './services/infra-service.js';
import { initSearxngModal, closeSearxngModal, loadSearxngConfig } from './components/searxng-modal.js';
import { initKeybindManager } from './components/keybind-manager.js';
import { initMetricsDashboard } from './components/metrics-dashboard.js';
import { initHarnessHooks } from './services/hooks.js';
import { setAppVersion, loadMetricsHistory } from './services/agent-metrics.js';
import type { ChatSession } from './types.js';

// ─── v4.0 数据迁移：IndexedDB → SQLite ───

async function migrateIndexedDBToSQLite(db: ChatDB): Promise<void> {
  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop || !bridge?.db) {
    logInit('非桌面环境，跳过迁移');
    return;
  }

  // 检查是否已迁移
  const migrated = await bridge.db.getSetting('_indexeddb_migrated', false);
  if (migrated) {
    logInit('SQLite 数据库已连接（已迁移）');
    return;
  }

  // 检查 IndexedDB 中是否有数据
  const idb = db.getRawIDB();
  if (!idb) {
    logInit('SQLite 数据库已连接（无旧数据）');
    return;
  }

  // 读取 IndexedDB 数据
  try {
    const sessions: ChatSession[] = await new Promise((resolve, reject) => {
      const tx = idb.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    const memories: Record<string, unknown>[] = await new Promise((resolve, reject) => {
      const tx = idb.transaction('memories', 'readonly');
      const store = tx.objectStore('memories');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    const settings: Record<string, unknown>[] = await new Promise((resolve, reject) => {
      const tx = idb.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    if (sessions.length === 0 && memories.length === 0 && settings.length === 0) {
      logInit('SQLite 数据库已连接（无旧数据）');
      await bridge.db.saveSetting('_indexeddb_migrated', true);
      return;
    }

    logInit(`发现旧数据: ${sessions.length} 会话, ${memories.length} 记忆, ${settings.length} 设置`);

    // 构造导入数据
    const importData = {
      sessions: sessions.map(s => ({
        id: s.id,
        title: s.title,
        model: s.model,
        system_prompt: null as string | null,
        parent_id: null as string | null,
        status: 'active',
        created_at: s.createdAt,
        updated_at: s.updatedAt
      })),
      messages: (sessions as any[]).flatMap((s: any) =>
        (s.messages || []).map((m: any, idx: number) => ({
          id: `${s.id}_msg_${idx}_${m.timestamp}`,
          session_id: s.id,
          role: m.role,
          content: m.content || null,
          thinking: m.think || null,
          images: m.images?.length ? JSON.stringify(m.images) : null,
          tool_calls: m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null,
          tool_name: null,
          eval_count: m.eval_count || null,
          total_duration: m.total_duration || null,
          created_at: m.timestamp || Date.now()
        }))
      ),
      memories: memories.map((m: Record<string, unknown>) => ({
        id: m.id,
        type: m.type,
        content: m.content,
        importance: m.importance || 5,
        tags: (m.tags as any[])?.length ? JSON.stringify(m.tags) : null,
        source: m.source || null,
        session_id: m.sessionId || null,
        use_count: m.useCount || 0,
        embedding: m.embedding ? JSON.stringify(m.embedding) : null,
        created_at: m.createdAt,
        updated_at: m.updatedAt,
        last_used_at: m.lastUsedAt
      })),
      settings: settings.map((s: Record<string, unknown>) => ({ key: s.key, value: s.value })),
      exportedAt: Date.now()
    };

    const result = await bridge.db.importSessions(importData);
    logInit(`迁移完成: 导入 ${result.imported} 个会话, 跳过 ${result.skipped} 个`);

    // 标记迁移完成
    await bridge.db.saveSetting('_indexeddb_migrated', true);
    logSuccess('数据迁移完成');
  } catch (err) {
    logError('数据迁移失败', (err as Error).message);
    // 迁移失败不阻塞启动
  }
}

function initHelpModal(): void {
  const helpModal = document.querySelector('#helpModal') as HTMLElement;
  document.querySelector('#btnHelp')!.addEventListener('click', () => {
    helpModal.style.display = '';
  });
  document.querySelector('#btnCloseHelp')!.addEventListener('click', () => {
    helpModal.style.display = 'none';
  });
  helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal) helpModal.style.display = 'none';
  });
}

function setupDesktopIntegration(): void {
  const bridge = window.metonaDesktop;
  if (!bridge || !bridge.isDesktop) {
    logDebug('非桌面环境，跳过桌面集成');
    return;
  }

  logInit('桌面集成...');

  bridge.onMenuAction((action: string) => {
    logInfo(`菜单操作: ${action}`);
    switch (action) {
      case 'new-chat': document.querySelector('#btnNewChat')?.dispatchEvent(new Event('click')); break;
      case 'import': document.querySelector('#btnImportSessions')?.dispatchEvent(new Event('click')); break;
      case 'export': document.querySelector('#btnExportAll')?.dispatchEvent(new Event('click')); break;
      case 'help': document.querySelector('#btnHelp')?.dispatchEvent(new Event('click')); break;
    }
  });

  bridge.onTrayAction((action: string) => {
    logInfo(`托盘操作: ${action}`);
    switch (action) {
      case 'new-chat': document.querySelector('#btnNewChat')?.dispatchEvent(new Event('click')); break;
    }
  });

  // 标题更新
  window.addEventListener('metona:model-changed', ((e: CustomEvent) => {
    if (e.detail?.model) {
      document.title = `${e.detail.model} - Metona Ollama`;
    } else {
      document.title = 'Metona Ollama';
    }
  }) as EventListener);

  // 主进程日志转发到日志面板
  bridge.onMainLog((data: { level: string; message: string; detail?: string }) => {
    addLog(data.level as 'info' | 'success' | 'warn' | 'error' | 'debug', data.message, data.detail);
  });

  // 退出时释放显存
  bridge.onAppQuit(() => {
    const api = state.get<OllamaAPI | null>(KEYS.API);
    const model = state.get<string>('_defaultModel', '');
    if (api && model) {
      api.chat({ model, messages: [], keep_alive: 0 }).catch(() => {});
    }
  });

  // 桌面端快捷键已迁移到 keybind-manager.ts 统一管理

  logSuccess('桌面集成完成');
}

// ─── 主题管理 ───

type ThemeMode = 'light' | 'dark' | 'auto';
const THEME_STORAGE_KEY = 'metona-theme';
let _systemThemeMedia: MediaQueryList | null = null;

function applyTheme(mode: ThemeMode): void {
  let effective: 'light' | 'dark';
  if (mode === 'auto') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    effective = mode;
  }
  document.documentElement.setAttribute('data-theme', effective);
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', effective === 'dark' ? '#1A1B26' : '#FAF7F2');
  }
}

async function initTheme(): Promise<void> {
  // 从 localStorage 快速读取（避免闪烁），数据库初始化后会在 loadSettings 中更新
  const saved = (localStorage.getItem(THEME_STORAGE_KEY) || 'auto') as ThemeMode;
  applyTheme(saved);

  // 监听系统主题变化（仅 auto 模式下生效）
  _systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  _systemThemeMedia.addEventListener('change', () => {
    const current = (localStorage.getItem(THEME_STORAGE_KEY) || 'auto') as ThemeMode;
    if (current === 'auto') applyTheme('auto');
  });
}

async function loadThemeFromDB(): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;
  const saved = await db.getSetting<ThemeMode>('themeMode', 'auto');
  localStorage.setItem(THEME_STORAGE_KEY, saved || 'auto');
  applyTheme(saved || 'auto');
}

function createNewSession(): ChatSession {
  const selectedModel = (document.querySelector('#modelSelect') as HTMLSelectElement)?.value || '';
  const defaultModel = selectedModel || state.get<string>('_defaultModel', '');
  return {
    id: generateId(),
    title: '新会话',
    model: defaultModel,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

async function startNewSession(): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  if (db && currentSession && currentSession.messages.length > 0) {
    currentSession.updatedAt = Date.now();
    await db.saveSession(currentSession);
  }

  const api = state.get<OllamaAPI>(KEYS.API);
  const model = currentSession?.model || state.get<string>('_defaultModel', '');
  if (api && model) {
    try {
      await api.chat({ model, messages: [], keep_alive: 0 });
      logDebug('释放旧模型显存');
    } catch (e) {
      logWarn('释放显存失败', (e as Error).message);
    }
  }

  const session = createNewSession();
  state.set(KEYS.CURRENT_SESSION, session);
  logInfo('新建会话');

  // ── 强制中断正在进行的生成 ──
  const abortController = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER);
  if (abortController) {
    abortController.abort();
  }
  state.set(KEYS.IS_STREAMING, false);
  state.set(KEYS.ABORT_CONTROLLER, null);

  // ── 恢复发送按钮 ──
  const btnSend = document.querySelector('#btnSend') as HTMLButtonElement;
  if (btnSend) {
    btnSend.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    btnSend.classList.remove('stop-btn', 'disabled');
    btnSend.title = '发送';
  }

  state.set(KEYS.IS_HISTORY_VIEW, false);

  (document.querySelector('#historyBar') as HTMLElement).style.display = 'none';
  (document.querySelector('#inputArea') as HTMLElement).style.display = '';

  clearMessages();
  enableAutoScroll();
  renderMessages();

  // ── 重置工作空间到空闲状态 ──
  clearToolCardsExternal();
  clearTerminalExternal();
  switchToTab('tools');

  (document.querySelector('#chatInput') as HTMLElement)?.focus();
}

async function init(): Promise<void> {
  let db: ChatDB | undefined;
  let api: OllamaAPI | undefined;

  logInit('启动...');

  // ── UI 组件初始化（不依赖数据库，先初始化以避免 catch 路径重复绑定）──
  initLogPanel();  // ← 日志面板最先初始化，确保后续 init 日志能显示
  initGlobalErrorHandler();  // R42: 全局错误处理器（紧随日志面板之后）
  initToast();
  initLightbox();
  initHeader();
  initModelBar();
  initChatArea();
  initSearchBar();
  initInputArea();
  initSettingsModal();
  initHistoryModal();
  initHelpModal();
  initToolConfirmModal();
  initMemoryModal();
  initToolsModal();
  initTokenDashboard();
  initWorkspacePanel();
  setupDesktopIntegration();
  initSearxngModal();
  initKeybindManager();
  initMetricsDashboard();

  bindGlobalEvents();

  // ── Harness Engineering 系统初始化（幂等，UI 就绪后即可注册）──
  initHarnessHooks();
  // Agent Metrics 无需显式初始化（按需启动）
  // Context Indexer 在 Agent INIT 状态按需构建

  // ── 主题初始化（不依赖数据库，尽早执行避免闪烁）──
  await initTheme();

  // ── 状态默认值（不依赖数据库）──
  state.set(KEYS.CURRENT_SESSION, createNewSession());
  state.set(KEYS.IS_STREAMING, false);
  state.set(KEYS.IS_HISTORY_VIEW, false);
  state.set(KEYS.NUM_CTX, 131072); // 默认 128K

  // ── 防御性重置：确保首次启动不会遗留脏状态 ──
  state.set('toolCallingEnabled', true);
  state.set('runCommandMode', 'confirm');  // 兼容旧代码读取
  state.set('thinkEnabled', false);

  // ── 注入应用版本号到 Agent Metrics ──
  const _bridge = window.metonaDesktop;
  if (_bridge?.info) {
    _bridge.info().then((info: { version?: string }) => {
      if (info?.version) setAppVersion(info.version);
    }).catch(() => {});
  }

  try {
    db = new ChatDB();
    await db.init();
    state.set(KEYS.DB, db);

    // 恢复历史度量数据（localStorage 持久化的 R84 度量历史）
    loadMetricsHistory();

    // v4.0 数据迁移：检测 IndexedDB 是否有旧数据需要迁移到 SQLite
    await migrateIndexedDBToSQLite(db);

    const serverUrl = await db.getSetting('serverUrl', 'http://127.0.0.1:11434');
    api = new OllamaAPI(serverUrl);
    state.set(KEYS.API, api);
    logInit(`Ollama 地址: ${serverUrl}`);

    await checkConnection();
    await loadModels();
    await loadSearxngConfig(db);

    // ── 主题：从数据库加载（覆盖 localStorage 的快速值）──
    await loadThemeFromDB();

    // ── MEMORY.md 初始化 ──
    import('./services/memory-service.js').then(({ initMemoryFile }) => {
      initMemoryFile().catch(() => {});
    });

    logInit('所有组件已就绪（含 Harness）');

    const savedModel = await db.getSetting('selectedModel', '');
    if (savedModel) {
      setSelectedModel(savedModel);
      state.set('_defaultModel', savedModel);
      await db.saveSetting('selectedModel', savedModel);
    }

    const numCtx = await db.getSetting<number>('numCtx', 131072);
    const temperature = await db.getSetting('temperature', 0.7);

    // 如果首次使用（数据库中无此设置），保存默认 128K
    const hasNumCtx = await db.getSetting<number | null>('numCtx', null);
    if (hasNumCtx === null) {
      await db.saveSetting('numCtx', 131072);
    }

    state.set(KEYS.NUM_CTX, numCtx);
    state.set('temperature', temperature);

    // 反显设置面板的下拉框
    const ctxSelect = document.querySelector('#selectContextLength') as HTMLSelectElement;
    if (ctxSelect) ctxSelect.value = String(numCtx);

    (document.querySelector('#inputTemperature') as HTMLInputElement).value = String(temperature);
    document.querySelector('#tempValue')!.textContent = parseFloat(String(temperature)).toFixed(1);

    // ── v5.1.1 Agent 最大轮数 ──
    const maxTurns = await db.getSetting('maxTurns', 85);
    state.set('maxTurns', maxTurns);
    (document.querySelector('#inputMaxTurns') as HTMLInputElement).value = String(maxTurns);

    // ── v5.2 超时设置：-1=默认, 0=禁用, 正数=自定义 ──
    let httpTimeout = await db.getSetting<number>('httpTimeout', -1);
    let streamTimeout = await db.getSetting<number>('streamTimeout', -1);
    let mcpTimeout = await db.getSetting<number>('mcpTimeout', -1);

    // 兼容旧版：首次升级时，旧版把"未设置"存为0，一次性迁移为-1
    const migrated = await db.getSetting<boolean>('_timeout_v2_migrated', false);
    if (!migrated) {
      if (httpTimeout === 0) { httpTimeout = -1; await db.saveSetting('httpTimeout', -1); }
      if (streamTimeout === 0) { streamTimeout = -1; await db.saveSetting('streamTimeout', -1); }
      if (mcpTimeout === 0) { mcpTimeout = -1; await db.saveSetting('mcpTimeout', -1); }
      await db.saveSetting('_timeout_v2_migrated', true);
    }

    // 应用流式超时到 state（agent-engine 读取，0=禁用）
    state.set('streamTimeout', streamTimeout >= 0 ? streamTimeout * 1000 : -1);
    // 存入 state 供 agent-engine 工具级超时读取（网络工具需要跟随用户配置）
    state.set('httpTimeout', httpTimeout >= 0 ? httpTimeout * 1000 : 900_000);
    state.set('mcpTimeout', mcpTimeout >= 0 ? mcpTimeout * 1000 : 60_000);

    // 应用 HTTP 和 MCP 超时到主进程
    const bridge = window.metonaDesktop;
    if (bridge?.tool?.setTimeouts) {
      await bridge.tool.setTimeouts({
        http: httpTimeout >= 0 ? httpTimeout * 1000 : 900_000,
        mcp: mcpTimeout >= 0 ? mcpTimeout * 1000 : 60_000,
      });
    }

    // 恢复输入框显示（-1显示空, 0显示0, 正数显示数字）
    (document.querySelector('#inputHttpTimeout') as HTMLInputElement).value = httpTimeout >= 0 ? String(httpTimeout) : '';
    (document.querySelector('#inputStreamTimeout') as HTMLInputElement).value = streamTimeout >= 0 ? String(streamTimeout) : '';
    (document.querySelector('#inputMCPTimeout') as HTMLInputElement).value = mcpTimeout >= 0 ? String(mcpTimeout) : '';
    logInit(`超时设置: HTTP=${httpTimeout>=0?httpTimeout:900}s 流式=${streamTimeout>=0?streamTimeout:'动态'}s MCP=${mcpTimeout>=0?mcpTimeout:60}s`);

    // ── 子代理参数 ──
    let subAgentMaxLoops = await db.getSetting<number>('subAgentMaxLoops', 10);
    let subAgentTimeout = await db.getSetting<number>('subAgentTimeout', -1); // -1=默认
    state.set('subAgentMaxLoops', subAgentMaxLoops);
    state.set('subAgentTimeout', subAgentTimeout >= 0 ? subAgentTimeout * 1000 : 300_000);
    (document.querySelector('#inputSubAgentMaxLoops') as HTMLInputElement).value = String(subAgentMaxLoops);
    (document.querySelector('#inputSubAgentTimeout') as HTMLInputElement).value = subAgentTimeout >= 0 ? String(subAgentTimeout) : '';

    // ── 子代理权限上限（AI 请求的权限只降不升）──
    {
      const subAgentMaxPermission = await db.getSetting<'readonly' | 'limited_write' | 'full_write'>('subAgentMaxPermission', 'readonly');
      state.set('subAgentMaxPermission', subAgentMaxPermission);
      const permSelect = document.querySelector('#selectSubAgentPermission') as HTMLSelectElement | null;
      if (permSelect) permSelect.value = subAgentMaxPermission;
    }

    // ── 看门狗超时 ──
    let loopWatchdogMs = await db.getSetting<number>('loopWatchdogMs', 1_800_000);
    state.set('loopWatchdogMs', loopWatchdogMs);
    const watchdogMin = loopWatchdogMs > 0 ? Math.round(loopWatchdogMs / 60_000) : loopWatchdogMs;
    const elWatchdog = document.querySelector('#inputLoopWatchdog') as HTMLInputElement;
    if (elWatchdog) elWatchdog.value = loopWatchdogMs > 0 ? String(watchdogMin) : (loopWatchdogMs === 0 ? '0' : '');

    // ── Tool Calling 设置（永久开启，不可关闭）──
    state.set('toolCallingEnabled', true);
    // 全局工具执行模式（统一管理所有工具，不区分工具）
    {
      // 读取全局模式，默认 confirm
      let globalMode = await db.getSetting<'auto' | 'confirm'>('globalToolMode', 'confirm');
      // 兼容旧版：从旧的 toolModes 迁移（如果存在）
      // 注意：之前用 saveSetting('toolModes', null) 清除旧键，JSON.parse("null") 返回 null
      // 所以这里必须做 null 防御，否则 Object.keys(null) 会抛出 "Cannot convert undefined or null to object"
      const savedModes = await db.getSetting<Record<string, 'auto' | 'confirm' | 'disabled'>>('toolModes', {}) ?? {};
      if (savedModes && Object.keys(savedModes).length > 0) {
        // 如果旧 toolModes 中所有被管理工具都是 auto，则迁移为 auto；否则 confirm
        const allAuto = [
          'run_command', 'write_file', 'create_directory', 'delete_file',
          'edit_file', 'move_file', 'copy_file',
          'download_file', 'compress',
        ].every(t => savedModes[t] === 'auto');
        globalMode = allAuto ? 'auto' : 'confirm';
        await db.saveSetting('globalToolMode', globalMode);
        // 清除旧键：用空对象而非 null，避免 JSON.parse("null") 返回 null 的陷阱
        await db.saveSetting('toolModes', {});
      }
      state.set('globalToolMode', globalMode);
      // 应用全局模式到所有被管理工具
      initGlobalToolMode(globalMode);
    }

    // ── Plan 自动确认设置 ──
    {
      const planAutoConfirm = await db.getSetting<boolean>('planAutoConfirm', false);
      state.set('planAutoConfirm', planAutoConfirm);
    }

    // ── MCP 工具注册 ──
    await startAllMCPServers();
    await refreshMCPTools();


    (document.querySelector('#chatInput') as HTMLElement)?.focus();

    logSuccess('应用初始化完成');
  } catch (err) {
    logError('初始化失败', (err as Error).message);
    // UI 组件已在 try 块之前初始化，此处不重复调用以避免重复绑定事件监听器
    if (!api) {
      api = new OllamaAPI();
      state.set(KEYS.API, api);
    }
    // ── 防御性重置：catch 路径也确保关键状态干净 ──
    state.set(KEYS.IS_STREAMING, false);
    state.set(KEYS.IS_HISTORY_VIEW, false);
    state.set(KEYS.CURRENT_SESSION, createNewSession());
    // ── MEMORY.md 初始化（fallback 路径）──
    import('./services/memory-service.js').then(({ initMemoryFile }) => {
      initMemoryFile().catch(() => {});
    });
    checkConnection().then(loadModels);
  }
}



function bindGlobalEvents(): void {
  document.querySelector('#btnNewChat')?.addEventListener('click', startNewSession);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettingsModal();
      closeHistoryModal();
      closeLightbox();
      closeToolsModal();
      closeTokenDashboard();
      closeSearxngModal();
      (document.querySelector('#helpModal') as HTMLElement).style.display = 'none';
      (document.querySelector('#memoryModal') as HTMLElement).style.display = 'none';
    }

    // Ctrl+M — 记忆管理
    if (e.ctrlKey && e.key === 'm') {
      e.preventDefault();
      document.querySelector('#btnMemory')?.dispatchEvent(new Event('click'));
    }
  });

  // ── 全局错误处理已由 infra-service.ts 的 initGlobalErrorHandler 统一注册 ──

}

init();
