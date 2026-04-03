/**
 * InputArea - 输入区域组件
 * 包含文本输入、图片上传、发送逻辑
 */

import { state, KEYS } from '../state.js';
import { fileToBase64, debounce, truncate } from '../utils.js';
import { getSelectedModel, isThinkEnabled } from './model-bar.js';
import {
    renderMessages, appendAssistantPlaceholder, appendSystemMessage,
    updateLastAssistantMessage, clearMessages, safeMarkdown
} from './chat-area.js';
import { showToast } from './toast.js';
import { checkConnection } from './header.js';

let chatInputEl, btnSendEl, fileInputEl, imagePreviewEl;
let pendingImages = [];

export function initInputArea() {
    chatInputEl = document.querySelector('#chatInput');
    btnSendEl = document.querySelector('#btnSend');
    fileInputEl = document.querySelector('#fileInput');
    imagePreviewEl = document.querySelector('#imagePreview');

    // 发送
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
    document.querySelector('#btnAttach').addEventListener('click', () => fileInputEl.click());
    fileInputEl.addEventListener('change', (e) => {
        handleFileSelect(e.target.files);
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
}

function autoResizeTextarea() {
    chatInputEl.style.height = 'auto';
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 120) + 'px';
}

async function handleFileSelect(files) {
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
            <img src="data:image/png;base64,${img.base64}" alt="${img.name}">
            <button class="remove-img" data-index="${i}">×</button>
        </div>
    `).join('');
}

function updateSendButton(streaming) {
    if (streaming) {
        // 流式时显示停止按钮
        btnSendEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
        </svg>`;
        btnSendEl.classList.add('stop-btn');
        btnSendEl.classList.remove('disabled');
        btnSendEl.title = '停止生成';
    } else {
        // 恢复发送按钮
        btnSendEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>`;
        btnSendEl.classList.remove('stop-btn');
        btnSendEl.classList.remove('disabled');
        btnSendEl.title = '发送';
    }
}

/**
 * 停止生成 - 真正中止 Ollama 接口请求
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
export async function sendMessage() {
    const text = chatInputEl.value.trim();
    if (!text && pendingImages.length === 0) return;
    if (state.get(KEYS.IS_STREAMING)) return;

    const model = getSelectedModel();
    if (!model) {
        appendSystemMessage('⚠️ 请先选择一个模型');
        return;
    }

    const currentSession = state.get(KEYS.CURRENT_SESSION);
    if (!currentSession) return;

    // 构造用户消息
    const now = Date.now();
    const msgsToAdd = [];

    if (pendingImages.length > 0) {
        msgsToAdd.push({
            role: 'user',
            content: '',
            images: pendingImages.map(img => img.base64),
            timestamp: now
        });
    }

    if (text) {
        msgsToAdd.push({
            role: 'user',
            content: text,
            timestamp: now
        });
    }

    // 更新会话标题
    if (currentSession.messages.length === 0) {
        currentSession.title = truncate(text || '[图片消息]', 30);
        currentSession.model = model;
    }

    msgsToAdd.forEach(m => currentSession.messages.push(m));
    renderMessages();

    // 立即保存（防止新建会话或刷新时丢失用户消息）
    await saveCurrentSession();

    // 清空输入
    chatInputEl.value = '';
    pendingImages = [];
    imagePreviewEl.style.display = 'none';
    imagePreviewEl.innerHTML = '';
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

    // 流式回复状态变量（声明在 try 外，catch 中也需要访问）
    let assistantContent = '';
    let thinkContent = '';
    let finalStats = null;
    let modelName = '';

    try {
        const apiMessages = currentSession.messages.map(m => ({
            role: m.role,
            content: m.content || '',
            ...(m.images && { images: m.images })
        }));

        const chatParams = {
            model,
            messages: apiMessages,
            think: thinkMode,
            ...(systemPromptEnabled && systemPrompt && { system: systemPrompt }),
            ...(numCtx && { options: { num_ctx: numCtx } })
        };

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
            ...(finalStats && { eval_count: finalStats.eval_count, total_duration: finalStats.total_duration })
        };
        currentSession.messages.push(assistantMsg);

        if (finalStats) {
            updateLastAssistantMessage(assistantContent, thinkContent || null, finalStats, modelName || null);
        }

        await saveCurrentSession();

    } catch (err) {
        console.error('[InputArea] 流式聊天错误:', err);

        // 处理用户主动停止（AbortError）
        if (err.name === 'AbortError') {
            const placeholder = document.querySelector('#messagesContainer .message.assistant:last-child');
            const loadingDots = placeholder?.querySelector('.loading-dots');
            const loadingText = placeholder?.querySelector('.loading-text');
            if (loadingDots) loadingDots.remove();
            if (loadingText) loadingText.remove();

            const contentDiv = placeholder?.querySelector('.msg-content');

            // 保存部分消息（直接用 assistantContent，不从 DOM 读）
            const partialMsg = {
                role: 'assistant',
                content: assistantContent,
                timestamp: Date.now(),
                ...(modelName && { model: modelName }),
                ...(thinkContent && { think: thinkContent }),
                stopped: true
            };
            currentSession.messages.push(partialMsg);

            // 更新 DOM
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

        // 其他错误
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
