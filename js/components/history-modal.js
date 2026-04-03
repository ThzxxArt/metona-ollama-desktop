/**
 * HistoryModal - 历史记录面板组件
 */

import { state, KEYS } from '../state.js';
import { debounce, escapeHtml, formatTime } from '../utils.js';
import { exportAsMarkdown, exportAsHtml, exportAsTxt, renderMessages, clearMessages } from './chat-area.js';

const HISTORY_PAGE_SIZE = 10;

let historyModalEl, historyListEl, historyPaginationEl;
let historyPage = 1;
let historySearchQuery = '';

export function initHistoryModal() {
    historyModalEl = document.querySelector('#historyModal');
    historyListEl = document.querySelector('#historyList');
    historyPaginationEl = document.querySelector('#historyPagination');

    // 打开/关闭
    document.querySelector('#btnHistory').addEventListener('click', openHistoryModal);
    document.querySelector('#btnCloseHistory').addEventListener('click', closeHistoryModal);
    historyModalEl.addEventListener('click', (e) => {
        if (e.target === historyModalEl) closeHistoryModal();
    });

    // 退出历史只读模式
    document.querySelector('#btnExitHistory').addEventListener('click', () => {
        document.querySelector('#btnNewChat').click();
    });

    // 搜索
    const historySearchInput = document.querySelector('#historySearchInput');
    const historySearchClear = document.querySelector('#historySearchClear');
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

    // 历史列表事件委托
    historyListEl.addEventListener('click', async (e) => {
        const target = e.target.closest('[data-id]');
        if (!target) return;
        const sessionId = target.dataset.id;
        const db = state.get(KEYS.DB);

        if (target.classList.contains('btn-delete-session')) {
            if (confirm('确定删除此会话？')) {
                await db.deleteSession(sessionId);
                const currentSession = state.get(KEYS.CURRENT_SESSION);
                if (currentSession && currentSession.id === sessionId) {
                    document.querySelector('#btnNewChat').click();
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

    // 分页事件
    historyPaginationEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.page-btn');
        if (!btn || btn.classList.contains('disabled')) return;
        const page = parseInt(btn.dataset.page);
        if (page && page !== historyPage) {
            historyPage = page;
            loadHistory();
            historyListEl.scrollTop = 0;
        }
    });
}

export async function loadHistory() {
    const db = state.get(KEYS.DB);
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
        historyListEl.innerHTML = `
            <div class="empty-history">
                <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="rgba(85,85,112,0.5)" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                <p class="text-muted">暂无历史记录</p>
            </div>`;
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

    // 分页
    if (totalPages <= 1) {
        historyPaginationEl.innerHTML = `<span class="page-info">共 ${allSessions.length} 条</span>`;
        return;
    }

    let html = `<span class="page-info">共 ${allSessions.length} 条</span>`;
    html += '<div class="page-buttons">';
    html += `<button class="page-btn${historyPage <= 1 ? ' disabled' : ''}" data-page="${historyPage - 1}">‹</button>`;

    const range = 2;
    let pages = [];
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= historyPage - range && i <= historyPage + range)) {
            pages.push(i);
        }
    }
    let prev = 0;
    for (const p of pages) {
        if (p - prev > 1) html += '<span class="page-ellipsis">…</span>';
        html += `<button class="page-btn${p === historyPage ? ' active' : ''}" data-page="${p}">${p}</button>`;
        prev = p;
    }

    html += `<button class="page-btn${historyPage >= totalPages ? ' disabled' : ''}" data-page="${historyPage + 1}">›</button>`;
    html += '</div>';
    historyPaginationEl.innerHTML = html;
}

async function loadHistorySession(sessionId) {
    const db = state.get(KEYS.DB);
    if (!db) return;

    const session = await db.getSession(sessionId);
    if (!session) return;

    state.set(KEYS.CURRENT_SESSION, session);
    state.set(KEYS.IS_HISTORY_VIEW, true);

    document.querySelector('#historyBar').style.display = '';
    document.querySelector('#inputArea').style.display = 'none';

    clearMessages();
    renderMessages();
    closeHistoryModal();
}

export function openHistoryModal() {
    historyPage = 1;
    historySearchQuery = '';
    document.querySelector('#historySearchInput').value = '';
    document.querySelector('#historySearchClear').style.display = 'none';
    loadHistory();
    historyModalEl.style.display = '';
}

export function closeHistoryModal() {
    historyModalEl.style.display = 'none';
}
