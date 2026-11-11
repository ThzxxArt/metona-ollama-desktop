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
import { LLM_PROVIDER_LABELS } from '../shared/contracts/ollama.js';

// 组件
import { initToast, showToast } from './components/toast.js';
import { initLightbox, closeLightbox } from './components/lightbox.js';
import { initHeader, checkConnection } from './components/header.js';
import { initModelBar, loadModels, setSelectedModel } from './components/model-bar.js';
import {
  initChatArea,
  renderMessages,
  clearMessages,
  enableAutoScroll,
  initSearchBar,
} from './components/chat-area.js';
import { initInputArea } from './components/input-area.js';
import { initSettingsModal, closeSettingsModal } from './components/settings-modal.js';
import { initHistoryModal, closeHistoryModal } from './components/history-modal.js';
import { initMemoryModal } from './components/memory-modal.js';
import { initToolsModal, closeToolsModal } from './components/tools-modal.js';
import { initTokenDashboard, closeTokenDashboard } from './components/token-dashboard.js';
import { initGlobalToolMode, refreshMCPTools } from './services/tool-registry.js';
import { startAllMCPServers } from './services/mcp-client.js';
import { initToolConfirmModal } from './components/tool-confirm-modal.js';
import {
  initWorkspacePanel,
  clearToolCardsExternal,
  clearTerminalExternal,
  switchToTab,
} from './components/workspace-panel.js';
import { initLogPanel, addLog } from './services/log-service.js';
import { logInfo, logSuccess, logError, logDebug, logInit, logWarn } from './services/log-service.js';
import { initGlobalErrorHandler } from './services/infra-service.js';
import { initSearxngModal, closeSearxngModal, loadSearxngConfig } from './components/searxng-modal.js';
import { initKeybindManager } from './components/keybind-manager.js';
import { initMetricsDashboard } from './components/metrics-dashboard.js';
import { initHarnessHooks } from './services/hooks.js';
import { setAppVersion, loadMetricsHistory } from './services/agent-metrics.js';
import { showConfirm } from './components/prompt-modal.js';
import type { ChatSession } from './types.js';

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
      case 'new-chat':
        document.querySelector('#btnNewChat')?.dispatchEvent(new Event('click'));
        break;
      case 'import':
        document.querySelector('#btnImportSessions')?.dispatchEvent(new Event('click'));
        break;
      case 'export':
        document.querySelector('#btnExportAll')?.dispatchEvent(new Event('click'));
        break;
      case 'help':
        document.querySelector('#btnHelp')?.dispatchEvent(new Event('click'));
        break;
    }
  });

  bridge.onTrayAction((action: string) => {
    logInfo(`托盘操作: ${action}`);
    switch (action) {
      case 'new-chat':
        document.querySelector('#btnNewChat')?.dispatchEvent(new Event('click'));
        break;
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

  // 退出时释放显存：主进程统一执行；渲染进程仅作为补充（云服务会跳过）
  bridge.onAppQuit(() => {
    const api = state.get<OllamaAPI | null>(KEYS.API);
    void api?.unloadModels(false).catch(() => {});
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
    updatedAt: Date.now(),
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
  if (api) {
    try {
      // 新建会话释放模型：本地 / 自建远程按策略执行；Ollama Cloud 自动跳过
      await api.unloadModels(false);
      logDebug('已按连接策略释放模型');
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
  initLogPanel(); // ← 日志面板最先初始化，确保后续 init 日志能显示
  initGlobalErrorHandler(); // R42: 全局错误处理器（紧随日志面板之后）
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
  state.set('runCommandMode', 'confirm');
  state.set('thinkEnabled', false);
  state.set('thinkLevel', 'off');

  // ── 注入应用版本号 ──
  const _bridge = window.metonaDesktop;
  if (_bridge?.info) {
    _bridge
      .info()
      .then((info: { version?: string }) => {
        if (info?.version) {
          setAppVersion(info.version);
          const el = document.querySelector('#appVersion');
          if (el) el.textContent = `v${info.version}`;
        }
      })
      .catch(() => {});
  }

  try {
    db = new ChatDB();
    await db.init();
    state.set(KEYS.DB, db);

    // 恢复历史度量数据（localStorage 持久化的 R84 度量历史）
    loadMetricsHistory();

    // ── LLM 连接：由主进程统一管理（Ollama / OpenAI 兼容 / Anthropic 兼容）──
    const connection = await _bridge?.ollama?.getConfig();
    if (connection) {
      state.set('connection', connection);
      state.set(KEYS.NUM_CTX, connection.contextLength);
    }
    const initialBaseUrl = connection
      ? connection.provider === 'openai'
        ? connection.openaiUrl
        : connection.provider === 'anthropic'
          ? connection.anthropicUrl
          : connection.mode === 'local'
            ? connection.localUrl
            : connection.remoteUrl
      : '';
    api = new OllamaAPI(initialBaseUrl);
    state.set(KEYS.API, api);
    await api.refreshConfig();
    logInit(`LLM 连接: ${connection?.provider ? LLM_PROVIDER_LABELS[connection.provider] : 'Ollama'} · ${api.baseUrl}`);

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

    // ── v5.1.1 Agent 最大轮数 ──
    const maxTurns = await db.getSetting('maxTurns', 85);
    state.set('maxTurns', maxTurns);
    (document.querySelector('#inputMaxTurns') as HTMLInputElement).value = String(maxTurns);

    // ── v5.2 超时设置：-1=默认, 0=禁用, 正数=自定义 ──
    const httpTimeout = await db.getSetting<number>('httpTimeout', -1);
    const streamTimeout = await db.getSetting<number>('streamTimeout', -1);
    const mcpTimeout = await db.getSetting<number>('mcpTimeout', -1);
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
    (document.querySelector('#inputHttpTimeout') as HTMLInputElement).value =
      httpTimeout >= 0 ? String(httpTimeout) : '';
    (document.querySelector('#inputStreamTimeout') as HTMLInputElement).value =
      streamTimeout >= 0 ? String(streamTimeout) : '';
    (document.querySelector('#inputMCPTimeout') as HTMLInputElement).value = mcpTimeout >= 0 ? String(mcpTimeout) : '';
    logInit(
      `超时设置: HTTP=${httpTimeout >= 0 ? httpTimeout : 900}s 流式=${streamTimeout >= 0 ? streamTimeout : '动态'}s MCP=${mcpTimeout >= 0 ? mcpTimeout : 60}s`,
    );

    // ── 子代理参数 ──
    let subAgentMaxLoops = await db.getSetting<number>('subAgentMaxLoops', 10);
    let subAgentTimeout = await db.getSetting<number>('subAgentTimeout', -1); // -1=默认
    state.set('subAgentMaxLoops', subAgentMaxLoops);
    state.set('subAgentTimeout', subAgentTimeout >= 0 ? subAgentTimeout * 1000 : 300_000);
    (document.querySelector('#inputSubAgentMaxLoops') as HTMLInputElement).value = String(subAgentMaxLoops);
    (document.querySelector('#inputSubAgentTimeout') as HTMLInputElement).value =
      subAgentTimeout >= 0 ? String(subAgentTimeout) : '';

    // ── 子代理权限上限（AI 请求的权限只降不升）──
    {
      const subAgentMaxPermission = await db.getSetting<'readonly' | 'limited_write' | 'full_write'>(
        'subAgentMaxPermission',
        'readonly',
      );
      state.set('subAgentMaxPermission', subAgentMaxPermission);
      const permSelect = document.querySelector('#selectSubAgentPermission') as HTMLSelectElement | null;
      if (permSelect) permSelect.value = subAgentMaxPermission;
    }

    // ── 看门狗超时 ──
    let loopWatchdogMs = await db.getSetting<number>('loopWatchdogMs', 1_800_000);
    state.set('loopWatchdogMs', loopWatchdogMs);
    const watchdogMin = loopWatchdogMs > 0 ? Math.round(loopWatchdogMs / 60_000) : loopWatchdogMs;
    const elWatchdog = document.querySelector('#inputLoopWatchdog') as HTMLInputElement;
    if (elWatchdog) elWatchdog.value = loopWatchdogMs > 0 ? String(watchdogMin) : loopWatchdogMs === 0 ? '0' : '';

    // ── Tool Calling 设置（永久开启，不可关闭）──
    state.set('toolCallingEnabled', true);
    {
      const globalMode = await db.getSetting<'auto' | 'confirm'>('globalToolMode', 'confirm');
      state.set('globalToolMode', globalMode);
      initGlobalToolMode(globalMode);
    }

    // ── 混合记忆检索设置 ──
    {
      const memoryEmbeddingEnabled = await db.getSetting<boolean>('memoryEmbeddingEnabled', false);
      const memoryEmbeddingModel = await db.getSetting<string>('memoryEmbeddingModel', '');
      state.set('memoryEmbeddingEnabled', memoryEmbeddingEnabled);
      state.set('memoryEmbeddingModel', memoryEmbeddingModel);
      const toggle = document.querySelector('#toggleMemoryEmbedding') as HTMLInputElement | null;
      if (toggle) toggle.checked = memoryEmbeddingEnabled;
      const select = document.querySelector('#selectMemoryEmbeddingModel') as HTMLSelectElement | null;
      if (select && memoryEmbeddingModel) select.value = memoryEmbeddingModel;
    }

    // ── MCP 工具注册 ──
    await startAllMCPServers();
    await refreshMCPTools();

    (document.querySelector('#chatInput') as HTMLElement)?.focus();

    // ── 启动后 5s 异步检查 GitHub 新版本（只提示，不自动安装）──
    const checkUpdates = await db.getSetting<boolean>('checkUpdates', true);
    const updateToggle = document.querySelector('#toggleCheckUpdates') as HTMLInputElement | null;
    if (updateToggle) updateToggle.checked = checkUpdates;
    if (checkUpdates && _bridge?.checkUpdate) {
      setTimeout(() => {
        void (async () => {
          try {
            const result = await _bridge.checkUpdate!();
            if (result.hasUpdate && result.latest) {
              const ok = await showConfirm(
                `发现新版本 v${result.latest}（当前 v${result.current}）。是否打开 GitHub Release 页面？`,
                '发现新版本',
              );
              if (ok && result.url) window.metonaDesktop?.openExternal(result.url);
            }
          } catch {
            /* 更新检查失败不影响使用 */
          }
        })();
      }, 5000);
    }

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
