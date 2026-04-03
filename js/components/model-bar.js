/**
 * ModelBar - 模型选择栏组件
 */

import { state, KEYS } from '../state.js';
import { formatSize } from '../utils.js';
import { showToast } from './toast.js';

let modelSelectEl, toggleThinkEl;

export function initModelBar() {
    modelSelectEl = document.querySelector('#modelSelect');
    toggleThinkEl = document.querySelector('#toggleThink');

    // 模型选择变化 → 保存到设置
    modelSelectEl.addEventListener('change', async () => {
        const db = state.get(KEYS.DB);
        if (db) await db.saveSetting('selectedModel', modelSelectEl.value);
    });
}

/**
 * 加载模型列表
 */
export async function loadModels() {
    const api = state.get(KEYS.API);
    const db = state.get(KEYS.DB);
    const currentSession = state.get(KEYS.CURRENT_SESSION);

    if (!api) return;

    try {
        const data = await api.listModels();
        modelSelectEl.innerHTML = '';
        if (!data.models || data.models.length === 0) {
            modelSelectEl.innerHTML = '<option value="">未安装任何模型</option>';
            return;
        }

        data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = `${m.name} (${formatSize(m.size)})`;
            modelSelectEl.appendChild(opt);
        });

        // 恢复上次选择的模型
        if (currentSession && currentSession.model) {
            modelSelectEl.value = currentSession.model;
        }

        if (db) await db.saveSetting('selectedModel', modelSelectEl.value);
    } catch (err) {
        console.error('[ModelBar] 加载模型失败:', err);
        modelSelectEl.innerHTML = '<option value="">加载失败 - 检查连接</option>';
    }
}

/**
 * 获取当前选择的模型
 */
export function getSelectedModel() {
    return modelSelectEl.value;
}

/**
 * 设置选中的模型
 */
export function setSelectedModel(modelName) {
    modelSelectEl.value = modelName;
}

/**
 * Think 模式是否开启
 */
export function isThinkEnabled() {
    return toggleThinkEl.checked;
}
