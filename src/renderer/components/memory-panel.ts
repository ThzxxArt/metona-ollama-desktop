/**
 * MemoryPanel - Agent 记忆管理面板
 * 提供记忆的查看、搜索、编辑、删除功能
 */

import { state, KEYS } from '../state/state.js';
import {
  getMemoryCache, searchMemories, addMemory, updateMemory, deleteMemory,
  clearAllMemories, isMemoryEnabled, setMemoryEnabled,
  getTypeIcon, getTypeName
} from '../services/memory-manager.js';
import { showToast } from './toast.js';
import { showPrompt, showConfirm } from './prompt-modal.js';
import { debounce, escapeHtml, formatTime } from '../utils/utils.js';
import type { MemoryEntry, MemoryType } from '../types.js';

let panelEl: HTMLElement;
let isOpen = false;

export function initMemoryPanel(): void {
  // 绑定 header 中的记忆按钮
  const btnMemory = document.querySelector('#btnMemory');
  if (!btnMemory) return;

  // 创建记忆面板
  const panel = document.createElement('div');
  panel.className = 'memory-panel';
  panel.id = 'memoryPanel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="memory-panel-header">
      <h3>🧠 Agent 记忆</h3>
      <div class="memory-panel-actions">
        <label class="memory-toggle" title="自动记忆">
          <input type="checkbox" id="toggleMemoryPanelEnabled" checked>
          <span class="toggle-slider-sm"></span>
        </label>
        <button class="icon-btn sm" id="btnCloseMemoryPanel" title="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="memory-panel-search">
      <input type="text" id="memorySearchInput" placeholder="搜索记忆..." class="memory-search-input">
      <select id="memoryTypeFilter" class="memory-type-filter">
        <option value="">全部类型</option>
        <option value="fact">📌 事实</option>
        <option value="preference">⚙️ 偏好</option>
        <option value="rule">📏 规则</option>
        <option value="episode">📝 事件</option>
      </select>
    </div>
    <div class="memory-panel-actions-row">
      <button class="btn btn-sm btn-outline" id="btnAddMemory">＋ 添加记忆</button>
      <button class="btn btn-sm btn-danger-outline" id="btnClearMemories">清空</button>
    </div>
    <div class="memory-list" id="memoryList"></div>
  `;

  document.querySelector('#app')!.appendChild(panel);
  panelEl = panel;

  // 绑定事件
  btnMemory.addEventListener('click', togglePanel);
  panel.querySelector('#btnCloseMemoryPanel')!.addEventListener('click', () => setPanelOpen(false));

  const toggleMemory = panel.querySelector('#toggleMemoryPanelEnabled') as HTMLInputElement;
  toggleMemory.checked = isMemoryEnabled();
  toggleMemory.addEventListener('change', () => {
    setMemoryEnabled(toggleMemory.checked);
    showToast(toggleMemory.checked ? '自动记忆已开启' : '自动记忆已关闭', 'info');
  });

  const searchInput = panel.querySelector('#memorySearchInput') as HTMLInputElement;
  const typeFilter = panel.querySelector('#memoryTypeFilter') as HTMLSelectElement;
  searchInput.addEventListener('input', debounce(() => renderMemoryList(), 200));
  typeFilter.addEventListener('change', () => renderMemoryList());

  panel.querySelector('#btnAddMemory')!.addEventListener('click', () => openAddMemoryDialog());
  panel.querySelector('#btnClearMemories')!.addEventListener('click', async () => {
    if (await showConfirm('确定清空所有记忆？此操作不可恢复！', '清空记忆')) {
      await clearAllMemories();
      renderMemoryList();
      updateMemoryCount();
      showToast('已清空所有记忆', 'success');
    }
  });

  state.on('memoryEntries', () => {
    updateMemoryCount();
    if (isOpen) renderMemoryList();
  });

  updateMemoryCount();
}

function togglePanel(): void {
  setPanelOpen(!isOpen);
}

function setPanelOpen(open: boolean): void {
  isOpen = open;
  panelEl.style.display = open ? '' : 'none';
  if (open) {
    renderMemoryList();
    (panelEl.querySelector('#memorySearchInput') as HTMLInputElement)?.focus();
  }
}

function updateMemoryCount(): void {
  const count = getMemoryCache().length;
  const btn = document.querySelector('#btnMemory');
  if (btn) btn.setAttribute('title', count > 0 ? `Agent 记忆 (${count})` : 'Agent 记忆');
}

function renderMemoryList(): void {
  const listEl = panelEl.querySelector('#memoryList')!;
  const searchInput = panelEl.querySelector('#memorySearchInput') as HTMLInputElement;
  const typeFilter = panelEl.querySelector('#memoryTypeFilter') as HTMLSelectElement;

  const query = searchInput.value.trim();
  const type = typeFilter.value;

  let entries: MemoryEntry[];

  if (query) {
    entries = searchMemories(query, 20).map(r => ({
      ...r,
      score: undefined
    }));
  } else {
    entries = getMemoryCache();
  }

  if (type) {
    entries = entries.filter(e => e.type === type);
  }

  entries.sort((a, b) => {
    if (a.importance !== b.importance) return b.importance - a.importance;
    return b.updatedAt - a.updatedAt;
  });

  if (entries.length === 0) {
    listEl.innerHTML = `<div class="memory-empty">${query ? '未找到匹配的记忆' : '暂无记忆，AI 会自动在对话中学习'}</div>`;
    return;
  }

  listEl.innerHTML = entries.map(entry => {
    const icon = getTypeIcon(entry.type);
    const typeName = getTypeName(entry.type);
    const importanceDots = '●'.repeat(Math.min(entry.importance, 10)) + '○'.repeat(Math.max(0, 10 - entry.importance));
    return `
      <div class="memory-item" data-id="${entry.id}">
        <div class="memory-item-header">
          <span class="memory-item-icon">${icon}</span>
          <span class="memory-item-type">${typeName}</span>
          <span class="memory-item-importance" title="重要性 ${entry.importance}/10">${importanceDots}</span>
          <button class="memory-item-delete" data-id="${entry.id}" title="删除">✕</button>
        </div>
        <div class="memory-item-content">${escapeHtml(entry.content)}</div>
        <div class="memory-item-meta">
          ${entry.tags.length > 0 ? `<span class="memory-item-tags">${entry.tags.map(t => `<span class="memory-tag">${escapeHtml(t)}</span>`).join('')}</span>` : ''}
          <span class="memory-item-time">${formatTime(entry.updatedAt)}</span>
        </div>
      </div>
    `;
  }).join('');

  // 绑定删除按钮
  listEl.querySelectorAll('.memory-item-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id!;
      await deleteMemory(id);
      renderMemoryList();
      updateMemoryCount();
      showToast('记忆已删除', 'info', 1500);
    });
  });

  // 点击编辑
  listEl.querySelectorAll('.memory-item-content').forEach(el => {
    el.addEventListener('dblclick', () => {
      const item = (el as HTMLElement).closest('.memory-item')!;
      const id = item.getAttribute('data-id')!;
      const entry = getMemoryCache().find(e => e.id === id);
      if (entry) openEditMemoryDialog(entry);
    });
  });
}

async function openAddMemoryDialog(): Promise<void> {
  const type = await showPrompt({
    title: '添加记忆',
    message: '选择记忆类型：',
    type: 'select',
    defaultValue: 'fact',
    options: [
      { value: 'fact', label: '📌 事实 — 项目信息、身份背景' },
      { value: 'preference', label: '⚙️ 偏好 — 语言风格、技术栈偏好' },
      { value: 'rule', label: '📏 规则 — 编码规范、输出要求' },
      { value: 'episode', label: '📝 事件 — 完成的任务、结论' }
    ]
  });
  if (type === null) return;
  const memoryType = (type as MemoryType) || 'fact';

  const content = await showPrompt({
    title: '添加记忆',
    message: '请输入记忆内容：',
    type: 'textarea',
    placeholder: '例如：用户正在开发一个 Electron 桌面应用'
  });
  if (!content?.trim()) return;

  const importanceStr = await showPrompt({
    title: '添加记忆',
    message: '重要性（1-10，默认 5）：',
    defaultValue: '5',
    placeholder: '5'
  });
  const importance = Math.min(10, Math.max(1, parseInt(importanceStr || '5') || 5));

  await addMemory({ type: memoryType, content: content.trim(), importance });
  renderMemoryList();
  updateMemoryCount();
  showToast('记忆已添加', 'success', 1500);
}

async function openEditMemoryDialog(entry: MemoryEntry): Promise<void> {
  const newContent = await showPrompt({
    title: '编辑记忆',
    message: '修改记忆内容：',
    type: 'textarea',
    defaultValue: entry.content
  });
  if (newContent === null || newContent.trim() === entry.content) return;

  const importanceStr = await showPrompt({
    title: '编辑记忆',
    message: '重要性（1-10）：',
    defaultValue: String(entry.importance),
    placeholder: String(entry.importance)
  });
  const importance = importanceStr ? Math.min(10, Math.max(1, parseInt(importanceStr) || entry.importance)) : entry.importance;

  await updateMemory(entry.id, { content: newContent.trim(), importance });
  renderMemoryList();
  showToast('记忆已更新', 'success', 1500);
}
