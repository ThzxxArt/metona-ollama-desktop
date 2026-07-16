/**
 * HistoryModal - 历史记录面板组件
 */

import { state, KEYS } from '../state/state.js';
import { debounce, escapeHtml, formatTime } from '../utils/utils.js';
import { exportAsMarkdown, exportAsHtml, exportAsTxt, renderMessages, clearMessages } from './chat-area.js';
import { clearToolCardsExternal, clearTerminalExternal } from './workspace-panel.js';
import { showConfirm } from './prompt-modal.js';
import { ChatDB } from '../db/chat-db.js';
import { logSession, logWarn } from '../services/log-service.js';
import type { ChatSession } from '../types.js';

const HISTORY_PAGE_SIZE = 10;

let historyModalEl: HTMLElement;
let historyListEl: HTMLElement;
let historyPaginationEl: HTMLElement;
let historyPage = 1;
let historySearchQuery = '';

export function initHistoryModal(): void {
  historyModalEl = document.querySelector('#historyModal')!;
  historyListEl = document.querySelector('#historyList')!;
  historyPaginationEl = document.querySelector('#historyPagination')!;

  document.querySelector('#btnHistory')!.addEventListener('click', openHistoryModal);
  document.querySelector('#btnCloseHistory')!.addEventListener('click', closeHistoryModal);
  historyModalEl.addEventListener('click', (e) => {
    if (e.target === historyModalEl) closeHistoryModal();
  });

  document.querySelector('#btnExitHistory')!.addEventListener('click', () => {
    (document.querySelector('#btnNewChat') as HTMLElement).click();
  });

  const historySearchInput = document.querySelector('#historySearchInput') as HTMLInputElement;
  const historySearchClear = document.querySelector('#historySearchClear') as HTMLElement;
  const doHistorySearch = debounce(() => {
    historySearchQuery = historySearchInput.value.trim();
    historySearchClear.style.display = historySearchQuery ? '' : 'none';
    historyPage = 1;
    loadHistory();
  }, 250);
  historySearchInput.addEventListener('input', doHistorySearch);
  historySearchClear.addEventListener('click', () => {
    historySearchInput.value = '';
    historySearchQuery = '';
    historySearchClear.style.display = 'none';
    historyPage = 1;
    loadHistory();
  });

  historyListEl.addEventListener('click', async (e) => {
    const target = (e.target as HTMLElement).closest('[data-id]') as HTMLElement;
    if (!target) return;
    const sessionId = target.dataset.id!;
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (!db) return;

    if (target.classList.contains('btn-delete-session')) {
      if (await showConfirm('确定删除此会话？', '删除会话')) {
        await db.deleteSession(sessionId);
        logSession('删除', sessionId);
        const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
        if (currentSession && currentSession.id === sessionId) {
          (document.querySelector('#btnNewChat') as HTMLElement).click();
        }
        loadHistory();
      }
    } else if (target.classList.contains('btn-export-md')) {
      const session = await db.getSession(sessionId);
      if (session) exportAsMarkdown(session);
    } else if (target.classList.contains('btn-export-html')) {
      const session = await db.getSession(sessionId);
      if (session) exportAsHtml(session);
    } else if (target.classList.contains('btn-export-txt')) {
      const session = await db.getSession(sessionId);
      if (session) exportAsTxt(session);
    } else if (target.classList.contains('history-info') || target.classList.contains('history-item')) {
      loadHistorySession(sessionId);
    }
  });

  historyPaginationEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.page-btn') as HTMLElement;
    if (!btn || btn.classList.contains('disabled')) return;
    const page = parseInt(btn.dataset.page!);
    if (page && page !== historyPage) {
      historyPage = page;
      loadHistory();
      historyListEl.scrollTop = 0;
    }
  });
}

