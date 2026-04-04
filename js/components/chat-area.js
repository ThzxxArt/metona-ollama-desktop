/**
 * ChatArea - 聊天区域组件
 * 负责消息渲染、流式更新、导出功能
 */

import { state, KEYS } from '../state.js';
import { marked } from '../marked-config.js';
import { escapeHtml, formatTime, downloadFile } from '../utils.js';

/** 根据文件名返回合适的图标 */
function getFileIcon(filename) {
    const name = filename.toLowerCase();
    if (name === 'dockerfile') return '🐳';
    if (name === 'makefile' || name === 'gnumakefile') return '🔨';
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
        py: '🐍', pyw: '🐍', pyi: '🐍',
        js: '💛', mjs: '💛', cjs: '💛',
        ts: '🔷', tsx: '⚛️', jsx: '⚛️',
        java: '☕', go: '🐹', rs: '🦀', rb: '💎',
        php: '🐘', swift: '🍎', kt: '🤖', scala: '🔴',
        lua: '🌙', pl: '🐪', r: '📐', m: '📐',
        cs: '🟪', fs: '🔵', vb: '🔷',
        ex: '💧', exs: '💧', erl: '📞', hs: '🟣',
        clj: '🟢', lisp: '🟢',
        cpp: '⚙️', cc: '⚙️', cxx: '⚙️', hpp: '⚙️',
        c: '⚙️', h: '⚙️',
        sh: '🐚', bash: '🐚', zsh: '🐚', fish: '🐚',
        html: '🌐', htm: '🌐', css: '🎨', svg: '🎨',
        json: '📋', yaml: '📋', yml: '📋', toml: '📋',
        ini: '📋', cfg: '📋', conf: '📋',
        xml: '📰', sql: '🗃️',
        md: '📝', markdown: '📝', rst: '📝', txt: '📄',
        log: '📜', csv: '📊', tsv: '📊',
        diff: '🔀', patch: '🔀',
    };
    return map[ext] || '📄';
}

let chatAreaEl, messagesContainerEl, emptyStateEl, scrollBtnEl;
let autoScroll = true; // 是否自动滚动到底部

export function initChatArea() {
    chatAreaEl = document.querySelector('#chatArea');
    messagesContainerEl = document.querySelector('#messagesContainer');
    emptyStateEl = document.querySelector('#emptyState');
    scrollBtnEl = document.querySelector('#scrollToBottom');

    // 监听用户手动滚动
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

    // 点击滚动到底部按钮
    scrollBtnEl.addEventListener('click', () => {
        autoScroll = true;
        scrollBtnEl.style.display = 'none';
        chatAreaEl.scrollTo({ top: chatAreaEl.scrollHeight, behavior: 'smooth' });
    });
}

/** 判断是否在底部附近（60px 容差） */
function isAtBottom() {
    return chatAreaEl.scrollHeight - chatAreaEl.scrollTop - chatAreaEl.clientHeight < 60;
}

/** 安全地将 Markdown 转为 HTML */
export function safeMarkdown(text) {
    if (!text && text !== 0) return '';
    const str = typeof text === 'string' ? text : String(text);
    if (!str) return '';
    try {
        const result = marked.parse(str);
        return typeof result === 'string' ? result : escapeHtml(str);
    } catch (e) {
        return escapeHtml(str);
    }
}

/** 滚动到底部（仅当 autoScroll 开启时） */
export function scrollToBottom() {
    if (!autoScroll) return;
    requestAnimationFrame(() => {
        chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
    });
}

/** 渲染所有消息（增量渲染） */
export function renderMessages() {
    const currentSession = state.get(KEYS.CURRENT_SESSION);
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

    // 新消息按 autoScroll 决定；首次渲染（加载历史）强制滚到底部
    if (isNewMessage) {
        scrollToBottom();
    } else if (msgs.length > 0) {
        chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
    }
}

