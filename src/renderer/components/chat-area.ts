/**
 * ChatArea - 聊天区域组件
 */

import { state, KEYS } from '../state/state.js';
import { logError, logSession } from '../services/log-service.js';
import { marked } from '../utils/marked-config.js';
import { escapeHtml, formatTime } from '../utils/utils.js';
import type { ChatSession, ChatMessage, ToolCallRecord } from '../types.js';

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

  // 只计算已渲染的 .message 元素（排除 loading placeholder 和其他非消息元素）
  const existingCount = messagesContainerEl.querySelectorAll('.message:not(.loading)').length;
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

  // ── 工具调用历史记录（可折叠）──
  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const tcCount = msg.toolCalls.length;
    const successCount = msg.toolCalls.filter(t => t.status === 'success').length;
    const errorCount = msg.toolCalls.filter(t => t.status === 'error').length;
    const summary = msg.toolCalls.map(t => {
      const names: Record<string, string> = {
        read_file: 'read_file', write_file: 'write_file', list_directory: 'list_directory',
        search_files: 'search_files', run_command: 'run_command', web_fetch: 'web_fetch',
        web_search: 'web_search', git: 'git', browser_open: 'browser_open',
        memory_search: 'memory_search', memory_add: 'memory_add', spawn_task: 'spawn_task',
      };
      return names[t.name] || t.name;
    }).slice(0, 5).join(', ') + (tcCount > 5 ? ` +${tcCount - 5}` : '');

    contentHtml += `<div class="tool-calls-history">
      <div class="tool-calls-toggle" onclick="this.parentElement.classList.toggle('expanded')">
        <span class="tool-calls-chevron">▸</span>
        <span class="tool-calls-summary">🔧 ${tcCount} 个工具调用（✅${successCount} ❌${errorCount}）</span>
      </div>
      <div class="tool-calls-list">
        ${msg.toolCalls.map(tc => renderToolCallCard(tc)).join('')}
      </div>
    </div>`;
  }

  if (msg.timestamp) {
    contentHtml += `<div class="msg-stats"><span>${formatTime(msg.timestamp)}</span></div>`;
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

function renderToolCallCard(tc: ToolCallRecord): string {
  const icons: Record<string, string> = {
    read_file: '📄', write_file: '✏️', list_directory: '📁',
    search_files: '🔍', create_directory: '📂', delete_file: '🗑️', run_command: '💻',
    move_file: '📦', copy_file: '📋', web_fetch: '🌐', append_file: '➕',
    edit_file: '✂️', get_file_info: 'ℹ️', tree: '🌳', download_file: '⬇️',
    diff_files: '🔀', replace_in_files: '🔄', read_multiple_files: '📚',
    git: '🔖', compress: '🗜️', web_search: '🔍',
    memory_search: '🧠', memory_add: '💾', session_list: '📋', session_read: '📖', spawn_task: '🤖',
    browser_open: '🌐', browser_screenshot: '📸', browser_evaluate: '⚡', browser_extract: '📰',
    browser_click: '👆', browser_type: '⌨️', browser_scroll: '↕️', browser_close: '❌'
  };
  const names: Record<string, string> = {
    read_file: '读取文件', write_file: '写入文件', list_directory: '列出目录',
    search_files: '搜索文件', create_directory: '创建目录', delete_file: '删除文件', run_command: '执行命令',
    move_file: '移动文件', copy_file: '复制文件', web_fetch: '网页抓取', append_file: '追加文件',
    edit_file: '编辑文件', get_file_info: '文件信息', tree: '目录树', download_file: '下载文件',
    diff_files: '文件对比', replace_in_files: '批量替换', read_multiple_files: '批量读取',
    git: 'Git 操作', compress: '压缩/解压', web_search: '联网搜索',
    memory_search: '搜索记忆', memory_add: '添加记忆', session_list: '会话列表', session_read: '读取会话', spawn_task: '子代理委派',
    browser_open: '打开网页', browser_screenshot: '浏览器截图', browser_evaluate: '执行JS', browser_extract: '提取内容',
    browser_click: '点击元素', browser_type: '输入文本', browser_scroll: '滚动页面', browser_close: '关闭浏览器'
  };
  const statusLabels: Record<string, string> = {
    pending: '⏳ 等待确认', running: '🔄 执行中', success: '✅ 完成', error: '❌ 失败', cancelled: '🚫 已取消'
  };

  const icon = icons[tc.name] || '🔧';
  const name = names[tc.name] || tc.name;
  const status = statusLabels[tc.status] || tc.status;
  const args = tc.arguments || {};

  let paramsHtml = '';
  if (args.path) paramsHtml += `<div class="tool-param">路径: <code>${escapeHtml(String(args.path))}</code></div>`;
  if (args.command) paramsHtml += `<div class="tool-param">命令: <code>${escapeHtml(String(args.command))}</code></div>`;
  if (args.query) paramsHtml += `<div class="tool-param">查询: <code>${escapeHtml(String(args.query))}</code></div>`;
  if (args.url) paramsHtml += `<div class="tool-param">URL: <code>${escapeHtml(String(args.url))}</code></div>`;
  if (args.source) paramsHtml += `<div class="tool-param">源: <code>${escapeHtml(String(args.source))}</code></div>`;
  if (args.destination) paramsHtml += `<div class="tool-param">目标: <code>${escapeHtml(String(args.destination))}</code></div>`;
  if (args.selector) paramsHtml += `<div class="tool-param">选择器: <code>${escapeHtml(String(args.selector))}</code></div>`;
  if (args.action) paramsHtml += `<div class="tool-param">操作: <code>${escapeHtml(String(args.action))}</code></div>`;

  return `<div class="tool-call-card tool-call-${tc.status}">
    <div class="tool-call-header">
      <span class="tool-call-icon">${icon}</span>
      <span class="tool-call-name">${name}</span>
      <span class="tool-call-status">${status}</span>
    </div>
    ${paramsHtml ? `<div class="tool-call-params">${paramsHtml}</div>` : ''}
  </div>`;
}

function formatFileSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
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

  scrollToBottom();
}

