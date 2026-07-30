/**
 * ChatArea - 聊天区域组件
 */

import { state, KEYS } from '../state/state.js';
import { logError, logSession } from '../services/log-service.js';
import { marked } from '../utils/marked-config.js';
import { escapeHtml, formatTime } from '../utils/utils.js';
import { estimateTokens } from '../services/context-manager.js';
import { getToolIcon, formatToolName } from '../services/tool-registry.js';
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

/** 渲染可折叠系统提示词卡片 */
let _sysPromptIdCounter = 0;
function renderSystemPromptCard(sysPrompt: string): string {
  const id = `sysprompt_${++_sysPromptIdCounter}`;
  const tokenEstimate = estimateTokens(sysPrompt);
  const preview = sysPrompt.length > 120 ? sysPrompt.slice(0, 120).replace(/\n/g, ' ') + '…' : sysPrompt.replace(/\n/g, ' ');
  return `<div class="system-prompt-card">
    <div class="system-prompt-header" onclick="
      var el=document.getElementById('${id}');
      var chev=this.querySelector('.sp-chevron');
      el.style.display=el.style.display==='none'?'':'none';
      chev.classList.toggle('sp-expanded');
    ">
      <span class="sp-icon">📋</span>
      <span class="sp-title">系统提示词</span>
      <span class="sp-tokens">~${tokenEstimate} tokens</span>
      <span class="sp-preview">${escapeHtml(preview)}</span>
      <svg class="sp-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="system-prompt-body" id="${id}" style="display:none;">
      <pre>${escapeHtml(sysPrompt)}</pre>
    </div>
  </div>`;
}

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

/** 发送新消息时重置自动滚动，确保新消息可见 */
export function resetAutoScroll(): void {
  autoScroll = true;
  if (scrollBtnEl) scrollBtnEl.style.display = 'none';
}

/** P1-1: 已渲染消息索引集合，用于稳定增量 diff（替代 DOM querySelectorAll 计数） */
const _renderedMsgIndices = new Set<number>();

/** R31: 最大渲染消息数（超过此数时仅渲染最近的消息，避免 DOM 过载） */
const MAX_RENDERED_MESSAGES = 200;

/** 标记当前渲染批次中系统提示词卡片是否已渲染（每会话仅首条 assistant 消息展示） */
let _sysPromptRendered = false;