/** 追加单条消息 DOM */
export function appendMessageDOM(msg, index) {
    const div = document.createElement('div');
    div.className = `message ${msg.role}`;
    div.dataset.index = index;

    const avatar = msg.role === 'user' ? '👤' : '🤖';
    const roleLabel = msg.role === 'user' ? '你' : 'AI';
    const modelTag = (msg.role === 'assistant' && msg.model)
        ? `<span class="model-tag">${escapeHtml(msg.model)}</span>`
        : '';

    let contentHtml = '';
    const safeContent = (msg.content != null) ? String(msg.content) : '';

    if (msg.role === 'assistant') {
        // 思考块
        if (msg.think) {
            contentHtml += `
                <div class="think-block">
                    <div class="think-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? '' : 'none'; this.querySelector('.chevron').classList.toggle('expanded');">
                        <span>🤔 思考过程</span>
                        <svg class="chevron expanded" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    <div class="think-content">
                        <pre>${escapeHtml(msg.think)}</pre>
                    </div>
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

    // 图片
    if (msg.images && msg.images.length > 0) {
        contentHtml += '<div class="msg-images">';
        for (const img of msg.images) {
            contentHtml += `<img class="msg-img" src="data:image/png;base64,${img}" alt="用户图片" data-lightbox="true">`;
        }
        contentHtml += '</div>';
    }

    // 文件 chip（展示用，不暴露文件内容）
    if (msg.files && msg.files.length > 0) {
        contentHtml += '<div class="msg-files">';
        for (const f of msg.files) {
            const icon = getFileIcon(f.name);
            contentHtml += `<div class="file-chip"><span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(f.name)}</span></div>`;
        }
        contentHtml += '</div>';
    }

    // 纯图片/文件消息隐藏空内容
    if (msg.role === 'user' && (!msg.content || msg.content.trim() === '') && (msg.images?.length > 0 || msg.files?.length > 0)) {
        contentHtml = contentHtml.replace('<div class="msg-content"></div>', '');
    } else if (msg.role === 'user' && msg.files?.length > 0 && msg.content) {
        // 有文本也有文件，保留文本内容展示
    }

    // 统计信息
    const stats = [];
    if (msg.timestamp) stats.push(formatTime(msg.timestamp));
    if (msg.eval_count) stats.push(`${msg.eval_count} tokens`);
    if (msg.total_duration) stats.push(`${(msg.total_duration / 1e9).toFixed(1)}s`);
    if (stats.length > 0) {
        contentHtml += `<div class="msg-stats">${stats.map(s => `<span>${s}</span>`).join(' · ')}</div>`;
    }

    // RAG 知识库来源
    if (msg.role === 'assistant' && msg.ragSources && msg.ragSources.length > 0) {
        const sourcesHtml = msg.ragSources.map((s, i) => {
            const scorePercent = s.score ? `${(s.score * 100).toFixed(0)}%` : '';
            return `<div class="rag-source-item">
                <span class="rag-source-name">📄 来源 ${i + 1}: ${escapeHtml(s.filename)}</span>
                ${scorePercent ? `<span class="rag-source-score">${scorePercent}</span>` : ''}
            </div>`;
        }).join('');
        contentHtml += `<div class="rag-sources">
            <div class="rag-sources-header">🧠 基于知识库回答</div>
            ${sourcesHtml}
        </div>`;
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

/** 更新最后一条 assistant 消息（流式输出） */
export function updateLastAssistantMessage(content, think, stats, model) {
    let lastMsg = messagesContainerEl.querySelector('.message.assistant.loading');
    if (!lastMsg) {
        // loading class 已在首次调用时移除，用 last-of-type 回退
        lastMsg = messagesContainerEl.querySelector('.message.assistant:last-of-type');
    }
    if (!lastMsg) return;

    // 仅首次调用时移除 loading 指示器
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

    // 思考块
    let thinkBlock = lastMsg.querySelector('.think-block');
    if (think) {
        if (!thinkBlock) {
            const msgBody = lastMsg.querySelector('.msg-body');
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
        thinkBlock.querySelector('pre').textContent = think;
    }

    if (stats) {
        let statsDiv = lastMsg.querySelector('.msg-stats');
        if (!statsDiv) {
            statsDiv = document.createElement('div');
            statsDiv.className = 'msg-stats';
            lastMsg.querySelector('.msg-body').appendChild(statsDiv);
        }
        const parts = [];
        if (stats.eval_count) parts.push(`${stats.eval_count} tokens`);
        if (stats.total_duration) parts.push(`${(stats.total_duration / 1e9).toFixed(1)}s`);
        if (parts.length) statsDiv.innerHTML = parts.join(' · ');
    }

    scrollToBottom();
}

/** 追加临时的 assistant 消息占位 */
export function appendAssistantPlaceholder() {
    const div = document.createElement('div');
    div.className = 'message assistant loading';
    div.innerHTML = `
        <div class="msg-avatar">🤖</div>
        <div class="msg-body">
            <div class="msg-role">AI</div>
            <div class="msg-content">
                <div class="loading-dots">
                    <span></span><span></span><span></span>
                </div>
                <span class="loading-text">正在思考...</span>
            </div>
        </div>
    `;
    messagesContainerEl.appendChild(div);
    scrollToBottom();
}

/** 追加系统提示消息 */
export function appendSystemMessage(text) {
    const div = document.createElement('div');
    div.style.cssText = 'text-align:center;padding:8px;font-size:12px;color:var(--text-muted);';
    div.textContent = text;
    emptyStateEl.style.display = 'none';
    messagesContainerEl.style.display = '';
    messagesContainerEl.appendChild(div);
    scrollToBottom();
}

/** 获取消息容器 */
export function getMessagesContainer() {
    return messagesContainerEl;
}

/** 清空消息 DOM */
export function clearMessages() {
    messagesContainerEl.innerHTML = '';
}

/** 重置自动滚动（用户发送消息、新建会话时调用） */
export function enableAutoScroll() {
    autoScroll = true;
    if (scrollBtnEl) scrollBtnEl.style.display = 'none';
}

// ── 导出功能 ──

/** 导出为 Markdown */
export function exportAsMarkdown(session) {
    let md = `# ${session.title}\n\n`;
    md += `**模型:** ${session.model}  \n`;
    md += `**时间:** ${formatTime(session.createdAt)}\n\n---\n\n`;

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

/** 导出为 HTML */
export function exportAsHtml(session) {
    let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(session.title)}</title>
<style>body{max-width:800px;margin:0 auto;padding:20px;font-family:system-ui;line-height:1.6;background:#0a0a1a;color:#e8e8f0;}
.user{background:rgba(25,25,60,0.5);padding:12px;border-radius:8px;margin:8px 0;}
.assistant{background:rgba(0,245,212,0.03);padding:12px;border-radius:8px;margin:8px 0;border:1px solid rgba(0,245,212,0.08);}
h1{background:linear-gradient(135deg,#00f5d4,#7b2ff7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
pre{background:rgba(0,0,0,0.3);padding:12px;border-radius:8px;overflow-x:auto;}
code{background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px;}</style></head><body>
<h1>${escapeHtml(session.title)}</h1><p>${formatTime(session.createdAt)} · ${session.model}</p><hr>`;

    session.messages.forEach(m => {
        const fileChips = (m.files && m.files.length > 0)
            ? '<br>' + m.files.map(f => `<span style="background:rgba(123,47,247,0.15);padding:2px 8px;border-radius:4px;font-size:12px;margin:2px;display:inline-block;">📎 ${escapeHtml(f.name)}</span>`).join(' ')
            : '';
        html += `<div class="${m.role}"><strong>${m.role === 'user' ? '👤 用户' : '🤖 AI'}</strong>${fileChips}<br>${(m.content || '').replace(/\n/g, '<br>')}</div>`;
    });

    html += '</body></html>';
    downloadFile(`${session.title}.html`, html, 'text/html');
}

/** 导出为 TXT */
export function exportAsTxt(session) {
    let txt = `${session.title}\n模型: ${session.model}\n时间: ${formatTime(session.createdAt)}\n${'='.repeat(50)}\n\n`;

    session.messages.forEach(m => {
        txt += `[${m.role === 'user' ? '用户' : 'AI'}]\n`;
        if (m.files && m.files.length > 0) {
            txt += m.files.map(f => `📎 ${f.name}`).join(' · ') + '\n';
        }
        txt += `${m.content || ''}\n\n`;
    });

    downloadFile(`${session.title}.txt`, txt, 'text/plain');
}
