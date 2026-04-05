/**
 * ChatArea - 聊天区域组件
 */

import { state, KEYS } from '../state/state.js';
import { marked } from '../utils/marked-config.js';
import { escapeHtml, formatTime, downloadFile } from '../utils/utils.js';
import type { ChatSession, ChatMessage } from '../types.js';

function getFileIcon(filename: string): string {
  const name = filename.toLowerCase();
  if (name === 'dockerfile') return '🐳';
  if (name === 'makefile' || name === 'gnumakefile') return '🔨';
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    py: '🐍', js: '💛', ts: '🔷', tsx: '⚛️', jsx: '⚛️',
    java: '☕', go: '🐹', rs: '🦀', rb: '💎', php: '🐘',
    cpp: '⚙️', c: '⚙️', sh: '🐚', html: '🌐', css: '🎨',
    json: '📋', yaml: '📋', yml: '📋', md: '📝', txt: '📄',
    sql: '🗃️', xml: '📰', csv: '📊', diff: '🔀',
  };
  return map[ext] || '📄';
}

let chatAreaEl: HTMLElement;
let messagesContainerEl: HTMLElement;
let emptyStateEl: HTMLElement;
let scrollBtnEl: HTMLElement;
let autoScroll = true;
let currentPlaceholder: HTMLElement | null = null;

export function initChatArea(): void {
  chatAreaEl = document.querySelector('#chatArea')!;
  messagesContainerEl = document.querySelector('#messagesContainer')!;
  emptyStateEl = document.querySelector('#emptyState')!;
  scrollBtnEl = document.querySelector('#scrollToBottom')!;

  chatAreaEl.addEventListener('scroll', () => {
    const atBottom = isAtBottom();
    if (atBottom) {
      autoScroll = true;
      scrollBtnEl.style.display = 'none';
    } else {
      autoScroll = false;
      scrollBtnEl.style.display = '';
    }
  });

  scrollBtnEl.addEventListener('click', () => {
    autoScroll = true;
    scrollBtnEl.style.display = 'none';
    chatAreaEl.scrollTo({ top: chatAreaEl.scrollHeight, behavior: 'smooth' });
  });
}

function isAtBottom(): boolean {
  return chatAreaEl.scrollHeight - chatAreaEl.scrollTop - chatAreaEl.clientHeight < 60;
}

export function safeMarkdown(text: unknown): string {
  if (!text && text !== 0) return '';
  const str = typeof text === 'string' ? text : String(text);
  if (!str) return '';
  try {
    return marked(str);
  } catch {
    return escapeHtml(str);
  }
}

export function scrollToBottom(): void {
  if (!autoScroll) return;
  requestAnimationFrame(() => {
    chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
  });
}

export function renderMessages(): void {
  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  const msgs = currentSession ? currentSession.messages : [];

  if (msgs.length === 0) {
    emptyStateEl.style.display = '';
    messagesContainerEl.style.display = 'none';
    return;
  }

  emptyStateEl.style.display = 'none';
  messagesContainerEl.style.display = '';

  const existingCount = messagesContainerEl.children.length;
  const isNewMessage = existingCount > 0 && existingCount < msgs.length;
  for (let i = existingCount; i < msgs.length; i++) {
    appendMessageDOM(msgs[i], i);
  }

  if (isNewMessage) {
    scrollToBottom();
  } else if (msgs.length > 0) {
    chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
  }
}

