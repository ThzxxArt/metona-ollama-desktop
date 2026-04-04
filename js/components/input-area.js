/**
 * InputArea - 输入区域组件
 * 包含文本输入、图片上传、文件上传、发送逻辑
 */

import { state, KEYS } from '../state.js';
import { fileToBase64, fileToText, detectLanguage, debounce, truncate, escapeHtml, formatSize } from '../utils.js';
import { getSelectedModel, isThinkEnabled, isVisionAvailable } from './model-bar.js';
import {
    renderMessages, appendAssistantPlaceholder, appendSystemMessage,
    updateLastAssistantMessage, clearMessages, safeMarkdown, enableAutoScroll
} from './chat-area.js';
import { showToast } from './toast.js';
import { checkConnection } from './header.js';
import { isRagEnabled, performRagRetrieval } from './kb-modal.js';

let chatInputEl, btnSendEl, fileInputEl, textFileInputEl, imagePreviewEl, filePreviewEl;
let pendingImages = [];
let pendingFiles = [];

/** 常见文本/代码文件扩展名集合（用于校验） */
const TEXT_EXTENSIONS = new Set([
    'txt','md','markdown','rst','log','csv','tsv',
    'py','pyw','pyi','js','mjs','cjs','ts','tsx','jsx',
    'java','c','h','cpp','cc','cxx','hpp','go','rs','rb','php',
    'sh','bash','zsh','fish','sql','html','htm','css',
    'json','jsonl','xml','svg','yaml','yml','toml','ini','cfg','conf',
    'swift','kt','kts','scala','lua','r','m','mm',
    'cs','fs','vb','ex','exs','erl','hs','clj','lisp',
    'diff','patch','pl','dockerfile','makefile'
]);

/** 最大文件大小 500KB */
const MAX_FILE_SIZE = 500 * 1024;

/** 根据文件名返回图标 */
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

/** 判断是否为文本/代码文件 */
function isTextFile(file) {
    // 无扩展名的特殊文件名
    const name = file.name.toLowerCase();
    if (name === 'dockerfile' || name === 'makefile') return true;
    const ext = name.split('.').pop();
    return TEXT_EXTENSIONS.has(ext);
}

export function initInputArea() {
    chatInputEl = document.querySelector('#chatInput');
    btnSendEl = document.querySelector('#btnSend');
    fileInputEl = document.querySelector('#fileInput');
    textFileInputEl = document.querySelector('#textFileInput');
    imagePreviewEl = document.querySelector('#imagePreview');
    filePreviewEl = document.querySelector('#filePreview');

    // 发送 / 停止
    btnSendEl.addEventListener('click', () => {
        if (state.get(KEYS.IS_STREAMING)) {
            stopGeneration();
        } else {
            sendMessage();
        }
    });
    chatInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // 输入框自动调整
    chatInputEl.addEventListener('input', autoResizeTextarea);

    // 图片上传
    document.querySelector('#btnAttachImg').addEventListener('click', () => {
        if (!isVisionAvailable()) {
            showToast('当前模型不支持图片分析', 'warning');
            return;
        }
        fileInputEl.click();
    });
    fileInputEl.addEventListener('change', (e) => {
        handleImageSelect(e.target.files);
        e.target.value = '';
    });

    // 文件上传（文本/代码）
    document.querySelector('#btnAttachFile').addEventListener('click', () => textFileInputEl.click());
    textFileInputEl.addEventListener('change', (e) => {
        handleTextFileSelect(e.target.files);
        e.target.value = '';
    });

    // 删除图片预览
    imagePreviewEl.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-img')) {
            const idx = parseInt(e.target.dataset.index);
            pendingImages.splice(idx, 1);
            renderImagePreviews();
        }
    });

    // 删除文件预览
    filePreviewEl.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-file')) {
            const idx = parseInt(e.target.dataset.index);
            pendingFiles.splice(idx, 1);
            renderFilePreviews();
        }
    });
}

function autoResizeTextarea() {
    chatInputEl.style.height = 'auto';
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 120) + 'px';
}

// ── 图片处理 ──

