/**
 * Header - 顶部导航组件
 * 包含连接状态检测、新建会话按钮
 */

import { state, KEYS } from '../state.js';
import { formatSize } from '../utils.js';
import { OllamaAPI } from '../../ollama-api.js';

let connStatusEl;

export function initHeader() {
    connStatusEl = document.querySelector('#connStatus');
}

/**
 * 检测连接状态并更新 UI
 * @returns {Promise<{ok: boolean, version?: object, error?: Error}>}
 */
export async function checkConnection() {
    const api = state.get(KEYS.API);
    if (!api) return { ok: false, error: new Error('API 未初始化') };

    connStatusEl.className = 'conn-status pending';
    connStatusEl.querySelector('.status-label').textContent = '连接中...';

    try {
        const version = await api.getVersion();
        connStatusEl.className = 'conn-status connected';
        connStatusEl.title = `已连接 (v${version.version})`;
        connStatusEl.querySelector('.status-label').textContent = '已连接';
        return { ok: true, version };
    } catch (err) {
        connStatusEl.className = 'conn-status disconnected';
        connStatusEl.title = '未连接';
        connStatusEl.querySelector('.status-label').textContent = '未连接';
        return { ok: false, error: err };
    }
}

/**
 * 更新设置面板中的连接信息
 */
export async function updateConnectionInfo() {
    const api = state.get(KEYS.API);
    if (!api) return;

    const badge = document.querySelector('#connBadge');
    const verEl = document.querySelector('#serverVersion');
    const corsHint = document.querySelector('#corsHint');

    badge.textContent = '检测中...';
    badge.className = 'status-badge warning';
    verEl.textContent = '';

    try {
        const version = await api.getVersion();
        badge.textContent = '✓ 已连接';
        badge.className = 'status-badge success';
        verEl.textContent = `v${version.version}`;
        corsHint.style.display = 'none';
    } catch (err) {
        badge.textContent = '✗ 未连接';
        badge.className = 'status-badge error';
        verEl.textContent = '';

        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('CORS')) {
            corsHint.style.display = '';
        } else {
            corsHint.style.display = 'none';
        }
    }
}

/**
 * 更新运行中的模型列表
 */
export async function updateRunningModels() {
    const api = state.get(KEYS.API);
    if (!api) return;

    const container = document.querySelector('#runningModels');
    try {
        const data = await api.psModels();
        if (!data.models || data.models.length === 0) {
            container.innerHTML = '<p class="text-muted">无运行中的模型</p>';
            return;
        }
        container.innerHTML = data.models.map(m => `
            <div class="running-model">
                <span class="model-name">${m.name}</span>
                <span class="model-vram">${formatSize(m.size_vram || 0)} VRAM</span>
            </div>
        `).join('');
    } catch {
        container.innerHTML = '<p class="text-muted">无法获取运行信息</p>';
    }
}