export function appendMessageDOM(msg: ChatMessage, index: number): void {
  const div = document.createElement('div');
  div.className = `message ${msg.role}`;
  div.dataset.index = String(index);

  const avatar = msg.role === 'user' ? '👤' : '🤖';
  const roleLabel = msg.role === 'user' ? '你' : 'AI';
  const modelTag = (msg.role === 'assistant' && msg.model)
    ? `<span class="model-tag">${escapeHtml(msg.model)}</span>`
    : '';

  let contentHtml = '';
  const safeContent = (msg.content != null) ? String(msg.content) : '';

  if (msg.role === 'assistant') {
    if (msg.think) {
      contentHtml += `
        <div class="think-block">
          <div class="think-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? '' : 'none'; this.querySelector('.chevron').classList.toggle('expanded');">
            <span>🤔 思考过程</span>
            <svg class="chevron expanded" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="think-content"><pre>${escapeHtml(msg.think)}</pre></div>
        </div>`;
    }
    if (safeContent) {
      contentHtml += `<div class="msg-content">${safeMarkdown(safeContent)}</div>`;
    } else {
      contentHtml += `<div class="msg-content"></div>`;
    }
  } else {
    contentHtml += `<div class="msg-content">${escapeHtml(safeContent)}</div>`;
  }

  if (msg.images && msg.images.length > 0) {
    contentHtml += '<div class="msg-images">';
    for (const img of msg.images) {
      contentHtml += `<img class="msg-img" src="data:image/png;base64,${img}" alt="用户图片" data-lightbox="true">`;
    }
    contentHtml += '</div>';
  }

  if (msg.files && msg.files.length > 0) {
    contentHtml += '<div class="msg-files">';
    for (const f of msg.files) {
      const icon = getFileIcon(f.name);
      contentHtml += `<div class="file-chip"><span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(f.name)}</span></div>`;
    }
    contentHtml += '</div>';
  }

  if (msg.role === 'user' && (!msg.content || msg.content.trim() === '') && (msg.images?.length || 0) > 0) {
    contentHtml = contentHtml.replace('<div class="msg-content"></div>', '');
  }

  const stats: string[] = [];
  if (msg.timestamp) stats.push(formatTime(msg.timestamp));
  if (msg.eval_count) stats.push(`${msg.eval_count} tokens`);
  if (msg.total_duration) stats.push(`${(msg.total_duration / 1e9).toFixed(1)}s`);
  if (stats.length > 0) {
    contentHtml += `<div class="msg-stats">${stats.map(s => `<span>${s}</span>`).join(' · ')}</div>`;
  }

  if (msg.role === 'assistant' && msg.ragSources && msg.ragSources.length > 0) {
    const sourcesHtml = msg.ragSources.map((s, i) => {
      const scorePercent = s.score ? `${(s.score * 100).toFixed(0)}%` : '';
      return `<div class="rag-source-item">
        <span class="rag-source-name">📄 来源 ${i + 1}: ${escapeHtml(s.filename)}</span>
        ${scorePercent ? `<span class="rag-source-score">${scorePercent}</span>` : ''}
      </div>`;
    }).join('');
    contentHtml += `<div class="rag-sources"><div class="rag-sources-header">🧠 基于知识库回答</div>${sourcesHtml}</div>`;
  }

  div.innerHTML = `
    <div class="msg-avatar">${avatar}</div>
    <div class="msg-body">
      <div class="msg-role">${roleLabel}${modelTag}</div>
      ${contentHtml}
    </div>
  `;

  messagesContainerEl.appendChild(div);
}

export function updateLastAssistantMessage(content: string, think: string | null, stats: { eval_count?: number; total_duration?: number } | null, model?: string): void {
  const lastMsg = currentPlaceholder;
  if (!lastMsg) return;

  if (lastMsg.classList.contains('loading')) {
    lastMsg.classList.remove('loading');
    const loadingDots = lastMsg.querySelector('.loading-dots');
    const loadingText = lastMsg.querySelector('.loading-text');
    if (loadingDots) loadingDots.remove();
    if (loadingText) loadingText.remove();
  }

  if (model) {
    let modelTag = lastMsg.querySelector('.model-tag');
    if (!modelTag) {
      modelTag = document.createElement('span');
      modelTag.className = 'model-tag';
      const roleEl = lastMsg.querySelector('.msg-role');
      if (roleEl) roleEl.appendChild(modelTag);
    }
    modelTag.textContent = model;
  }

  const contentDiv = lastMsg.querySelector('.msg-content');
  const safeContent = (content != null) ? String(content) : '';
  if (contentDiv && safeContent) {
    contentDiv.innerHTML = safeMarkdown(safeContent);
  }

  let thinkBlock = lastMsg.querySelector('.think-block');
  if (think) {
    if (!thinkBlock) {
      const msgBody = lastMsg.querySelector('.msg-body')!;
      thinkBlock = document.createElement('div');
      thinkBlock.className = 'think-block';
      thinkBlock.innerHTML = `
        <div class="think-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? '' : 'none'; this.querySelector('.chevron').classList.toggle('expanded');">
          <span>🤔 思考过程</span>
          <svg class="chevron expanded" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="think-content"><pre></pre></div>
      `;
      msgBody.insertBefore(thinkBlock, contentDiv);
    }
    thinkBlock.querySelector('pre')!.textContent = think;
  }

  if (stats) {
    let statsDiv = lastMsg.querySelector('.msg-stats');
    if (!statsDiv) {
      statsDiv = document.createElement('div');
      statsDiv.className = 'msg-stats';
      lastMsg.querySelector('.msg-body')!.appendChild(statsDiv);
    }
    const parts: string[] = [];
    if (stats.eval_count) parts.push(`${stats.eval_count} tokens`);
    if (stats.total_duration) parts.push(`${(stats.total_duration / 1e9).toFixed(1)}s`);
    if (parts.length) statsDiv.innerHTML = parts.join(' · ');
  }

  scrollToBottom();
}