async function handleImageSelect(files) {
    const maxSize = 20 * 1024 * 1024;
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        if (file.size > maxSize) {
            appendSystemMessage(`⚠️ 图片 ${file.name} 超过 20MB 限制`);
            continue;
        }
        try {
            const base64 = await fileToBase64(file);
            pendingImages.push({ name: file.name, base64 });
            renderImagePreviews();
        } catch (err) {
            console.error('[InputArea] 图片读取失败:', err);
        }
    }
}

function renderImagePreviews() {
    if (pendingImages.length === 0) {
        imagePreviewEl.style.display = 'none';
        imagePreviewEl.innerHTML = '';
        return;
    }
    imagePreviewEl.style.display = '';
    imagePreviewEl.innerHTML = pendingImages.map((img, i) => `
        <div class="preview-thumb">
            <img src="data:image/png;base64,${img.base64}" alt="${escapeHtml(img.name)}">
            <button class="remove-img" data-index="${i}">×</button>
        </div>
    `).join('');
}

// ── 文件处理（文本/代码） ──

async function handleTextFileSelect(files) {
    for (const file of files) {
        if (!isTextFile(file)) {
            appendSystemMessage(`⚠️ ${file.name} 不是支持的文本/代码文件`);
            continue;
        }
        if (file.size > MAX_FILE_SIZE) {
            appendSystemMessage(`⚠️ ${file.name} 超过 500KB 限制（${formatSize(file.size)}）`);
            continue;
        }
        // 重复检测
        if (pendingFiles.some(f => f.name === file.name && f.size === file.size)) {
            appendSystemMessage(`ℹ️ ${file.name} 已添加`);
            continue;
        }
        try {
            const content = await fileToText(file);
            pendingFiles.push({
                name: file.name,
                content,
                language: detectLanguage(file.name),
                size: file.size
            });
            renderFilePreviews();
        } catch (err) {
            console.error('[InputArea] 文件读取失败:', err);
            appendSystemMessage(`❌ 读取 ${file.name} 失败`);
        }
    }
}

function renderFilePreviews() {
    if (pendingFiles.length === 0) {
        filePreviewEl.style.display = 'none';
        filePreviewEl.innerHTML = '';
        return;
    }
    filePreviewEl.style.display = '';
    filePreviewEl.innerHTML = pendingFiles.map((f, i) => `
        <div class="file-chip">
            <span class="file-icon">${getFileIcon(f.name)}</span>
            <span class="file-name">${escapeHtml(f.name)}</span>
            <span class="file-size">${formatSize(f.size)}</span>
            <button class="remove-file" data-index="${i}" title="移除">×</button>
        </div>
    `).join('');
}

// ── UI 状态 ──

function updateSendButton(streaming) {
    if (streaming) {
        btnSendEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
        </svg>`;
        btnSendEl.classList.add('stop-btn');
        btnSendEl.classList.remove('disabled');
        btnSendEl.title = '停止生成';
    } else {
        btnSendEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>`;
        btnSendEl.classList.remove('stop-btn');
        btnSendEl.classList.remove('disabled');
        btnSendEl.title = '发送';
    }
}

/**
 * 停止生成
 */
function stopGeneration() {
    const abortController = state.get(KEYS.ABORT_CONTROLLER);
    if (abortController) {
        abortController.abort();
    }
}

/**
 * 核心发送逻辑
 */

/** 构建发送给 Ollama API 的消息数组：将文件内容拼入 content */
function buildApiMessages(messages) {
    return messages.map(m => {
        let content = m.content || '';
        // 如果有文件内容，拼接到 API 消息的 content 中
        if (m._fileContents && m._fileContents.length > 0) {
            const fileParts = m._fileContents.map(f => {
                const lang = f.language || '';
                return `📄 以下是一个文件内容：\n\n\`\`\`${lang}\n${f.content}\n\`\`\``;
            });
            if (content) {
                content += '\n\n---\n' + fileParts.join('\n\n---\n');
            } else {
                const count = m._fileContents.length;
                content = `请分析以下 ${count > 1 ? count + ' 个' : ''}文件：\n\n${fileParts.join('\n\n---\n')}`;
            }
        }
        return {
            role: m.role,
            content,
            ...(m.images && { images: m.images })
        };
    });
}

