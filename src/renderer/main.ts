/**
 * App - 主入口模块
 * 负责初始化所有组件、协调事件流、管理生命周期
 */

import './styles/style.css';

import { ChatDB } from './db/chat-db.js';
import { OllamaAPI } from './api/ollama.js';
import { state, KEYS } from './state/state.js';
import { generateId } from './utils/utils.js';

// 组件
import { initToast, showToast } from './components/toast.js';
import { initLightbox, closeLightbox } from './components/lightbox.js';
import { initHeader, checkConnection } from './components/header.js';
import { initModelBar, loadModels, setSelectedModel } from './components/model-bar.js';
import { initChatArea, renderMessages, clearMessages, enableAutoScroll } from './components/chat-area.js';
import { initInputArea } from './components/input-area.js';
import { initSettingsModal, closeSettingsModal } from './components/settings-modal.js';
import { initHistoryModal, closeHistoryModal } from './components/history-modal.js';
import { initKBModal } from './components/kb-modal.js';
import { initVectorStore } from './services/rag.js';
import { initMemoryManager } from './services/memory-manager.js';
import { setToolEnabled } from './services/tool-registry.js';
import { initToolConfirmModal } from './components/tool-confirm-modal.js';
import { initMemoryPanel } from './components/memory-panel.js';
import { initLogPanel } from './services/log-service.js';
import { logInfo, logSuccess, logError, logDebug, logInit } from './services/log-service.js';
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
  const bridge = window.__metonaBridge;
  if (!bridge || !bridge.isDesktop) {
    logDebug('非桌面环境，跳过桌面集成');
    return;
  }

  logInit('桌面集成...');

  console.log('[Desktop Integration] 初始化桌面集成...');

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

  // 桌面端快捷键
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      document.querySelector('#btnNewChat')?.dispatchEvent(new Event('click'));
    }
  });

  console.log('[Desktop Integration] 桌面集成完成 ✓');
  logSuccess('桌面集成完成');
}

console.log('[Metona] TypeScript + Electron v3.0.0 ' + new Date().toISOString());

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
      await api.chat({ model, messages: [], keep_alive: 0 } as any);
      logDebug('释放旧模型显存');
    } catch (e) {
      console.warn('[App] 释放显存失败:', e);
    }
  }

  const session = createNewSession();
  state.set(KEYS.CURRENT_SESSION, session);
  logInfo('新建会话');
  state.set(KEYS.IS_HISTORY_VIEW, false);

  (document.querySelector('#historyBar') as HTMLElement).style.display = 'none';
  (document.querySelector('#inputArea') as HTMLElement).style.display = '';

  clearMessages();
  enableAutoScroll();
  renderMessages();
  (document.querySelector('#chatInput') as HTMLElement)?.focus();
}

async function init(): Promise<void> {
  let db: ChatDB | undefined;
  let api: OllamaAPI;

  logInit('启动...');

  try {
    db = new ChatDB();
    await db.init();
    state.set(KEYS.DB, db);
    logInit('IndexedDB 已连接');

    const serverUrl = await db.getSetting('serverUrl', 'http://127.0.0.1:11434');
    api = new OllamaAPI(serverUrl);
    state.set(KEYS.API, api);
    logInit(`Ollama 地址: ${serverUrl}`);

    state.set(KEYS.CURRENT_SESSION, createNewSession());
    state.set(KEYS.IS_STREAMING, false);
    state.set(KEYS.IS_HISTORY_VIEW, false);
    state.set(KEYS.NUM_CTX, 24576);

    initToast();
    initLightbox();
    initHeader();
    initModelBar();
    initChatArea();
    initInputArea();
    initSettingsModal();
    initHistoryModal();
    initKBModal();
    initHelpModal();
    initToolConfirmModal();
    initMemoryPanel();
    initLogPanel();
    setupDesktopIntegration();

    bindGlobalEvents();

    await checkConnection();
    await loadModels();
    await initVectorStore();
    await initMemoryManager();
    logInit('所有组件已就绪');

    const savedModel = await db.getSetting('selectedModel', '');
    if (savedModel) {
      setSelectedModel(savedModel);
      state.set('_defaultModel', savedModel);
      await db.saveSetting('selectedModel', savedModel);
    }

    const systemPromptEnabled = await db.getSetting('systemPromptEnabled', false);
    const systemPrompt = await db.getSetting('systemPrompt', '');
    const numCtx = await db.getSetting('numCtx', 24576);
    const temperature = await db.getSetting('temperature', 0.7);

    state.set(KEYS.SYSTEM_PROMPT_ENABLED, systemPromptEnabled);
    state.set(KEYS.SYSTEM_PROMPT, systemPrompt);
    state.set(KEYS.NUM_CTX, numCtx);
    state.set('temperature', temperature);

    (document.querySelector('#toggleSystemPrompt') as HTMLInputElement).checked = systemPromptEnabled;
    (document.querySelector('#inputSystemPrompt') as HTMLTextAreaElement).disabled = !systemPromptEnabled;
    (document.querySelector('#inputSystemPrompt') as HTMLTextAreaElement).value = systemPrompt;
    (document.querySelector('#inputNumCtx') as HTMLInputElement).value = String(numCtx);
    (document.querySelector('#inputTemperature') as HTMLInputElement).value = String(temperature);
    document.querySelector('#tempValue')!.textContent = parseFloat(temperature).toFixed(1);

    // ── Tool Calling 设置 ──
    const toolCallingEnabled = await db.getSetting('toolCallingEnabled', false);
    const runCommandEnabled = await db.getSetting('runCommandEnabled', false);
    state.set('toolCallingEnabled', toolCallingEnabled);
    state.set('runCommandEnabled', runCommandEnabled);
    if (runCommandEnabled) setToolEnabled('run_command', true);
    const toggleTC = document.querySelector<HTMLInputElement>('#toggleToolCalling');
    if (toggleTC) toggleTC.checked = toolCallingEnabled;
    const toggleRC = document.querySelector<HTMLInputElement>('#toggleRunCommand');
    if (toggleRC) toggleRC.checked = runCommandEnabled;

    // ── Agent 记忆设置 ──
    const memoryEnabled = await db.getSetting('memoryEnabled', true);
    state.set('memoryEnabled', memoryEnabled);

    (document.querySelector('#chatInput') as HTMLElement)?.focus();

    console.log('[App] 初始化完成');
    logSuccess('应用初始化完成');
  } catch (err) {
    console.error('[App] 初始化失败:', err);
    logError('初始化失败', (err as Error).message);
    if (!api!) {
      api = new OllamaAPI();
      state.set(KEYS.API, api);
    }
    state.set(KEYS.CURRENT_SESSION, createNewSession());
    bindGlobalEvents();
    initToast();
    initLightbox();
    initHeader();
    initModelBar();
    initChatArea();
    initInputArea();
    initSettingsModal();
    initHistoryModal();
    setupDesktopIntegration();
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
      (document.querySelector('#helpModal') as HTMLElement).style.display = 'none';
      (document.querySelector('#kbModal') as HTMLElement).style.display = 'none';
    }
  });

  window.addEventListener('error', (e) => {
    console.error('[App] 未捕获错误:', e.error || e.message);
    showToast(`发生错误: ${e.message}`, 'error', 5000);
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[App] 未处理 Promise 拒绝:', e.reason);
    const msg = e.reason?.message || String(e.reason);
    showToast(`操作失败: ${msg}`, 'error', 5000);
  });
}

init();