export function appendAssistantPlaceholder(): void {
  const div = document.createElement('div');
  div.className = 'message assistant loading';
  div.innerHTML = `
    <div class="msg-avatar">🤖</div>
    <div class="msg-body">
      <div class="msg-role">AI</div>
      <div class="msg-content">
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <span class="loading-text">正在思考...</span>
      </div>
    </div>
  `;
  messagesContainerEl.appendChild(div);
  currentPlaceholder = div;
  scrollToBottom();
}

export function appendSystemMessage(text: string, tempClass?: string): void {
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;padding:8px;font-size:12px;color:var(--text-muted);';
  if (tempClass) div.classList.add(tempClass);
  div.textContent = text;
  emptyStateEl.style.display = 'none';
  messagesContainerEl.style.display = '';
  messagesContainerEl.appendChild(div);
  scrollToBottom();
}

export function getMessagesContainer(): HTMLElement {
  return messagesContainerEl;
}

export function clearMessages(): void {
  messagesContainerEl.innerHTML = '';
  currentPlaceholder = null;
}

export function enableAutoScroll(): void {
  autoScroll = true;
  if (scrollBtnEl) scrollBtnEl.style.display = 'none';
}

// ── 导出功能 ──

export function exportAsMarkdown(session: ChatSession): void {
  let md = `# ${session.title}\n\n**模型:** ${session.model}  \n**时间:** ${formatTime(session.createdAt)}\n\n---\n\n`;
  session.messages.forEach(m => {
    const role = m.role === 'user' ? '👤 用户' : '🤖 AI';
    md += `### ${role}\n\n${m.content || ''}\n\n`;
    if (m.files && m.files.length > 0) {
      md += m.files.map(f => `📎 \`${f.name}\``).join(' · ') + '\n\n';
    }
    if (m.think) md += `> **思考:** ${m.think}\n\n`;
  });
  downloadFile(`${session.title}.md`, md, 'text/markdown');
}

export function exportAsHtml(session: ChatSession): void {
  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(session.title)}</title>
<style>body{max-width:800px;margin:0 auto;padding:20px;font-family:system-ui;line-height:1.6;background:#202020;color:#fff;}
.user{background:rgba(25,25,60,0.5);padding:12px;border-radius:8px;margin:8px 0;}
.assistant{background:rgba(96,205,255,0.03);padding:12px;border-radius:8px;margin:8px 0;border:1px solid rgba(96,205,255,0.08);}
pre{background:rgba(0,0,0,0.3);padding:12px;border-radius:8px;overflow-x:auto;}
code{background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px;}</style></head><body>
<h1>${escapeHtml(session.title)}</h1><p>${formatTime(session.createdAt)} · ${session.model}</p><hr>`;
  session.messages.forEach(m => {
    html += `<div class="${m.role}"><strong>${m.role === 'user' ? '👤 用户' : '🤖 AI'}</strong><br>${(m.content || '').replace(/\n/g, '<br>')}</div>`;
  });
  html += '</body></html>';
  downloadFile(`${session.title}.html`, html, 'text/html');
}

export function exportAsTxt(session: ChatSession): void {
  let txt = `${session.title}\n模型: ${session.model}\n时间: ${formatTime(session.createdAt)}\n${'='.repeat(50)}\n\n`;
  session.messages.forEach(m => {
    txt += `[${m.role === 'user' ? '用户' : 'AI'}]\n${m.content || ''}\n\n`;
  });
  downloadFile(`${session.title}.txt`, txt, 'text/plain');
}
