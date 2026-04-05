/**
 * PresetBar - 预设栏组件
 *
 * 在模型栏下方显示预设胶囊按钮列表，点击即切换
 * 右侧"+"按钮打开管理面板
 */

import { state, KEYS } from '../state.js';
import {
    getPresets, getActivePresetId, activatePreset,
    createPreset, updatePreset, deletePreset
} from '../preset-manager.js';
import { showToast } from './toast.js';

let presetBarEl;
let presetListEl;
let editingPresetId = null;

export function initPresetBar() {
    // 创建预设栏 DOM
    const modelBar = document.querySelector('.model-bar');
    if (!modelBar) return;

    const bar = document.createElement('div');
    bar.className = 'preset-bar';
    bar.innerHTML = `
        <div class="preset-list" id="presetList"></div>
        <button class="preset-add-btn" id="btnAddPreset" title="管理预设">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
        </button>
    `;
    modelBar.after(bar);

    presetBarEl = bar;
    presetListEl = bar.querySelector('#presetList');

    // 点击"+"打开管理面板
    bar.querySelector('#btnAddPreset').addEventListener('click', openPresetModal);

    // 监听预设变化，刷新 UI
    state.on('activePresetId', renderPresetBar);
    state.on('presets', renderPresetBar);

    // 初始渲染
    renderPresetBar();
}

/**
 * 渲染预设胶囊列表
 */
function renderPresetBar() {
    if (!presetListEl) return;

    const presets = getPresets();
    const activeId = getActivePresetId();

    presetListEl.innerHTML = '';

    for (const preset of presets) {
        const chip = document.createElement('button');
        chip.className = 'preset-chip' + (preset.id === activeId ? ' active' : '');
        chip.title = preset.systemPrompt ? preset.systemPrompt.slice(0, 100) : '无系统提示词';
        chip.innerHTML = `<span class="preset-chip-icon">${preset.icon}</span><span class="preset-chip-name">${escapeHtml(preset.name)}</span>`;

        chip.addEventListener('click', () => handlePresetClick(preset.id));
        // 右键编辑（仅自定义）
        chip.addEventListener('contextmenu', (e) => {
            if (!preset.builtIn) {
                e.preventDefault();
                editingPresetId = preset.id;
                openPresetModal(preset);
            }
        });

        presetListEl.appendChild(chip);
    }
}

async function handlePresetClick(presetId) {
    const currentId = getActivePresetId();
    if (presetId === currentId) return; // 已激活，不重复切换

    await activatePreset(presetId);

    const preset = getPresets().find(p => p.id === presetId);
    if (preset) {
        showToast(`已切换到 ${preset.icon} ${preset.name}`, 'success', 2000);
    }
}

// ═══════════════════════════════════════
// 预设管理模态框
// ═══════════════════════════════════════

function openPresetModal(editPreset) {
    const modal = document.querySelector('#presetModal');
    const titleEl = modal.querySelector('#presetModalTitle');
    const nameInput = modal.querySelector('#inputPresetName');
    const iconInput = modal.querySelector('#inputPresetIcon');
    const spInput = modal.querySelector('#inputPresetSystemPrompt');
    const tempInput = modal.querySelector('#inputPresetTemp');
    const tempVal = modal.querySelector('#presetTempValue');
    const ctxInput = modal.querySelector('#inputPresetNumCtx');
    const thinkCheck = modal.querySelector('#togglePresetThink');
    const btnSave = modal.querySelector('#btnSavePreset');
    const btnDelete = modal.querySelector('#btnDeletePreset');

    if (editPreset && editPreset.id) {
        // 编辑模式
        editingPresetId = editPreset.id;
        titleEl.textContent = '✏️ 编辑预设';
        nameInput.value = editPreset.name;
        iconInput.value = editPreset.icon;
        spInput.value = editPreset.systemPrompt;
        tempInput.value = editPreset.temperature ?? 0.7;
        tempVal.textContent = (editPreset.temperature ?? 0.7).toFixed(1);
        ctxInput.value = editPreset.numCtx || 24576;
        thinkCheck.checked = editPreset.think ?? false;
        btnDelete.style.display = editPreset.builtIn ? 'none' : '';
        btnSave.textContent = '保存';
    } else {
        // 新建模式
        editingPresetId = null;
        titleEl.textContent = '✨ 新建预设';
        nameInput.value = '';
        iconInput.value = '🤖';
        spInput.value = '';
        tempInput.value = 0.7;
        tempVal.textContent = '0.7';
        ctxInput.value = 24576;
        thinkCheck.checked = false;
        btnDelete.style.display = 'none';
        btnSave.textContent = '创建';
    }

    modal.style.display = '';
    nameInput.focus();

    // 温度滑块实时更新
    tempInput.oninput = () => {
        tempVal.textContent = parseFloat(tempInput.value).toFixed(1);
    };
}

export function initPresetModal() {
    const modal = document.querySelector('#presetModal');
    if (!modal) return;

    // 关闭
    modal.querySelector('#btnClosePresetModal').addEventListener('click', () => {
        modal.style.display = 'none';
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    // 保存
    modal.querySelector('#btnSavePreset').addEventListener('click', async () => {
        const name = modal.querySelector('#inputPresetName').value.trim();
        if (!name) {
            showToast('请输入预设名称', 'warning');
            return;
        }

        const data = {
            name,
            icon: modal.querySelector('#inputPresetIcon').value.trim() || '🤖',
            systemPrompt: modal.querySelector('#inputPresetSystemPrompt').value.trim(),
            temperature: parseFloat(modal.querySelector('#inputPresetTemp').value) || 0.7,
            numCtx: parseInt(modal.querySelector('#inputPresetNumCtx').value) || 24576,
            think: modal.querySelector('#togglePresetThink').checked
        };

        if (editingPresetId) {
            await updatePreset(editingPresetId, data);
            showToast('预设已更新', 'success', 2000);
            // 如果更新的是当前激活预设，重新应用
            if (editingPresetId === getActivePresetId()) {
                await activatePreset(editingPresetId);
            }
        } else {
            const created = await createPreset(data);
            // 自动激活新建的预设
            await activatePreset(created.id);
            showToast(`已创建并激活 ${data.icon} ${data.name}`, 'success', 2000);
        }

        modal.style.display = 'none';
        editingPresetId = null;
    });

    // 删除
    modal.querySelector('#btnDeletePreset').addEventListener('click', async () => {
        if (!editingPresetId) return;
        const preset = getPresets().find(p => p.id === editingPresetId);
        if (!preset) return;

        if (confirm(`确定删除预设 "${preset.icon} ${preset.name}" ？`)) {
            await deletePreset(editingPresetId);
            showToast('预设已删除', 'info', 2000);
            modal.style.display = 'none';
            editingPresetId = null;
        }
    });
}

function escapeHtml(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(str).replace(/[&<>"']/g, c => map[c]);
}
