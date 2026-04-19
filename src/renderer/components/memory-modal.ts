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
          <label class="toggle-label" title="自动记忆">
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
              <button class="btn btn-sm btn-outline" id="btnImportMemoryMd" disabled title="需先在设置中配置嵌入模型">📥 导入文档</button>
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

  // 导入 Markdown 记忆文档
  overlay.querySelector('#btnImportMemoryMd')!.addEventListener('click', importMemoryFromMd);

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
  if (typeof (window as unknown as { __memoryStateListener?: boolean }).__memoryStateListener === 'undefined') {
    (window as unknown as { __memoryStateListener?: boolean }).__memoryStateListener = true;
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
  const importBtn = modalEl.querySelector('#btnImportMemoryMd') as HTMLButtonElement;
  if (isVectorMemoryEnabled()) {
    badge.textContent = `✅ 向量搜索 (${getEmbeddingModel()})`;
    badge.className = 'memory-vector-badge enabled';
    importBtn.disabled = false;
    importBtn.title = '导入 Markdown 文档（自动向量化）';
  } else {
    badge.textContent = '关键词模式';
    badge.className = 'memory-vector-badge disabled';
    importBtn.disabled = true;
    importBtn.title = '需先在设置中配置嵌入模型';
  }
}

// ── 统计 ──

function updateStats(): void {
  const entries = getMemoryCache();
  const counts: Record<string, number> = { total: entries.length, fact: 0, preference: 0, rule: 0 };
  for (const e of entries) {
    if (e.type in counts) counts[e.type]++;
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

// ── 导入 Markdown 记忆文档 ──

async function importMemoryFromMd(): Promise<void> {
  if (!isVectorMemoryEnabled()) {
    showToast('请先在设置中配置嵌入模型以启用向量记忆', 'warning');
    return;
  }

  const bridge = window.metonaDesktop;
  if (!bridge || !bridge.isDesktop) {
    showToast('导入功能仅在桌面端可用', 'warning');
    return;
  }

  const paths = await bridge.dialog.openFile({
    filters: [{ name: 'Markdown 文档', extensions: ['md'] }]
  });
  if (!paths || paths.length === 0) return;

  const filePath = paths[0];
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  try {
    const result = await bridge.fs.readFile(filePath);
    if (!result.success) {
      showToast(`读取失败: ${result.error}`, 'error');
      return;
    }

    const content = result.content as string;
    const sections = parseMdToMemories(content);

    if (sections.length === 0) {
      showToast('未从文档中解析到有效记忆内容', 'warning');
      return;
    }

    let imported = 0;
    let skipped = 0;
    for (const sec of sections) {
      if (!sec.content || sec.content.length < 5) { skipped++; continue; }
      await addMemory({
        type: sec.type || 'fact',
        content: sec.content,
        importance: sec.importance || 5,
        tags: sec.tags || [],
        source: fileName
      });
      imported++;
    }

    renderList();
    updateStats();
    showToast(`已导入 ${imported} 条记忆（已向量化）${skipped > 0 ? `，跳过 ${skipped} 条` : ''}`, 'success', 3000);
  } catch (err) {
    showToast(`导入失败: ${(err as Error).message}`, 'error');
  }
}

function parseMdToMemories(md: string): Array<{ type: MemoryType; content: string; importance: number; tags: string[] }> {
  const results: Array<{ type: MemoryType; content: string; importance: number; tags: string[] }> = [];

  // 按 ## 二级标题分块
  const blocks = md.split(/^## /m).filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const heading = lines[0]?.trim() || '';
    const body = lines.slice(1).join('\n').trim();
    if (!body && !heading) continue;

    // 从标题推断类型
    let type: MemoryType = 'fact';
    const headingLower = heading.toLowerCase();
    if (headingLower.includes('偏好') || headingLower.includes('preference') || headingLower.includes('风格') || headingLower.includes('习惯')) {
      type = 'preference';
    } else if (headingLower.includes('规则') || headingLower.includes('rule') || headingLower.includes('规范') || headingLower.includes('约束')) {
      type = 'rule';
    }

    // 提取标签：标题中的关键词 + 正文前几个有意义的词
    const tags: string[] = [];
    if (heading) {
      const headingTags = heading.replace(/[^\w\u4e00-\u9fff\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
      tags.push(...headingTags.slice(0, 3));
    }

    // 内容：标题 + 正文（如果正文为空用标题作内容）
    const content = body ? `${heading ? heading + '：' : ''}${body}` : heading;
    if (content.length < 5) continue;

    // 从标题提取重要性（如 "重要性:8" 或 "importance: 7"）
    let importance = 5;
    const impMatch = heading.match(/(?:重要性|importance)\s*[:：]\s*(\d+)/i);
    if (impMatch) importance = Math.min(10, Math.max(1, parseInt(impMatch[1]) || 5));

    results.push({ type, content: content.slice(0, 500), importance, tags });
  }

  // 如果按标题分块无结果，按段落分块
  if (results.length === 0) {
    const paragraphs = md.split(/\n{2,}/).filter(p => p.trim());
    for (const para of paragraphs) {
      const text = para.trim().replace(/^[-*]\s+/gm, '').replace(/^#+\s+/gm, '');
      if (text.length < 10) continue;
      results.push({ type: 'fact', content: text.slice(0, 500), importance: 5, tags: [] });
    }
  }

  return results;
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