/** R31: 增量渲染 — 仅追加新消息，避免全量重建 */
export function renderMessages(): void {
  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  const msgs = currentSession ? currentSession.messages : [];

  if (msgs.length === 0) {
    messagesContainerEl.innerHTML = '';
    currentPlaceholder = null;
    _renderedMsgIndices.clear();
    _sysPromptRendered = false;
    emptyStateEl.style.display = '';
    messagesContainerEl.style.display = 'none';
    return;
  }

  emptyStateEl.style.display = 'none';
  messagesContainerEl.style.display = '';

  // R31: 增量渲染 — 检查是否需要全量重建
  const needsFullRebuild = _renderedMsgIndices.size === 0
    || _renderedMsgIndices.size > msgs.length
    || Array.from(_renderedMsgIndices).some(idx => idx >= msgs.length);

  if (needsFullRebuild) {
    // 全量重建（首次加载或消息被截断/压缩后）
    messagesContainerEl.innerHTML = '';
    currentPlaceholder = null;
    _renderedMsgIndices.clear();
    _sysPromptRendered = false;

    // R31: 仅渲染最近 MAX_RENDERED_MESSAGES 条消息，避免 DOM 过载
    const startIdx = Math.max(0, msgs.length - MAX_RENDERED_MESSAGES);
    if (startIdx > 0) {
      const noticeDiv = document.createElement('div');
      noticeDiv.className = 'msg-truncated-notice';
      noticeDiv.style.cssText = 'text-align:center;padding:8px;font-size:12px;color:var(--text-muted);';
      noticeDiv.textContent = `⋯ 已折叠前 ${startIdx} 条消息，仅显示最近 ${MAX_RENDERED_MESSAGES} 条 ⋯`;
      messagesContainerEl.appendChild(noticeDiv);
    }

    for (let i = startIdx; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.role === 'system') continue;
      if (msg.role === 'assistant' && !msg.content && !msg.think && (!msg.toolCalls || msg.toolCalls.length === 0)) continue;
      appendMessageDOM(msgs[i], i);
      _renderedMsgIndices.add(i);
    }
  } else {
    // R31: 增量追加 — 只渲染新增的消息
    for (let i = 0; i < msgs.length; i++) {
      if (_renderedMsgIndices.has(i)) continue;
      const msg = msgs[i];
      if (msg.role === 'system') continue;
      if (msg.role === 'assistant' && !msg.content && !msg.think && (!msg.toolCalls || msg.toolCalls.length === 0)) continue;
      appendMessageDOM(msgs[i], i);
      _renderedMsgIndices.add(i);
    }
  }

  // R38: 为代码块添加复制按钮
  addCodeBlockCopyButtons();
  // R40: 为消息添加操作按钮
  addMessageActions();

  scrollToBottom();
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
  let safeContent = (msg.content != null) ? String(msg.content) : '';

  if (msg.role === 'assistant') {
    // ── 系统提示词折叠卡片（仅会话首条 assistant 消息展示，避免重复）──
    if (!_sysPromptRendered) {
      const sysPrompt = state.get<string>('_lastSystemPrompt', '');
      if (sysPrompt) {
        contentHtml += renderSystemPromptCard(sysPrompt);
      }
      _sysPromptRendered = true;
    }

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

  if ((msg as any)._videos && (msg as any)._videos.length > 0) {
    for (const v of (msg as any)._videos) {
      contentHtml += `<div class="msg-video-indicator">🎬 ${v.fileName} · ${v.frameCount} 帧 · 1fps</div>`;
    }
  } else if ((msg as any)._videoFrames && (msg as any)._videoFrames.length > 0) {
    const n = (msg as any)._videoFrames.length;
    contentHtml += `<div class="msg-video-indicator">🎬 ${n} 帧 · 1fps</div>`;
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
  const statusLabels: Record<string, string> = {
    pending: '📝 准备中…', running: '🔄 执行中', success: '✅ 完成', error: '❌ 失败', cancelled: '🚫 已取消'
  };

  const icon = getToolIcon(tc.name);
  const name = formatToolName(tc.name);
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

  // 失败/取消时显示错误信息（成功结果在工作空间工具页签查看）
  let errorHtml = '';
  if (tc.status === 'error' && tc.result?.error) {
    errorHtml = `<div class="tool-call-error">❌ ${escapeHtml(String(tc.result.error))}</div>`;
  } else if (tc.status === 'cancelled') {
    errorHtml = `<div class="tool-call-error">🚫 用户取消了操作</div>`;
  }

  return `<div class="tool-call-card tool-call-${tc.status}">
    <div class="tool-call-header">
      <span class="tool-call-icon">${icon}</span>
      <span class="tool-call-name">${name}</span>
      <span class="tool-call-status">${status}</span>
    </div>
    ${paramsHtml ? `<div class="tool-call-params">${paramsHtml}</div>` : ''}
    ${errorHtml}
  </div>`;
}

/**
 * 流式 Markdown 智能补全：检测并修复流式传输中不完整的 Markdown 语法
 * - 未闭合的代码块（``` / ~~~）→ 追加闭合标记
 * - 未闭合的行内代码（`）→ 追加闭合 `
 * - 未闭合的粗体（**）→ 追加闭合 **
 * 返回补全后的字符串（不修改原始内容，仅用于渲染）
 */
function patchIncompleteMarkdown(md: string): string {
  let patched = md;

  // ── 代码块围栏检测（``` 或 ~~~）──
  // 统计未闭合的围栏对
  const fenceRegex = /^([`~]{3,})/gm;
  const openFences: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(patched)) !== null) {
    openFences.push(match[1]);
  }
  // 如果有奇数个围栏，说明最后一个未闭合
  if (openFences.length % 2 === 1) {
    const lastFence = openFences[openFences.length - 1];
    patched += '\n' + lastFence;
  }

  // ── 行内代码反引号检测（仅当不在代码块内时才有意义）──
  // 简化处理：统计不在代码围栏内的奇数个反引号
  // 这里用一个保守的检测：如果末尾有奇数个 `（且不是围栏），补一个
  const inlineBackticks = (patched.match(/(?<!`)`(?!`)/g) || []).length;
  if (inlineBackticks % 2 === 1) {
    patched += '`';
  }

  return patched;
}

// ── 流式渲染节流状态 ──
let _streamRenderPending = false;
let _streamRenderContent = '';
// R58: 流式渲染优化 — 增量阈值 + 内容指纹，避免高频小片段冗余重渲染
let _streamLastRenderedLen = 0;     // 上次渲染时的内容长度
let _streamLastRenderedHash = 0;     // 上次渲染时的内容哈希（简单 DJB2）
const STREAM_MIN_DELTA = 15;         // 最小增量字符数（不足则跳过本次渲染）

/** R58: 快速 DJB2 哈希 */
function _djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash;
}

/**
 * 执行实际的流式 Markdown 渲染
 * R58: 添加增量阈值检查 — 内容增长不足 STREAM_MIN_DELTA 字符时跳过渲染
 */
function _doStreamRender(): void {
  _streamRenderPending = false;
  const lastMsg = currentPlaceholder;
  if (!lastMsg) return;
  // P1-R1 修复：rAF 回调执行时 currentPlaceholder 可能已被 appendAssistantPlaceholder 替换为新节点，
  // 且 _streamRenderContent 已被重置为 ''，此时不会误渲染。appendAssistantPlaceholder 中的
  // _streamRenderContent = '' 重置确保了旧 rAF 回调拿到的是空内容，不会渲染到新 placeholder。

  // R58: 增量阈值检查 — 内容变化不足时跳过本次渲染
  const contentLen = _streamRenderContent.length;
  const contentHash = _djb2(_streamRenderContent);
  if (contentLen > 0 && contentHash === _streamLastRenderedHash) return; // 内容完全相同
  if (contentLen - _streamLastRenderedLen < STREAM_MIN_DELTA && contentLen > 100) {
    // 内容增长不足且已有内容 → 跳过本次，等下次 rAF
    return;
  }
  _streamLastRenderedLen = contentLen;
  _streamLastRenderedHash = contentHash;

  const contentDiv = lastMsg.querySelector('.msg-content');
  if (contentDiv && _streamRenderContent) {
    // 智能补全不完整的 Markdown 语法后渲染
    const patched = patchIncompleteMarkdown(_streamRenderContent);
    contentDiv.innerHTML = safeMarkdown(patched);
  }
  scrollToBottom();
}

export function updateLastAssistantMessage(
  content: string, think: string | null, _stats: unknown, model?: string,
  timestamp?: number, toolCalls?: ToolCallRecord[]
): void {
  const lastMsg = currentPlaceholder;
  if (!lastMsg) return;

  const isFinal = toolCalls !== undefined || timestamp !== undefined;

  if (lastMsg.classList.contains('loading')) {
    lastMsg.classList.remove('loading');
    const loadingDots = lastMsg.querySelector('.loading-dots');
    const loadingText = lastMsg.querySelector('.loading-text');
    if (loadingDots) loadingDots.remove();
    if (loadingText) loadingText.remove();

    // 流式消息首次转正：注入系统提示词折叠卡片（仅当会话中无前序 assistant 消息时）
    const sysPrompt = state.get<string>('_lastSystemPrompt', '');
    if (sysPrompt && !lastMsg.querySelector('.system-prompt-card')) {
      const session = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
      const hasPrevAssistant = session?.messages.some(m => m.role === 'assistant') ?? false;
      if (!hasPrevAssistant) {
        const msgBody = lastMsg.querySelector('.msg-body');
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = renderSystemPromptCard(sysPrompt);
        const card = tempDiv.firstElementChild!;
        const thinkBlock = msgBody?.querySelector('.think-block');
        if (thinkBlock) {
          msgBody!.insertBefore(card, thinkBlock);
        } else {
          msgBody!.insertBefore(card, msgBody!.firstChild);
        }
      }
    }
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
    if (isFinal) {
      // 最终渲染：完整 Markdown + 代码块复制按钮
      contentDiv.innerHTML = safeMarkdown(safeContent);
      addCodeBlockCopyButtons(contentDiv);
    } else {
      // 流式期间：实时 Markdown 渲染 + rAF 节流
      // R58-fix: 移除对未声明变量 _streamRenderThink/_streamRenderModel 的赋值
      //   原代码在严格模式下会抛出 ReferenceError，被 chatStream 的空 catch 静默吞掉，
      //   导致 requestAnimationFrame(_doStreamRender) 永远不会被调用，流式渲染完全失效。
      //   think 和 model 已在上方（model tag）和下方（think block）直接处理，无需传递给 _doStreamRender。
      _streamRenderContent = safeContent;
      if (!_streamRenderPending) {
        _streamRenderPending = true;
        requestAnimationFrame(_doStreamRender);
      }
    }
  } else if (isFinal) {
    // R58: 最终渲染时重置增量追踪状态
    _streamLastRenderedLen = 0;
    _streamLastRenderedHash = 0;
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

  // ── 工具调用历史记录（可折叠）──
  if (toolCalls && toolCalls.length > 0) {
    let existingHistory = lastMsg.querySelector('.tool-calls-history');
    if (existingHistory) existingHistory.remove();

    const tcCount = toolCalls.length;
    const successCount = toolCalls.filter(t => t.status === 'success').length;
    const errorCount = toolCalls.filter(t => t.status === 'error').length;

    const historyDiv = document.createElement('div');
    historyDiv.className = 'tool-calls-history';
    historyDiv.innerHTML = `
      <div class="tool-calls-toggle" onclick="this.parentElement.classList.toggle('expanded')">
        <span class="tool-calls-chevron">▸</span>
        <span class="tool-calls-summary">🔧 ${tcCount} 个工具调用（✅${successCount} ❌${errorCount}）</span>
      </div>
      <div class="tool-calls-list">
        ${toolCalls.map(tc => renderToolCallCard(tc)).join('')}
      </div>
    `;
    const msgBody = lastMsg.querySelector('.msg-body');
    if (msgBody) {
      const refNode = contentDiv?.nextSibling || null;
      msgBody.insertBefore(historyDiv, refNode);
    }
  }

  // ── 时间戳 ──
  if (timestamp) {
    let statsDiv = lastMsg.querySelector('.msg-stats');
    if (!statsDiv) {
      statsDiv = document.createElement('div');
      statsDiv.className = 'msg-stats';
      const msgBody = lastMsg.querySelector('.msg-body');
      if (msgBody) msgBody.appendChild(statsDiv);
    }
    statsDiv.innerHTML = `<span>${formatTime(timestamp)}</span>`;
  }

  scrollToBottom();
}

export function appendAssistantPlaceholder(): void {
  const div = document.createElement('div');
  div.className = 'message assistant loading';
  // R34: 增强加载状态 — 添加旋转提示文本
  div.innerHTML = `
    <div class="msg-avatar">🤖</div>
    <div class="msg-body">
      <div class="msg-role">AI</div>
      <div class="msg-content">
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <span class="loading-text" data-hint-index="0">正在思考...</span>
      </div>
    </div>
  `;
  messagesContainerEl.appendChild(div);
  currentPlaceholder = div;

  // P0-R2 修复：新 placeholder 必须重置流式渲染状态，否则上一条的 _streamLastRenderedLen 会压制新消息渲染
  _streamLastRenderedLen = 0;
  _streamLastRenderedHash = 0;
  _streamRenderContent = '';
  _streamRenderPending = false;

  // R34: 启动旋转提示
  startLoadingHintRotation(div);

  scrollToBottom();
}

// R34: 加载提示旋转动画
const LOADING_HINTS = [
  '正在思考...',
  '正在分析问题...',
  '正在组织回答...',
  '正在查找信息...',
  '正在生成回复...',
];
let _loadingHintInterval: ReturnType<typeof setInterval> | null = null;

function startLoadingHintRotation(el: HTMLElement): void {
  if (_loadingHintInterval) clearInterval(_loadingHintInterval);
  let idx = 0;
  _loadingHintInterval = setInterval(() => {
    if (!el.isConnected) {
      if (_loadingHintInterval) clearInterval(_loadingHintInterval);
      _loadingHintInterval = null;
      return;
    }
    idx = (idx + 1) % LOADING_HINTS.length;
    const hintEl = el.querySelector('.loading-text');
    if (hintEl) {
      hintEl.textContent = LOADING_HINTS[idx];
    }
  }, 3000);
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
  _renderedMsgIndices.clear(); // P1-1: 重置 diff 状态
  // P1-R2 修复：重置系统提示词标记，否则清空后首条消息不再显示系统卡片
  _sysPromptRendered = false;
}

export function clearMessages(): void {
  messagesContainerEl.innerHTML = '';
  currentPlaceholder = null;
  _renderedMsgIndices.clear(); // P1-1: 重置 diff 状态
  // P1-R2 修复：与 clearMessagesDOM 保持一致
  _sysPromptRendered = false;
}

/** 清理 currentPlaceholder 引用（当 placeholder 从外部被移除时调用） */
export function resetCurrentPlaceholder(): void {
  if (currentPlaceholder && !currentPlaceholder.isConnected) {
    currentPlaceholder = null;
  }
  // R34: 清理加载提示旋转
  if (_loadingHintInterval) {
    clearInterval(_loadingHintInterval);
    _loadingHintInterval = null;
  }
}

/** 从 DOM 移除当前 placeholder 并清空引用 */
export function removeCurrentPlaceholder(): void {
  if (currentPlaceholder) {
    currentPlaceholder.remove();
    currentPlaceholder = null;
  }
}

export function enableAutoScroll(): void {
  autoScroll = true;
  if (scrollBtnEl) scrollBtnEl.style.display = 'none';
}

// ── R38: 代码块复制按钮 ──

/** R38: 为代码块添加复制按钮 */
function addCodeBlockCopyButtons(scope?: ParentNode): void {
  const root = scope || messagesContainerEl;
  const codeBlocks = root.querySelectorAll('pre:not([data-copy-added])');
  for (const pre of codeBlocks) {
    pre.setAttribute('data-copy-added', 'true');
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = '📋 复制';
    btn.style.cssText = 'position:absolute;top:4px;right:4px;padding:2px 8px;font-size:11px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;opacity:0;transition:opacity 0.2s;';
    // 确保 pre 是相对定位
    if (getComputedStyle(pre).position === 'static') {
      (pre as HTMLElement).style.position = 'relative';
    }
    pre.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    pre.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      if (text) {
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = '✅ 已复制';
          setTimeout(() => { btn.textContent = '📋 复制'; }, 2000);
        }).catch(() => {
          btn.textContent = '❌ 失败';
          setTimeout(() => { btn.textContent = '📋 复制'; }, 2000);
        });
      }
    });
    pre.appendChild(btn);
  }
}

// ── R40: 消息操作按钮 ──

/** R40: 为消息添加操作按钮（复制、重试） */
function addMessageActions(): void {
  const messages = messagesContainerEl.querySelectorAll('.message:not([data-actions-added])');
  for (const msg of messages) {
    msg.setAttribute('data-actions-added', 'true');
    const actionBar = document.createElement('div');
    actionBar.className = 'msg-actions';
    actionBar.style.cssText = 'position:absolute;top:4px;right:4px;display:flex;gap:4px;opacity:0;transition:opacity 0.2s;';

    // 确保 message 是相对定位
    if (getComputedStyle(msg).position === 'static') {
      (msg as HTMLElement).style.position = 'relative';
    }

    // 复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn msg-copy-btn';
    copyBtn.textContent = '📋';
    copyBtn.title = '复制消息';
    copyBtn.style.cssText = 'padding:2px 6px;font-size:12px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;';
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contentEl = msg.querySelector('.msg-content');
      const text = contentEl ? contentEl.textContent : '';
      if (text) {
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = '✅';
          setTimeout(() => { copyBtn.textContent = '📋'; }, 2000);
        }).catch(() => {});
      }
    });
    actionBar.appendChild(copyBtn);

    msg.addEventListener('mouseenter', () => { actionBar.style.opacity = '1'; });
    msg.addEventListener('mouseleave', () => { actionBar.style.opacity = '0'; });
    msg.appendChild(actionBar);
  }
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