export async function sendMessage() {
    const text = chatInputEl.value.trim();
    if (!text && pendingImages.length === 0 && pendingFiles.length === 0) return;
    if (state.get(KEYS.IS_STREAMING)) return;

    const model = getSelectedModel();
    if (!model) {
        appendSystemMessage('⚠️ 请先选择一个模型');
        return;
    }

    // 有图片但模型不支持 vision → 阻止发送
    if (pendingImages.length > 0 && !isVisionAvailable()) {
        appendSystemMessage('⚠️ 当前模型不支持图片分析，请移除图片后重试');
        return;
    }

    const currentSession = state.get(KEYS.CURRENT_SESSION);
    if (!currentSession) return;

    const now = Date.now();
    const msgsToAdd = [];

    // ── 构造用户消息：展示用（content=纯文本，files=元数据） ──
    const userFiles = pendingFiles.map(f => ({
        name: f.name,
        language: f.language,
        size: f.size
    }));

    // 场景1：有图片
    if (pendingImages.length > 0) {
        msgsToAdd.push({
            role: 'user',
            content: pendingImages.length === 1
                ? `[上传了图片: ${pendingImages[0].name}]`
                : `[上传了 ${pendingImages.length} 张图片]`,
            images: pendingImages.map(img => img.base64),
            timestamp: now
        });
    }

    // 场景2：有文本输入 + 文件，或者只有文件
    if (text || pendingFiles.length > 0) {
        const msg = {
            role: 'user',
            content: text || '',
            timestamp: now
        };
        if (userFiles.length > 0) {
            msg.files = userFiles;
            msg._fileContents = pendingFiles.map(f => ({
                language: f.language,
                content: f.content
            }));
        }
        msgsToAdd.push(msg);
    }

    // 更新会话标题
    if (currentSession.messages.length === 0) {
        const titleText = text
            || (pendingFiles.length > 0 ? `[文件: ${pendingFiles.map(f => f.name).join(', ')}]` : '[图片消息]');
        currentSession.title = truncate(titleText, 30);
        currentSession.model = model;
    }

    msgsToAdd.forEach(m => currentSession.messages.push(m));
    enableAutoScroll();
    renderMessages();

    // 立即保存
    await saveCurrentSession();

    // 清空输入
    chatInputEl.value = '';
    pendingImages = [];
    pendingFiles = [];
    imagePreviewEl.style.display = 'none';
    imagePreviewEl.innerHTML = '';
    filePreviewEl.style.display = 'none';
    filePreviewEl.innerHTML = '';
    autoResizeTextarea();

    // 助手占位
    appendAssistantPlaceholder();

    // 流式回复
    state.set(KEYS.IS_STREAMING, true);
    updateSendButton(true);

    const api = state.get(KEYS.API);
    const abortController = new AbortController();
    state.set(KEYS.ABORT_CONTROLLER, abortController);
    const thinkMode = isThinkEnabled();
    const systemPromptEnabled = state.get(KEYS.SYSTEM_PROMPT_ENABLED);
    const systemPrompt = state.get(KEYS.SYSTEM_PROMPT);
    const numCtx = state.get(KEYS.NUM_CTX, 24576);

    let assistantContent = '';
    let thinkContent = '';
    let finalStats = null;
    let modelName = '';

    try {
        const apiMessages = buildApiMessages(currentSession.messages);

        const chatParams = {
            model,
            messages: apiMessages,
            think: thinkMode,
            ...(systemPromptEnabled && systemPrompt && { system: systemPrompt }),
            ...(numCtx && { options: { num_ctx: numCtx } })
        };

        // RAG 检索增强
        let ragSources = null;
        if (isRagEnabled()) {
            appendSystemMessage('🧠 正在检索知识库...');
            try {
                const ragResult = await performRagRetrieval(text);
                if (ragResult && ragResult.results && ragResult.results.length > 0) {
                    chatParams.system = chatParams.system
                        ? chatParams.system + '\n\n' + ragResult.ragPrompt
                        : ragResult.ragPrompt;
                    ragSources = ragResult.results.map(r => ({
                        filename: r.filename,
                        score: r.score,
                        text: truncate(r.text, 100)
                    }));
                    const sourceNames = [...new Set(ragSources.map(s => s.filename))];
                    appendSystemMessage(`🧠 已检索 ${ragSources.length} 个相关片段（来源：${sourceNames.join('、')}）`);
                } else {
                    appendSystemMessage('🧠 知识库未检索到相关内容，使用通用知识回答');
                }
            } catch (ragErr) {
                console.error('[RAG] 检索失败:', ragErr);
                appendSystemMessage(`🧠 知识库检索失败: ${ragErr.message}`);
            }
        }

        await api.chatStream(chatParams, (chunk) => {
            if (chunk.message) {
                if (chunk.message.content) {
                    assistantContent += chunk.message.content;
                }
                const think = chunk.message.thinking || chunk.message.reasoning_content;
                if (think && typeof think === 'string') {
                    thinkContent += think;
                }
            }
            if (chunk.model) modelName = chunk.model;
            updateLastAssistantMessage(assistantContent, thinkContent || null, null, modelName || null);
            if (chunk.done) {
                finalStats = { eval_count: chunk.eval_count, total_duration: chunk.total_duration };
            }
        }, abortController);

        const assistantMsg = {
            role: 'assistant',
            content: assistantContent || '',
            timestamp: Date.now(),
            ...(modelName && { model: modelName }),
            ...(thinkContent && { think: thinkContent }),
            ...(finalStats && { eval_count: finalStats.eval_count, total_duration: finalStats.total_duration }),
            ...(ragSources && { ragSources })
        };
        currentSession.messages.push(assistantMsg);

        if (finalStats) {
            updateLastAssistantMessage(assistantContent, thinkContent || null, finalStats, modelName || null);
        }

        await saveCurrentSession();

    } catch (err) {
        console.error('[InputArea] 流式聊天错误:', err);

        if (err.name === 'AbortError') {
            const placeholder = document.querySelector('#messagesContainer .message.assistant:last-child');
            const loadingDots = placeholder?.querySelector('.loading-dots');
            const loadingText = placeholder?.querySelector('.loading-text');
            if (loadingDots) loadingDots.remove();
            if (loadingText) loadingText.remove();

            const contentDiv = placeholder?.querySelector('.msg-content');

            const partialMsg = {
                role: 'assistant',
                content: assistantContent,
                timestamp: Date.now(),
                ...(modelName && { model: modelName }),
                ...(thinkContent && { think: thinkContent }),
                stopped: true
            };
            currentSession.messages.push(partialMsg);

            if (contentDiv) {
                let html = '';
                if (assistantContent) {
                    html = safeMarkdown(assistantContent);
                }
                html += '<p><code>[已停止]</code></p>';
                contentDiv.innerHTML = html;
            }

            appendSystemMessage('⏹ 已停止生成');
            await saveCurrentSession();

            state.set(KEYS.IS_STREAMING, false);
            updateSendButton(false);
            state.set(KEYS.ABORT_CONTROLLER, null);
            return;
        }

        const placeholder = document.querySelector('#messagesContainer .message.assistant:last-child');
        const loadingDots = placeholder?.querySelector('.loading-dots');
        const loadingText = placeholder?.querySelector('.loading-text');
        if (loadingDots) loadingDots.remove();
        if (loadingText) loadingText.remove();

        const contentDiv = placeholder?.querySelector('.msg-content');

        if (assistantContent && contentDiv) {
            const partialMsg = {
                role: 'assistant',
                content: assistantContent + '\n\n`[已中断]`',
                timestamp: Date.now(),
            };
            currentSession.messages.push(partialMsg);
            contentDiv.innerHTML = safeMarkdown(assistantContent) + '<p><code>[已中断]</code></p>';
            await saveCurrentSession();
        } else {
            if (placeholder) placeholder.remove();
        }

        let errMsg = `❌ 错误: ${err.message}`;
        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
            errMsg = '❌ 连接失败。请检查：\n1. Ollama 是否正在运行\n2. 地址是否正确\n3. 是否设置了 OLLAMA_ORIGINS="*"';
        }
        appendSystemMessage(errMsg);

    } finally {
        state.set(KEYS.IS_STREAMING, false);
        updateSendButton(false);
        state.set(KEYS.ABORT_CONTROLLER, null);
    }
}

async function saveCurrentSession() {
    const db = state.get(KEYS.DB);
    const currentSession = state.get(KEYS.CURRENT_SESSION);
    const isHistoryView = state.get(KEYS.IS_HISTORY_VIEW);
    if (!currentSession || !db || isHistoryView) return;
    currentSession.updatedAt = Date.now();
    try {
        await db.saveSession(currentSession);
    } catch (err) {
        console.error('[InputArea] 保存会话失败:', err);
    }
}
