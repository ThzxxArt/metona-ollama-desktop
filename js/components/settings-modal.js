/**
 * SettingsModal - 设置面板组件
 */

import { state, KEYS } from '../state.js';
import { debounce, formatSize } from '../utils.js';
import { updateConnectionInfo, updateRunningModels } from './header.js';
import { loadModels } from './model-bar.js';
import { showToast } from './toast.js';
import { OllamaAPI } from '../../ollama-api.js';

let settingsModalEl;

export function initSettingsModal() {
    settingsModalEl = document.querySelector('#settingsModal');

    // 打开/关闭
    document.querySelector('#btnSettings').addEventListener('click', openSettingsModal);
    document.querySelector('#btnCloseSettings').addEventListener('click', closeSettingsModal);
    settingsModalEl.addEventListener('click', (e) => {
        if (e.target === settingsModalEl) closeSettingsModal();
    });

    // 保存服务器地址
    const saveServerUrl = debounce(async () => {
        const url = document.querySelector('#inputServerUrl').value.trim();
        if (!url) return;
        const db = state.get(KEYS.DB);
        const api = new OllamaAPI(url);
        state.set(KEYS.API, api);
        if (db) await db.saveSetting('serverUrl', url);
        updateConnectionInfo();
        loadModels();
    }, 500);
    document.querySelector('#inputServerUrl').addEventListener('input', saveServerUrl);

    // 系统提示词开关
    document.querySelector('#toggleSystemPrompt').addEventListener('change', async (e) => {
        const db = state.get(KEYS.DB);
        state.set(KEYS.SYSTEM_PROMPT_ENABLED, e.target.checked);
        document.querySelector('#inputSystemPrompt').disabled = !e.target.checked;
        if (db) await db.saveSetting('systemPromptEnabled', e.target.checked);
    });

    // 保存系统提示词
    const saveSystemPrompt = debounce(async () => {
        const db = state.get(KEYS.DB);
        const val = document.querySelector('#inputSystemPrompt').value.trim();
        state.set(KEYS.SYSTEM_PROMPT, val);
        if (db) await db.saveSetting('systemPrompt', val);
    }, 500);
    document.querySelector('#inputSystemPrompt').addEventListener('input', saveSystemPrompt);

    // 保存上下文长度
    const saveNumCtx = debounce(async () => {
        const db = state.get(KEYS.DB);
        const val = document.querySelector('#inputNumCtx').value.trim();
        const numCtx = val ? parseInt(val) : 24576;
        state.set(KEYS.NUM_CTX, numCtx);
        if (db) await db.saveSetting('numCtx', numCtx);
    }, 500);
    document.querySelector('#inputNumCtx').addEventListener('input', saveNumCtx);

    // 释放显存
    document.querySelector('#btnReleaseVRAM').addEventListener('click', async () => {
        const api = state.get(KEYS.API);
        const model = document.querySelector('#modelSelect').value;
        try {
            await api.chat({ model: model || 'any', messages: [], keep_alive: 0 });
            showToast('显存已释放', 'success');
            updateRunningModels();
        } catch (err) {
            showToast(`释放失败: ${err.message}`, 'error');
        }
    });

    // 清空所有历史
    document.querySelector('#btnClearAllHistory').addEventListener('click', async () => {
        const db = state.get(KEYS.DB);
        if (confirm('确定清空所有历史记录？此操作不可恢复！')) {
            await db.clearAll();
            // 触发新会话
            document.querySelector('#btnNewChat').click();
            showToast('已清空所有历史记录', 'success');
        }
    });

    // 导出全部会话
    document.querySelector('#btnExportAll').addEventListener('click', exportAllSessions);

    // 导入会话
    const importFileInput = document.querySelector('#importFileInput');
    document.querySelector('#btnImportSessions').addEventListener('click', () => importFileInput.click());
    importFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            importSessions(e.target.files[0]);
            e.target.value = '';
        }
    });
}

export function openSettingsModal() {
    settingsModalEl.style.display = '';
    document.querySelector('#inputServerUrl').value = state.get(KEYS.API)?.baseUrl || '';
    updateConnectionInfo();
    updateRunningModels();
}

export function closeSettingsModal() {
    settingsModalEl.style.display = 'none';
}

async function exportAllSessions() {
    const db = state.get(KEYS.DB);
    if (!db) return;
    const sessions = await db.getAllSessions();
    if (sessions.length === 0) {
        showToast('没有可导出的会话', 'warning');
        return;
    }

    const backup = {
        app: 'Metona Ollama Client',
        version: 1,
        exportedAt: new Date().toISOString(),
        count: sessions.length,
        sessions
    };

    const json = JSON.stringify(backup, null, 2);
    const ts = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
    a.download = `metona-backup-${ts}.json`;
    a.click();
    showToast(`已导出 ${sessions.length} 个会话`, 'success');
}

async function importSessions(file) {
    const db = state.get(KEYS.DB);
    if (!db) return;

    try {
        const text = await file.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            showToast('文件格式错误：不是有效的 JSON', 'error');
            return;
        }

        let sessions;
        if (Array.isArray(data)) {
            sessions = data;
        } else if (data.sessions && Array.isArray(data.sessions)) {
            sessions = data.sessions;
        } else {
            showToast('文件格式错误：未找到会话数据', 'error');
            return;
        }

        const result = await db.importSessions(sessions);
        showToast(`导入完成：${result.imported} 个会话${result.skipped > 0 ? `，跳过 ${result.skipped} 个` : ''}`, 'success', 4000);
    } catch (err) {
        console.error('[Settings] 导入失败:', err);
        showToast(`导入失败: ${err.message}`, 'error');
    }
}
