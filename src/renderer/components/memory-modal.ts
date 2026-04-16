/**
 * MemoryModal - Agent 记忆管理大模态框
 * 左右分栏布局：左侧分类筛选+统计，右侧搜索+列表+操作
 */

import {
  getMemoryCache, searchMemories, addMemory, updateMemory, deleteMemory,
  clearAllMemories, isMemoryEnabled, setMemoryEnabled,
  getTypeIcon, getTypeName, isVectorMemoryEnabled, getEmbeddingModel
} from '../services/memory-manager.js';
import { showToast } from './toast.js';
import { showPrompt, showConfirm } from './prompt-modal.js';
import { debounce, escapeHtml, formatTime } from '../utils/utils.js';
import type { MemoryEntry, MemoryType } from '../types.js';

let modalEl: HTMLElement;

// ── 初始化 ──

export function initMemoryModal(): void {
  // 创建模态框 DOM
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'memoryModal';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>🧠 Agent 记忆</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          <label class="memory-toggle" title="自动记忆">
            <input type="checkbox" id="memoryModalToggle" checked>
            <span class="toggle-slider"></span>
          </label>
          <button class="icon-btn" id="btnCloseMemoryModal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="modal-body">
        <div class="memory-layout">
          <!-- 左侧边栏 -->
          <div class="memory-sidebar">
            <div class="memory-stats" id="memoryStats">
              <div class="memory-stats-item">
                <span>总计</span>
                <span class="memory-stats-count" id="memStatTotal">0</span>
              </div>
              <div class="memory-stats-item">
                <span>📌 事实</span>
                <span class="memory-stats-count" id="memStatFact">0</span>
              </div>
              <div class="memory-stats-item">
                <span>⚙️ 偏好</span>
                <span class="memory-stats-count" id="memStatPref">0</span>
              </div>
              <div class="memory-stats-item">
                <span>📏 规则</span>
                <span class="memory-stats-count" id="memStatRule">0</span>
              </div>
            </div>
            <div class="memory-categories" id="memoryCategories">
              <div class="memory-category-item active" data-type="">
                <span class="memory-category-icon">📋</span>
                <span>全部</span>
                <span class="memory-category-count" id="catCountAll">0</span>
              </div>
              <div class="memory-category-item" data-type="fact">
                <span class="memory-category-icon">📌</span>
                <span>事实</span>
                <span class="memory-category-count" id="catCountFact">0</span>
              </div>
              <div class="memory-category-item" data-type="preference">
                <span class="memory-category-icon">⚙️</span>
                <span>偏好</span>
                <span class="memory-category-count" id="catCountPref">0</span>
              </div>
              <div class="memory-category-item" data-type="rule">
                <span class="memory-category-icon">📏</span>
                <span>规则</span>
                <span class="memory-category-count" id="catCountRule">0</span>
              </div>
            </div>
          </div>
          <!-- 右侧主区域 -->
          <div class="memory-main">
            <div class="memory-toolbar">
              <div class="memory-search-wrap">
                <input type="text" id="memorySearchLg" class="memory-search-input-lg" placeholder="搜索记忆（支持关键词和语义搜索）...">
              </div>
              <span id="memoryVectorBadge" class="memory-vector-badge disabled">关键词模式</span>
              <button class="btn btn-sm btn-outline" id="btnAddMemoryLg">＋ 添加</button>
              <button class="btn btn-sm btn-danger-outline" id="btnClearMemoryLg">清空</button>
            </div>
            <div class="memory-list-lg" id="memoryListLg"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.querySelector('#app')!.appendChild(overlay);
  modalEl = overlay;

  // 绑定事件
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeMemoryModal();
  });
  overlay.querySelector('#btnCloseMemoryModal')!.addEventListener('click', closeMemoryModal);

  // 自动记忆开关
  const toggle = overlay.querySelector('#memoryModalToggle') as HTMLInputElement;
  toggle.checked = isMemoryEnabled();
  toggle.addEventListener('change', () => {
    setMemoryEnabled(toggle.checked);
    showToast(toggle.checked ? '自动记忆已开启' : '自动记忆已关闭', 'info');
  });

  // 搜索
  const searchInput = overlay.querySelector('#memorySearchLg') as HTMLInputElement;
  searchInput.addEventListener('input', debounce(() => renderList(), 300));

  // 分类筛选
  overlay.querySelectorAll('.memory-category-item').forEach(el => {
    el.addEventListener('click', () => {
      overlay.querySelectorAll('.memory-category-item').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      renderList();
    });
  });

  // 添加记忆
  overlay.querySelector('#btnAddMemoryLg')!.addEventListener('click', openAddDialog);

  // 清空
  overlay.querySelector('#btnClearMemoryLg')!.addEventListener('click', async () => {
    if (await showConfirm('确定清空所有记忆？此操作不可恢复！', '清空记忆')) {
      await clearAllMemories();
      renderList();
      updateStats();
      showToast('已清空所有记忆', 'success');
    }
  });

  // header 按钮
  document.querySelector('#btnMemory')?.addEventListener('click', openMemoryModal);

  // 全局状态监听
  if (typeof (window as any).__memoryStateListener === 'undefined') {
    (window as any).__memoryStateListener = true;
    // 简单轮询：在模态框打开时监听变化
  }
}

