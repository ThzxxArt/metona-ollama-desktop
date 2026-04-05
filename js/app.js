/**
 * App - 主入口模块
 * 负责初始化所有组件、协调事件流、管理生命周期
 */

import { ChatDB } from './chat-db.js';
import { OllamaAPI } from './ollama-api.js';
import { state, KEYS } from './state.js';
import { generateId } from './utils.js';

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
import { initPresetBar, initPresetModal } from './components/preset-bar.js';
import { initPresetManager } from './preset-manager.js';
import { initVectorStore } from './rag.js';

function initHelpModal() {
    const helpModal = document.querySelector('#helpModal');
    document.querySelector('#btnHelp').addEventListener('click', () => {
        helpModal.style.display = '';
    });
    document.querySelector('#btnCloseHelp').addEventListener('click', () => {
        helpModal.style.display = 'none';
    });
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) helpModal.style.display = 'none';
    });
}

console.log('[Metona] 模块化版本 v4.0.0 ' + new Date().toISOString());

// ── 会话管理 ──

function createNewSession() {
    const selectedModel = document.querySelector('#modelSelect')?.value || '';
    const defaultModel = selectedModel || state.get('_defaultModel', '');
    return {
        id: generateId(),
        title: '新会话',
        model: defaultModel,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

async function startNewSession() {
    // 先保存当前会话（如果有的话）
    const db = state.get(KEYS.DB);
    const currentSession = state.get(KEYS.CURRENT_SESSION);
    if (db && currentSession && currentSession.messages.length > 0) {
        currentSession.updatedAt = Date.now();
        await db.saveSession(currentSession);
    }

    // 释放显存，清理模型上下文
    const api = state.get(KEYS.API);
    const model = currentSession?.model || state.get('_defaultModel', '');
    if (api && model) {
        try {
            await api.chat({ model, messages: [], keep_alive: 0 });
        } catch (e) {
            console.warn('[App] 释放显存失败:', e);
        }
    }

    const session = createNewSession();
    state.set(KEYS.CURRENT_SESSION, session);
    state.set(KEYS.IS_HISTORY_VIEW, false);

    document.querySelector('#historyBar').style.display = 'none';
    document.querySelector('#inputArea').style.display = '';

    clearMessages();
    enableAutoScroll();
    renderMessages();
    document.querySelector('#chatInput')?.focus();
}

// ── 初始化 ──

async function init() {
    let db, api;

    try {
        // 1. 初始化 IndexedDB
        db = new ChatDB();
        await db.init();
        state.set(KEYS.DB, db);

        // 2. 读取保存的设置
        const serverUrl = await db.getSetting('serverUrl', 'http://127.0.0.1:11434');
        api = new OllamaAPI(serverUrl);
        state.set(KEYS.API, api);

        // 3. 创建初始会话
        state.set(KEYS.CURRENT_SESSION, createNewSession());
        state.set(KEYS.IS_STREAMING, false);
        state.set(KEYS.IS_HISTORY_VIEW, false);
        state.set(KEYS.NUM_CTX, 24576);

        // 4. 初始化所有组件
        initToast();
        initLightbox();
        initHeader();
        initModelBar();
        initChatArea();
        initInputArea();
        initSettingsModal();
        initHistoryModal();
        initKBModal();
        initPresetBar();
        initPresetModal();
        initHelpModal();

        // 5. 绑定全局事件
        bindGlobalEvents();

        // 6. 检测连接 + 加载模型
        await checkConnection();
        await loadModels();

        // 6.1 初始化向量存储
        await initVectorStore();

        // 6.2 初始化预设管理器（会从 DB 加载并应用上次激活的预设）
        await initPresetManager();

        // 7. 恢复上次选择的模型
        const savedModel = await db.getSetting('selectedModel', '');
        if (savedModel) {
            setSelectedModel(savedModel);
            state.set('_defaultModel', savedModel);
            await db.saveSetting('selectedModel', savedModel);
        }

        // 8. 恢复系统提示词和上下文长度
        const systemPromptEnabled = await db.getSetting('systemPromptEnabled', false);
        const systemPrompt = await db.getSetting('systemPrompt', '');
        const numCtx = await db.getSetting('numCtx', 24576);

        state.set(KEYS.SYSTEM_PROMPT_ENABLED, systemPromptEnabled);
        state.set(KEYS.SYSTEM_PROMPT, systemPrompt);
        state.set(KEYS.NUM_CTX, numCtx);

        document.querySelector('#toggleSystemPrompt').checked = systemPromptEnabled;
        document.querySelector('#inputSystemPrompt').disabled = !systemPromptEnabled;
        document.querySelector('#inputSystemPrompt').value = systemPrompt;
        document.querySelector('#inputNumCtx').value = numCtx;

        // 9. 聚焦输入框
        document.querySelector('#chatInput')?.focus();

        // 10. 注册 Service Worker (PWA)
        initServiceWorker();

        console.log('[App] 初始化完成');
    } catch (err) {
        console.error('[App] 初始化失败:', err);
        // 即使 DB 失败也尝试运行
        if (!api) {
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
        initPresetBar();
        initPresetModal();
        initPresetManager();
        checkConnection().then(loadModels);
    }
}

function bindGlobalEvents() {
    // 新建会话
    document.querySelector('#btnNewChat')?.addEventListener('click', startNewSession);

    // ESC 关闭模态框
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeSettingsModal();
            closeHistoryModal();
            closeLightbox();
            document.querySelector('#helpModal').style.display = 'none';
            document.querySelector('#kbModal').style.display = 'none';
        }
    });

    // 全局错误捕获
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

function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.getRegistrations()
        .then(regs => regs.forEach(r => r.unregister()))
        .then(() => caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))))
        .then(() => navigator.serviceWorker.register('sw.js?v=3', { updateViaCache: 'none' }))
        .then(reg => {
            reg.addEventListener('updatefound', () => {
                const w = reg.installing;
                if (w) w.addEventListener('statechange', () => {
                    if (w.state === 'activated') window.location.reload();
                });
            });
            reg.update();
        })
        .catch(err => console.warn('[App] Service Worker 注册失败:', err));
}

// 启动
init();
