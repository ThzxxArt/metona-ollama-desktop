/**
 * MemoryModal - Agent 记忆管理（简化版）
 * 基于工作空间 MEMORY.md 文件
 */

import { loadAllEntries, addEntry, removeEntry, type MemoryEntry, type MemoryType } from '../services/memory-service.js';
import { showToast } from './toast.js';
import { showPrompt, showConfirm } from './prompt-modal.js';
import { escapeHtml, formatTime } from '../utils/utils.js';

let modalEl: HTMLElement;

// ── 初始化 ──

export function initMemoryModal(): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'memoryModal';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>🧠 Agent 记忆 (MEMORY.md)</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="btn btn-sm btn-outline" id="btnAddMemoryLg">＋ 添加</button>
          <button class="icon-btn" id="btnCloseMemoryModal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="modal-body" style="max-height:65vh;overflow-y:auto;">
        <div class="memory-list-simple" id="memoryListSimple"></div>
        <div class="memory-footer-simple" id="memoryFooterSimple" style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;"></div>
      </div>
    </div>
  `;

  document.querySelector('#app')!.appendChild(overlay);
  modalEl = overlay;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeMemoryModal();
  });
  overlay.querySelector('#btnCloseMemoryModal')!.addEventListener('click', closeMemoryModal);
  overlay.querySelector('#btnAddMemoryLg')!.addEventListener('click', openAddDialog);

  // 列表点击：删除按钮
  overlay.querySelector('#memoryListSimple')!.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('memory-item-delete')) {
      const id = target.dataset.id!;
      const entries = await loadAllEntries();
      const entry = entries.find(e => e.id === id);
      if (entry && await showConfirm(`确定删除这条记忆？\n\n${entry.content.slice(0, 100)}`, '删除记忆')) {
        await removeEntry(entry.content.slice(0, 50));
        renderList();
        showToast('记忆已删除', 'info', 1500);
      }
    }
  });

  // header 按钮
  document.querySelector('#btnMemory')?.addEventListener('click', openMemoryModal);
}

// ── 打开/关闭 ──

export async function openMemoryModal(): Promise<void> {
  modalEl.style.display = '';
  await renderList();
}

export function closeMemoryModal(): void {
  modalEl.style.display = 'none';
}

// ── 列表渲染 ──

async function renderList(): Promise<void> {
  const listEl = modalEl.querySelector('#memoryListSimple') as HTMLElement;
  const footerEl = modalEl.querySelector('#memoryFooterSimple') as HTMLElement;

  let entries: MemoryEntry[];
  try {
    entries = await loadAllEntries();
  } catch (err) {
    listEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);">加载失败: ${escapeHtml((err as Error).message)}</div>`;
    return;
  }

  if (entries.length === 0) {
    listEl.innerHTML = `<div style="text-align:center;padding:32px 20px;color:var(--text-muted);">
      <div style="font-size:48px;margin-bottom:12px;">🧠</div>
      <div style="font-size:14px;">暂无记忆</div>
      <div style="font-size:12px;margin-top:8px;color:var(--text-tertiary);">AI 在对话中可通过 memory 工具自动管理记忆<br>工作空间 MEMORY.md 文件存储</div>
    </div>`;
    footerEl.textContent = '在对话中让 AI "记住xxx"即可自动添加记忆';
    return;
  }

  // 按类型分组渲染
  const typeOrder: MemoryType[] = ['rule', 'preference', 'fact'];
  const typeIcons: Record<string, string> = { rule: '📏', preference: '⚙️', fact: '📌' };
  const typeNames: Record<string, string> = { rule: '规则', preference: '偏好', fact: '事实' };

  let html = '';
  for (const type of typeOrder) {
    const typeEntries = entries.filter(e => e.type === type);
    if (typeEntries.length === 0) continue;

    html += `<div style="font-size:12px;font-weight:700;color:var(--text-secondary);padding:8px 0 4px;margin-top:8px;">${typeIcons[type]} ${typeNames[type]} (${typeEntries.length})</div>`;

    for (const entry of typeEntries) {
      const stars = '★'.repeat(Math.min(entry.importance, 10));
      html += `<div class="memory-entry-simple" style="padding:10px 14px;margin:4px 0;background:var(--bg-card);border-radius:var(--radius-control);border:1px solid var(--border-subtle);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;font-size:13px;line-height:1.5;color:var(--text-primary);">${escapeHtml(entry.content)}</div>
          <button class="memory-item-delete" data-id="${entry.id}" style="flex-shrink:0;background:none;border:none;color:var(--text-tertiary);cursor:pointer;font-size:16px;padding:0 4px;line-height:1;" title="删除">✕</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px;font-size:11px;color:var(--text-tertiary);">
          <span style="color:var(--accent);">${stars}</span>
          <span>${entry.id}</span>
          ${entry.tags.length > 0 ? `<span>🏷 ${entry.tags.join(', ')}</span>` : ''}
        </div>
      </div>`;
    }
  }

  listEl.innerHTML = html;
  footerEl.textContent = `共 ${entries.length} 条记忆 · 存储于工作空间 MEMORY.md`;
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

  try {
    await addEntry(memoryType, content.trim(), importance);
    await renderList();
    showToast('记忆已添加', 'success', 1500);
  } catch (err) {
    showToast(`添加失败: ${(err as Error).message}`, 'error');
  }
}
