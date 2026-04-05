/**
 * PresetBar - 预设栏组件
 */

import { state, KEYS } from '../state/state.js';
import {
  getPresets, getActivePresetId, activatePreset,
  createPreset, updatePreset, deletePreset
} from '../services/preset-manager.js';
import { showToast } from './toast.js';
import type { Preset } from '../types.js';

let presetBarEl: HTMLElement;
let presetListEl: HTMLElement;
let editingPresetId: string | null = null;

function escapeHtml(str: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, c => map[c]);
}

export function initPresetBar(): void {
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
  presetListEl = bar.querySelector('#presetList')!;

  bar.querySelector('#btnAddPreset')!.addEventListener('click', () => openPresetModal());

  state.on('activePresetId', renderPresetBar);
  state.on('presets', renderPresetBar);

  renderPresetBar();
}

function renderPresetBar(): void {
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

async function handlePresetClick(presetId: string): Promise<void> {
  const currentId = getActivePresetId();
  if (presetId === currentId) return;

  await activatePreset(presetId);

  const preset = getPresets().find(p => p.id === presetId);
  if (preset) {
    showToast(`已切换到 ${preset.icon} ${preset.name}`, 'success', 2000);
  }
}

function openPresetModal(editPreset?: Preset): void {
  const modal = document.querySelector('#presetModal') as HTMLElement;
  const titleEl = modal.querySelector('#presetModalTitle')!;
  const nameInput = modal.querySelector('#inputPresetName') as HTMLInputElement;
  const iconInput = modal.querySelector('#inputPresetIcon') as HTMLInputElement;
  const spInput = modal.querySelector('#inputPresetSystemPrompt') as HTMLTextAreaElement;
  const tempInput = modal.querySelector('#inputPresetTemp') as HTMLInputElement;
  const tempVal = modal.querySelector('#presetTempValue')!;
  const ctxInput = modal.querySelector('#inputPresetNumCtx') as HTMLInputElement;
  const thinkCheck = modal.querySelector('#togglePresetThink') as HTMLInputElement;
  const btnSave = modal.querySelector('#btnSavePreset') as HTMLButtonElement;
  const btnDelete = modal.querySelector('#btnDeletePreset') as HTMLElement;

  if (editPreset && editPreset.id) {
    editingPresetId = editPreset.id;
    titleEl.textContent = '✏️ 编辑预设';
    nameInput.value = editPreset.name;
    iconInput.value = editPreset.icon;
    spInput.value = editPreset.systemPrompt;
    tempInput.value = String(editPreset.temperature ?? 0.7);
    tempVal.textContent = (editPreset.temperature ?? 0.7).toFixed(1);
    ctxInput.value = String(editPreset.numCtx || 24576);
    thinkCheck.checked = editPreset.think ?? false;
    btnDelete.style.display = editPreset.builtIn ? 'none' : '';
    btnSave.textContent = '保存';
  } else {
    editingPresetId = null;
    titleEl.textContent = '✨ 新建预设';
    nameInput.value = '';
    iconInput.value = '🤖';
    spInput.value = '';
    tempInput.value = '0.7';
    tempVal.textContent = '0.7';
    ctxInput.value = '24576';
    thinkCheck.checked = false;
    btnDelete.style.display = 'none';
    btnSave.textContent = '创建';
  }

  modal.style.display = '';
  nameInput.focus();

  tempInput.oninput = () => {
    tempVal.textContent = parseFloat(tempInput.value).toFixed(1);
  };
}

export function initPresetModal(): void {
  const modal = document.querySelector('#presetModal') as HTMLElement;
  if (!modal) return;

  modal.querySelector('#btnClosePresetModal')!.addEventListener('click', () => {
    modal.style.display = 'none';
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  modal.querySelector('#btnSavePreset')!.addEventListener('click', async () => {
    const name = (modal.querySelector('#inputPresetName') as HTMLInputElement).value.trim();
    if (!name) { showToast('请输入预设名称', 'warning'); return; }

    const data = {
      name,
      icon: (modal.querySelector('#inputPresetIcon') as HTMLInputElement).value.trim() || '🤖',
      systemPrompt: (modal.querySelector('#inputPresetSystemPrompt') as HTMLTextAreaElement).value.trim(),
      temperature: parseFloat((modal.querySelector('#inputPresetTemp') as HTMLInputElement).value) || 0.7,
      numCtx: parseInt((modal.querySelector('#inputPresetNumCtx') as HTMLInputElement).value) || 24576,
      think: (modal.querySelector('#togglePresetThink') as HTMLInputElement).checked
    };

    if (editingPresetId) {
      await updatePreset(editingPresetId, data);
      showToast('预设已更新', 'success', 2000);
      if (editingPresetId === getActivePresetId()) {
        await activatePreset(editingPresetId);
      }
    } else {
      const created = await createPreset(data);
      await activatePreset(created.id);
      showToast(`已创建并激活 ${data.icon} ${data.name}`, 'success', 2000);
    }

    modal.style.display = 'none';
    editingPresetId = null;
  });

  modal.querySelector('#btnDeletePreset')!.addEventListener('click', async () => {
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