async function loadHistory(): Promise<void> {
  const db = state.get<ChatDB>(KEYS.DB);
  if (!db) return;

  let allSessions = await db.getAllSessions();

  if (historySearchQuery) {
    const q = historySearchQuery.toLowerCase();
    allSessions = allSessions.filter(s => {
      if (s.title?.toLowerCase().includes(q)) return true;
      if (s.model?.toLowerCase().includes(q)) return true;
      return s.messages.some(m => m.content?.toLowerCase().includes(q));
    });
  }

  allSessions.sort((a, b) => b.updatedAt - a.updatedAt);

  if (allSessions.length === 0) {
    historyListEl.innerHTML = `<div class="empty-history"><p class="text-muted">暂无历史记录</p></div>`;
    historyPaginationEl.innerHTML = '';
    return;
  }

  const totalPages = Math.ceil(allSessions.length / HISTORY_PAGE_SIZE);
  if (historyPage > totalPages) historyPage = totalPages;

  const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
  const pageSessions = allSessions.slice(start, start + HISTORY_PAGE_SIZE);

  historyListEl.innerHTML = pageSessions.map(s => `
    <div class="history-item" data-id="${s.id}">
      <div class="history-info" data-id="${s.id}">
        <div class="history-title">${escapeHtml(s.title)}</div>
        <div class="history-meta">
          <span>${formatTime(s.updatedAt)}</span>
          <span>${s.messages.length} 条消息</span>
          <span>${s.model || '无模型'}</span>
        </div>
      </div>
      <div class="history-actions">
        <button class="icon-btn sm btn-export-md" data-id="${s.id}" title="导出为 Markdown">📄</button>
        <button class="icon-btn sm btn-export-html" data-id="${s.id}" title="导出为 HTML">🌐</button>
        <button class="icon-btn sm btn-export-txt" data-id="${s.id}" title="导出为 TXT">📝</button>
        <button class="icon-btn sm danger btn-delete-session" data-id="${s.id}" title="删除">🗑️</button>
      </div>
    </div>
  `).join('');

  if (totalPages <= 1) {
    historyPaginationEl.innerHTML = `<span class="page-info">共 ${allSessions.length} 条</span>`;
    return;
  }

  let html = `<span class="page-info">共 ${allSessions.length} 条</span><div class="page-buttons">`;
  html += `<button class="page-btn${historyPage <= 1 ? ' disabled' : ''}" data-page="${historyPage - 1}">‹</button>`;
  const range = 2;
  const pages: number[] = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= historyPage - range && i <= historyPage + range)) pages.push(i);
  }
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) html += '<span class="page-ellipsis">…</span>';
    html += `<button class="page-btn${p === historyPage ? ' active' : ''}" data-page="${p}">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn${historyPage >= totalPages ? ' disabled' : ''}" data-page="${historyPage + 1}">›</button></div>`;
  historyPaginationEl.innerHTML = html;
}

async function loadHistorySession(sessionId: string): Promise<void> {
  const db = state.get<ChatDB>(KEYS.DB);
  if (!db) return;

  const session = await db.getSession(sessionId);
  if (!session) {
    logWarn('会话不存在', sessionId);
    return;
  }

  logSession('加载', `${session.title} (${session.messages.length}条消息)`);
  state.set(KEYS.CURRENT_SESSION, session);
  state.set(KEYS.IS_HISTORY_VIEW, true);
  // P1-P1 修复：切换会话时重置已保存消息追踪
  db.resetSavedMsgTracking();

  (document.querySelector('#historyBar') as HTMLElement).style.display = '';
  (document.querySelector('#inputArea') as HTMLElement).style.display = 'none';

  // 切换会话时清理工作空间状态
  clearToolCardsExternal();
  clearTerminalExternal();

  clearMessages();
  renderMessages();
  closeHistoryModal();
}

export function openHistoryModal(): void {
  historyPage = 1;
  historySearchQuery = '';
  (document.querySelector('#historySearchInput') as HTMLInputElement).value = '';
  (document.querySelector('#historySearchClear') as HTMLElement).style.display = 'none';
  loadHistory();
  logSession('打开历史记录');
  historyModalEl.style.display = '';
}

export function closeHistoryModal(): void {
  historyModalEl.style.display = 'none';
}