/** 实时追加工具调用卡片到当前 placeholder（直播聊天时使用） */
export function appendToolCallCardToPlaceholder(tc: ToolCallRecord): void {
  if (!currentPlaceholder) return;
  let container = currentPlaceholder.querySelector('.tool-calls-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'tool-calls-container';
    const msgBody = currentPlaceholder.querySelector('.msg-body');
    if (msgBody) msgBody.appendChild(container);
  }
  const cardDiv = document.createElement('div');
  cardDiv.innerHTML = renderToolCallCard(tc);
  const card = cardDiv.firstElementChild as HTMLElement;
  card.dataset.toolName = tc.name;
  container.appendChild(card);
  scrollToBottom();
}

/** 更新 placeholder 中已有的工具卡片状态（running → success/error） */
export function updateToolCallCardInPlaceholder(tc: ToolCallRecord): void {
  if (!currentPlaceholder) return;
  const container = currentPlaceholder.querySelector('.tool-calls-container');
  if (!container) return;
  // 找到第一个同名且状态为 running 的卡片
  const existing = container.querySelector(`.tool-call-card[data-tool-name="${tc.name}"].tool-call-running`) as HTMLElement;
  if (existing) {
    const cardDiv = document.createElement('div');
    cardDiv.innerHTML = renderToolCallCard(tc);
    const newCard = cardDiv.firstElementChild as HTMLElement;
    newCard.dataset.toolName = tc.name;
    existing.replaceWith(newCard);
  } else {
    // 没找到 running 的卡片，直接追加
    appendToolCallCardToPlaceholder(tc);
  }
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

/** v4.1: 清除所有消息 DOM 元素（用于 undo/compress 后强制重建） */
export function clearMessagesDOM(): void {
  messagesContainerEl.innerHTML = '';
}

export function clearMessages(): void {
  messagesContainerEl.innerHTML = '';
  currentPlaceholder = null;
}

/** 清理 currentPlaceholder 引用（当 placeholder 从外部被移除时调用） */
export function resetCurrentPlaceholder(): void {
  if (currentPlaceholder && !currentPlaceholder.isConnected) {
    currentPlaceholder = null;
  }
}

export function enableAutoScroll(): void {
  autoScroll = true;
  if (scrollBtnEl) scrollBtnEl.style.display = 'none';
}

// ── 导出功能 ──

async function nativeSaveFile(defaultName: string, content: string): Promise<void> {
  const bridge = window.metonaDesktop;
  if (bridge) {
    const ext = defaultName.split('.').pop() || 'txt';
    const filePath = await bridge.dialog.saveFile({
      defaultPath: defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    });
    if (!filePath) return;
    const result = await bridge.fs.writeFile(filePath, content, 'utf-8');
    if (!result.success) {
      logError('导出失败', result.error);
    }
  } else {
    // 回退
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = defaultName;
    a.click();
  }
}

export async function exportAsMarkdown(session: ChatSession): Promise<void> {
  let md = `# ${session.title}\n\n**模型:** ${session.model}  \n**时间:** ${formatTime(session.createdAt)}\n\n---\n\n`;
  session.messages.forEach(m => {
    const role = m.role === 'user' ? '👤 用户' : '🤖 AI';
    md += `### ${role}\n\n${m.content || ''}\n\n`;
    if (m.files && m.files.length > 0) {
      md += m.files.map(f => `📎 \`${f.name}\``).join(' · ') + '\n\n';
    }
    if (m.think) md += `> **思考:** ${m.think}\n\n`;
  });
  await nativeSaveFile(`${session.title}.md`, md);
  logSession('导出', `${session.title}.md`);
}

export async function exportAsHtml(session: ChatSession): Promise<void> {
  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(session.title)}</title>
<style>body{max-width:800px;margin:0 auto;padding:20px;font-family:system-ui;line-height:1.6;background:#FAF7F2;color:#2D2016;}
.user{background:#F5F0E8;padding:12px;border-radius:12px;margin:8px 0;border:1px solid rgba(0,0,0,0.06);}
.assistant{background:#fff;padding:12px;border-radius:12px;margin:8px 0;border:1px solid rgba(0,0,0,0.06);box-shadow:0 1px 4px rgba(45,32,22,0.04);}
pre{background:#2D2016;color:#F5F0E8;padding:14px;border-radius:12px;overflow-x:auto;}
code{background:#F5F0E8;color:#E8734A;padding:2px 6px;border-radius:4px;}</style></head><body>
<h1>${escapeHtml(session.title)}</h1><p>${formatTime(session.createdAt)} · ${session.model}</p><hr>`;
  session.messages.forEach(m => {
    html += `<div class="${m.role}"><strong>${m.role === 'user' ? '👤 用户' : '🤖 AI'}</strong><br>${(m.content || '').replace(/\n/g, '<br>')}</div>`;
  });
  html += '</body></html>';
  await nativeSaveFile(`${session.title}.html`, html);
  logSession('导出', `${session.title}.html`);
}

export async function exportAsTxt(session: ChatSession): Promise<void> {
  let txt = `${session.title}\n模型: ${session.model}\n时间: ${formatTime(session.createdAt)}\n${'='.repeat(50)}\n\n`;
  session.messages.forEach(m => {
    txt += `[${m.role === 'user' ? '用户' : 'AI'}]\n${m.content || ''}\n\n`;
  });
  await nativeSaveFile(`${session.title}.txt`, txt);
  logSession('导出', `${session.title}.txt`);
}