// ── 打开/关闭 ──

export function openMemoryModal(): void {
  modalEl.style.display = '';
  (modalEl.querySelector('#memoryModalToggle') as HTMLInputElement).checked = isMemoryEnabled();
  updateVectorBadge();
  updateStats();
  renderList();
  (modalEl.querySelector('#memorySearchLg') as HTMLInputElement).focus();
}

export function closeMemoryModal(): void {
  modalEl.style.display = 'none';
}

// ── 向量记忆状态 ──

function updateVectorBadge(): void {
  const badge = modalEl.querySelector('#memoryVectorBadge')!;
  if (isVectorMemoryEnabled()) {
    badge.textContent = `✅ 向量搜索 (${getEmbeddingModel()})`;
    badge.className = 'memory-vector-badge enabled';
  } else {
    badge.textContent = '关键词模式';
    badge.className = 'memory-vector-badge disabled';
  }
}

// ── 统计 ──

function updateStats(): void {
  const entries = getMemoryCache();
  const counts = { total: entries.length, fact: 0, preference: 0, rule: 0 };
  for (const e of entries) {
    if (e.type in counts) (counts as any)[e.type]++;
  }
  const el = (id: string) => modalEl.querySelector(`#${id}`)!;
  el('memStatTotal').textContent = String(counts.total);
  el('memStatFact').textContent = String(counts.fact);
  el('memStatPref').textContent = String(counts.preference);
  el('memStatRule').textContent = String(counts.rule);
  el('catCountAll').textContent = String(counts.total);
  el('catCountFact').textContent = String(counts.fact);
  el('catCountPref').textContent = String(counts.preference);
  el('catCountRule').textContent = String(counts.rule);
}

// ── 列表渲染 ──

function getActiveType(): string {
  const active = modalEl.querySelector('.memory-category-item.active') as HTMLElement;
  return active?.dataset.type || '';
}

function renderList(): void {
  const listEl = modalEl.querySelector('#memoryListLg')!;
  const query = (modalEl.querySelector('#memorySearchLg') as HTMLInputElement).value.trim();
  const typeFilter = getActiveType();

  let entries: MemoryEntry[];
  if (query) {
    entries = searchMemories(query, 50);
  } else {
    entries = getMemoryCache();
  }

  if (typeFilter) {
    entries = entries.filter(e => e.type === typeFilter);
  }

  entries.sort((a, b) => {
    if (a.importance !== b.importance) return b.importance - a.importance;
    return b.updatedAt - a.updatedAt;
  });

  if (entries.length === 0) {
    listEl.innerHTML = `<div class="memory-empty-lg">${query ? '未找到匹配的记忆' : '暂无记忆，AI 会自动在对话中学习'}</div>`;
    return;
  }

  listEl.innerHTML = entries.map(entry => {
    const icon = getTypeIcon(entry.type);
    const typeName = getTypeName(entry.type);
    const importanceStars = '★'.repeat(Math.min(entry.importance, 10)) + '☆'.repeat(Math.max(0, 10 - entry.importance));
    return `
      <div class="memory-item-lg" data-id="${entry.id}">
        <div class="memory-item-lg-header">
          <span>${icon}</span>
          <span class="memory-item-lg-type">${typeName}</span>
          <span class="memory-item-lg-importance">${importanceStars}</span>
          <button class="memory-item-lg-delete" data-id="${entry.id}" title="删除">✕</button>
        </div>
        <div class="memory-item-lg-content">${escapeHtml(entry.content)}</div>
        <div class="memory-item-lg-meta">
          ${entry.tags.length > 0 ? `<span class="memory-item-lg-tags">${entry.tags.map(t => `<span class="memory-tag-lg">${escapeHtml(t)}</span>`).join('')}</span>` : ''}
          <span class="memory-item-lg-time">${formatTime(entry.updatedAt)}</span>
        </div>
      </div>
    `;
  }).join('');

  // 删除按钮
  listEl.querySelectorAll('.memory-item-lg-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id!;
      await deleteMemory(id);
      renderList();
      updateStats();
      showToast('记忆已删除', 'info', 1500);
    });
  });

  // 双击编辑
  listEl.querySelectorAll('.memory-item-lg-content').forEach(el => {
    el.addEventListener('dblclick', () => {
      const item = (el as HTMLElement).closest('.memory-item-lg')!;
      const id = item.getAttribute('data-id')!;
      const entry = getMemoryCache().find(e => e.id === id);
      if (entry) openEditDialog(entry);
    });
  });
}

// ── 添加对话框 ──

async function openAddDialog(): Promise<void> {
  const type = await showPrompt({
    title: '添加记忆',
    message: '选择记忆类型：',
    type: 'select',
    defaultValue: 'fact',
    options: [
      { value: 'fact', label: '📌 事实 — 项目信息、身份背景' },
      { value: 'preference', label: '⚙️ 偏好 — 语言风格、技术栈偏好' },
      { value: 'rule', label: '📏 规则 — 编码规范、输出要求' }
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
  renderList();
  updateStats();
  showToast('记忆已添加', 'success', 1500);
}

// ── 编辑对话框 ──

async function openEditDialog(entry: MemoryEntry): Promise<void> {
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
  renderList();
  updateStats();
  showToast('记忆已更新', 'success', 1500);
}
