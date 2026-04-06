/**
 * InputArea - 输入区域组件
 */

import { state, KEYS } from '../state/state.js';
import { detectLanguage, truncate, escapeHtml, formatSize } from '../utils/utils.js';
import { getSelectedModel, isThinkEnabled, isVisionAvailable, isToolCallingSupported } from './model-bar.js';
import {
  renderMessages, appendAssistantPlaceholder, appendSystemMessage,
  updateLastAssistantMessage, clearMessages, safeMarkdown, enableAutoScroll, updateTotalTokens
} from './chat-area.js';
import { showToast } from './toast.js';
import { isRagEnabled, performRagRetrieval } from './kb-modal.js';
import { ChatDB } from '../db/chat-db.js';
import { OllamaAPI } from '../api/ollama.js';
import { runAgentLoop } from '../services/agent-engine.js';
import { searchMemories, buildMemoryContext, markMemoryUsed, extractMemoriesFromConversation, isMemoryEnabled } from '../services/memory-manager.js';
import { showToolConfirm } from './tool-confirm-modal.js';
import { logInfo, logStream, logError, logSuccess, logWarn } from '../services/log-service.js';
import type { ChatSession, ChatMessage, OllamaStreamChunk, RagSource, FileContent, ChatFile, ToolCallRecord } from '../types.js';

let chatInputEl: HTMLTextAreaElement;
let btnSendEl: HTMLButtonElement;
let imagePreviewEl: HTMLElement;
let filePreviewEl: HTMLElement;
let pendingImages: Array<{ name: string; base64: string }> = [];
let pendingFiles: Array<{ name: string; content: string; language: string; size: number }> = [];

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

const MAX_FILE_SIZE = 500 * 1024;

function getFileIcon(filename: string): string {
  const name = filename.toLowerCase();
  if (name === 'dockerfile') return '🐳';
  if (name === 'makefile' || name === 'gnumakefile') return '🔨';
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = { py: '🐍', js: '💛', ts: '🔷', java: '☕', go: '🐹', rs: '🦀', cpp: '⚙️', c: '⚙️', sh: '🐚', html: '🌐', css: '🎨', json: '📋', md: '📝', txt: '📄', sql: '🗃️', csv: '📊' };
  return map[ext] || '📄';
}

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return true;
  const ext = lower.split('.').pop() || '';
  return TEXT_EXTENSIONS.has(ext);
}

function getBridge(): any {
  return (window as any).metonaDesktop;
}

export function initInputArea(): void {
  chatInputEl = document.querySelector('#chatInput')!;
  btnSendEl = document.querySelector('#btnSend')!;
  imagePreviewEl = document.querySelector('#imagePreview')!;
  filePreviewEl = document.querySelector('#filePreview')!;

  btnSendEl.addEventListener('click', () => {
    if (state.get<boolean>(KEYS.IS_STREAMING)) {
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

  chatInputEl.addEventListener('input', autoResizeTextarea);

  // ── 图片上传：原生文件对话框 ──
  document.querySelector('#btnAttachImg')!.addEventListener('click', async () => {
    if (!isVisionAvailable()) {
      showToast('当前模型不支持图片分析', 'warning');
      return;
    }
    const bridge = getBridge();
    if (!bridge) return;
    const paths = await bridge.dialog.openFile({
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
    });
    if (!paths || paths.length === 0) return;
    await handleImagePaths(paths);
  });

  // ── 文件上传：原生文件对话框 ──
  document.querySelector('#btnAttachFile')!.addEventListener('click', async () => {
    const bridge = getBridge();
    if (!bridge) return;
    const paths = await bridge.dialog.openFile({
      filters: [{ name: '文本/代码', extensions: Array.from(TEXT_EXTENSIONS) }]
    });
    if (!paths || paths.length === 0) return;
    await handleTextFilePaths(paths);
  });

  imagePreviewEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('remove-img')) {
      pendingImages.splice(parseInt((target as HTMLElement).dataset.index!), 1);
      renderImagePreviews();
    }
  });

  filePreviewEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('remove-file')) {
      pendingFiles.splice(parseInt((target as HTMLElement).dataset.index!), 1);
      renderFilePreviews();
    }
  });
}

function autoResizeTextarea(): void {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 120) + 'px';
}

async function handleImagePaths(paths: string[]): Promise<void> {
  const bridge = getBridge();
  const maxSize = 20 * 1024 * 1024;
  for (const filePath of paths) {
    const name = filePath.split(/[/\\]/).pop() || filePath;
    try {
      const result = await bridge.fs.readFile(filePath);
      if (!result.success) {
        appendSystemMessage(`❌ 读取 ${name} 失败: ${result.error}`);
        continue;
      }
      // IPC 返回的 content 是 UTF-8 字符串，转为 base64
      const binary = Uint8Array.from(atob(result.content as string), c => c.charCodeAt(0));
      const base64 = btoa(String.fromCharCode(...binary));
      if (binary.length > maxSize) {
        appendSystemMessage(`⚠️ 图片 ${name} 超过 20MB 限制`);
        continue;
      }
      pendingImages.push({ name, base64 });
      logInfo(`图片已添加: ${name}`, formatSize(binary.length));
    } catch (err) {
      logError('图片读取失败', (err as Error).message);
      appendSystemMessage(`❌ 读取 ${name} 失败`);
    }
  }
  renderImagePreviews();
}

function renderImagePreviews(): void {
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

async function handleTextFilePaths(paths: string[]): Promise<void> {
  const bridge = getBridge();
  for (const filePath of paths) {
    const name = filePath.split(/[/\\]/).pop() || filePath;
    if (!isTextFile(name)) {
      appendSystemMessage(`⚠️ ${name} 不是支持的文本/代码文件`);
      continue;
    }
    try {
      const result = await bridge.fs.readFile(filePath);
      if (!result.success) {
        appendSystemMessage(`❌ 读取 ${name} 失败: ${result.error}`);
        continue;
      }
      const content = result.content as string;
      const size = new TextEncoder().encode(content).length;
      if (size > MAX_FILE_SIZE) {
        appendSystemMessage(`⚠️ ${name} 超过 500KB 限制（${formatSize(size)}）`);
        continue;
      }
      if (pendingFiles.some(f => f.name === name)) {
        appendSystemMessage(`ℹ️ ${name} 已添加`);
        continue;
      }
      pendingFiles.push({ name, content, language: detectLanguage(name), size });
      logInfo(`文件已添加: ${name}`, formatSize(size));
      renderFilePreviews();
    } catch (err) {
      logError('文件读取失败', (err as Error).message);
      appendSystemMessage(`❌ 读取 ${name} 失败`);
    }
  }
}

function renderFilePreviews(): void {
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

function updateSendButton(streaming: boolean): void {
  if (streaming) {
    btnSendEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    btnSendEl.classList.add('stop-btn');
    btnSendEl.classList.remove('disabled');
    btnSendEl.title = '停止生成';
  } else {
    btnSendEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    btnSendEl.classList.remove('stop-btn');
    btnSendEl.classList.remove('disabled');
    btnSendEl.title = '发送';
  }
}

function stopGeneration(): void {
  const abortController = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER);
  if (abortController) abortController.abort();
}

function buildApiMessages(messages: ChatMessage[]): Array<{ role: string; content: string; images?: string[] }> {
  return messages.map(m => {
    let content = m.content || '';
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

export async function sendMessage(): Promise<void> {
  const text = chatInputEl.value.trim();
  if (!text && pendingImages.length === 0 && pendingFiles.length === 0) return;
  if (state.get<boolean>(KEYS.IS_STREAMING)) return;

  const model = getSelectedModel();
  if (!model) {
    appendSystemMessage('⚠️ 请先选择一个模型');
    return;
  }

  logInfo(`发送消息: ${model}`, text ? text.slice(0, 60) + (text.length > 60 ? '...' : '') : '[附件消息]');

  if (pendingImages.length > 0 && !isVisionAvailable()) {
    appendSystemMessage('⚠️ 当前模型不支持图片分析，请移除图片后重试');
    return;
  }

  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  if (!currentSession) return;

  // ── Tool Calling Agent Loop 分支 ──
  const toolCallingEnabled = state.get<boolean>('toolCallingEnabled', false);
  if (toolCallingEnabled) {
    // 检查模型是否支持 Tool Calling
    if (!isToolCallingSupported()) {
      appendSystemMessage('⚠️ 当前模型未声明支持 Tool Calling，Agent Loop 可能不稳定。建议使用 Qwen3、Llama 3.1+ 或 Mistral 等支持工具调用的模型。');
    }
    await sendMessageWithAgentLoop(text, currentSession, model);
    return;
  }

  // ── 原有普通聊天流程 ──

  const now = Date.now();
  const msgsToAdd: ChatMessage[] = [];

  const userFiles: ChatFile[] = pendingFiles.map(f => ({ name: f.name, language: f.language, size: f.size }));

  if (pendingImages.length > 0) {
    msgsToAdd.push({
      role: 'user',
      content: pendingImages.length === 1 ? `[上传了图片: ${pendingImages[0].name}]` : `[上传了 ${pendingImages.length} 张图片]`,
      images: pendingImages.map(img => img.base64),
      timestamp: now
    });
  }

  if (text || pendingFiles.length > 0) {
    const msg: ChatMessage = {
      role: 'user',
      content: text || '',
      timestamp: now
    };
    if (userFiles.length > 0) {
      msg.files = userFiles;
      msg._fileContents = pendingFiles.map(f => ({ language: f.language, content: f.content }));
    }
    msgsToAdd.push(msg);
  }

  const isFirstMsg = currentSession.messages.length === 0;
  state.update(KEYS.CURRENT_SESSION, (session: any) => ({
    ...session,
    ...(isFirstMsg && {
      title: truncate(text || (pendingFiles.length > 0 ? `[文件: ${pendingFiles.map(f => f.name).join(', ')}]` : '[图片消息]'), 30),
      model
    }),
    messages: [...session.messages, ...msgsToAdd],
    updatedAt: Date.now()
  }));

  const freshSession = state.get<ChatSession>(KEYS.CURRENT_SESSION);

  enableAutoScroll();
  renderMessages();
  await saveCurrentSession();

  chatInputEl.value = '';
  pendingImages = [];
  pendingFiles = [];
  imagePreviewEl.style.display = 'none';
  imagePreviewEl.innerHTML = '';
  filePreviewEl.style.display = 'none';
  filePreviewEl.innerHTML = '';
  autoResizeTextarea();

  appendAssistantPlaceholder();

  state.set(KEYS.IS_STREAMING, true);
  updateSendButton(true);

  const api = state.get<OllamaAPI>(KEYS.API)!;
  const abortController = new AbortController();
  state.set(KEYS.ABORT_CONTROLLER, abortController);
  const thinkMode = isThinkEnabled();
  const systemPromptEnabled = state.get<boolean>(KEYS.SYSTEM_PROMPT_ENABLED);
  const systemPrompt = state.get<string>(KEYS.SYSTEM_PROMPT);
  const numCtx = state.get<number>(KEYS.NUM_CTX, 24576);

  let assistantContent = '';
  let thinkContent = '';
  let finalStats: { eval_count?: number; total_duration?: number } | null = null;
  let modelName = '';

  try {
    const apiMessages = buildApiMessages(freshSession.messages);
    const temperature = state.get<number>('temperature', 0.7);

    const chatParams: Record<string, unknown> = {
      model,
      messages: apiMessages,
      stream: true,
      think: thinkMode,
    };
    if (systemPromptEnabled && systemPrompt) chatParams.system = systemPrompt;
    if (numCtx) chatParams.options = { num_ctx: numCtx, temperature };

    // ── Agent 记忆注入 ──
    if (isMemoryEnabled()) {
      const userMessage = text || (msgsToAdd.find(m => m.role === 'user')?.content || '');
      if (userMessage) {
        const relevantMemories = searchMemories(userMessage, 6);
        if (relevantMemories.length > 0) {
          const memoryContext = buildMemoryContext(relevantMemories);
          chatParams.system = chatParams.system
            ? (chatParams.system as string) + '\n\n' + memoryContext
            : memoryContext;
          for (const m of relevantMemories) {
            await markMemoryUsed(m.id);
          }
          appendSystemMessage(`🧠 已注入 ${relevantMemories.length} 条相关记忆`, 'memory-status');
        }
      }
    }

    let ragSources: RagSource[] | null = null;

    if (isRagEnabled()) {
      appendSystemMessage('🧠 正在检索知识库...', 'rag-status');
      try {
        const textForRag = text;
        const ragResult = await performRagRetrieval(textForRag);
        if (ragResult && ragResult.results && ragResult.results.length > 0) {
          const ctxLimit = numCtx || 24576;
          const outputReserve = 2048;
          const msgChars = apiMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
          const systemChars = ((chatParams.system as string)?.length || 0);
          const usedTokens = Math.ceil((msgChars + systemChars) / 2);
          const ragBudget = Math.max(0, ctxLimit - outputReserve - usedTokens);
          const ragBudgetChars = ragBudget * 2;

          let ragContext = ragResult.results.map((r: any, i: number) =>
            `[来源 ${i + 1}: ${r.filename}]\n${r.text}`
          ).join('\n\n---\n\n');

          const ragTemplate = `你是一个知识库问答助手。以下是检索到的相关文档片段，请基于这些内容回答用户的问题。\n\n=== 检索到的相关内容 ===\n${ragContext}\n=== 内容结束 ===`;
          if (ragContext.length + ragTemplate.length > ragBudgetChars) {
            ragContext = ragContext.slice(0, Math.max(0, ragBudgetChars - ragTemplate.length - 50)) + '\n\n[知识库内容过长，已截取最相关的部分]';
            appendSystemMessage(`⚠️ 知识库内容已截取（预算 ${ragBudgetChars} 字符）`, 'rag-status');
          }

          const ragPrompt = `你是一个知识库问答助手。以下是检索到的相关文档片段，请基于这些内容回答用户的问题。如果检索到的内容无法回答问题，请如实说明。\n\n=== 检索到的相关内容 ===\n${ragContext}\n=== 内容结束 ===\n\n请基于以上内容回答用户的问题。引用时请注明来源编号（如"来源 1"）。`;

          chatParams.system = chatParams.system
            ? (chatParams.system as string) + '\n\n' + ragPrompt
            : ragPrompt;

          ragSources = ragResult.results.map((r: any) => ({
            filename: r.filename,
            score: r.score,
            text: truncate(r.text, 100)
          }));
          const sourceNames = [...new Set(ragSources.map(s => s.filename))];
          appendSystemMessage(`🧠 已检索 ${ragSources.length} 个相关片段（来源：${sourceNames.join('、')}）`, 'rag-status');
        } else {
          appendSystemMessage('🧠 知识库未检索到相关内容，使用通用知识回答', 'rag-status');
        }
      } catch (ragErr) {
        logError('RAG 检索失败', (ragErr as Error).message);
        appendSystemMessage(`🧠 知识库检索失败: ${(ragErr as Error).message}`, 'rag-status');
      }
    }

    let ragStatusCleared = false;

    await api.chatStream(chatParams as any, (chunk: OllamaStreamChunk) => {
      if (!ragStatusCleared && chunk.message?.content) {
        ragStatusCleared = true;
        document.querySelectorAll('.rag-status').forEach(el => el.remove());
      }
      if (chunk.message) {
        if (chunk.message.content) assistantContent += chunk.message.content;
        const think = chunk.message.thinking || chunk.message.reasoning_content;
        if (think && typeof think === 'string') thinkContent += think;
      }
      if (chunk.model) modelName = chunk.model;
      // 捕获任何包含统计的 chunk（不限于 done）
      if (chunk.eval_count || chunk.total_duration) {
        finalStats = {
          eval_count: chunk.eval_count ?? finalStats?.eval_count,
          total_duration: chunk.total_duration ?? finalStats?.total_duration,
        };
      }
      updateLastAssistantMessage(assistantContent, thinkContent || null, null, modelName || undefined);
      if (chunk.done) {
        // done chunk 优先使用其统计，保留之前的兜底
        finalStats = {
          eval_count: chunk.eval_count ?? finalStats?.eval_count,
          total_duration: chunk.total_duration ?? finalStats?.total_duration,
        };
      }
    }, abortController);

    if (!assistantContent && !thinkContent) {
      appendSystemMessage('⚠️ 模型未返回任何内容，可能是上下文过长或模型不支持当前请求');
      logWarn('模型未返回任何内容');
    }

    logStream(`流式完成: ${assistantContent.length} 字符${finalStats?.eval_count ? `, ${finalStats.eval_count} tokens` : ''}`);

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: assistantContent || '',
      timestamp: Date.now(),
      ...(modelName && { model: modelName }),
      ...(thinkContent && { think: thinkContent }),
      ...(finalStats && { eval_count: finalStats.eval_count, total_duration: finalStats.total_duration }),
      ...(ragSources && { ragSources })
    };
    state.update(KEYS.CURRENT_SESSION, (session: any) => ({
      ...session,
      messages: [...session.messages, assistantMsg],
      updatedAt: Date.now()
    }));

    if (finalStats) {
      updateLastAssistantMessage(assistantContent, thinkContent || null, finalStats, modelName || undefined);
    }

    if (ragSources && ragSources.length > 0) {
      const lastAssistant = document.querySelector('#messagesContainer .message.assistant:last-of-type');
      if (lastAssistant) {
        const sourcesHtml = ragSources.map((s, i) => {
          const scorePercent = s.score ? `${(s.score * 100).toFixed(0)}%` : '';
          return `<div class="rag-source-item"><span class="rag-source-name">📄 来源 ${i + 1}: ${escapeHtml(s.filename)}</span>${scorePercent ? `<span class="rag-source-score">${scorePercent}</span>` : ''}</div>`;
        }).join('');
        const ragDiv = document.createElement('div');
        ragDiv.className = 'rag-sources';
        ragDiv.innerHTML = `<div class="rag-sources-header">🧠 基于知识库回答</div>${sourcesHtml}`;
        lastAssistant.querySelector('.msg-body')!.appendChild(ragDiv);
      }
    }

    await saveCurrentSession();
    updateTotalTokens();

    // ── 自动提取记忆（非阻塞）──
    if (isMemoryEnabled() && freshSession.messages.length >= 6) {
      const currentSession2 = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
      if (currentSession2) {
        extractMemoriesFromConversation(
          currentSession2.messages.map(m => ({ role: m.role, content: m.content })),
          currentSession2.title
        ).then(count => {
          if (count > 0) {
            logInfo(`自动提取了 ${count} 条记忆`);
          }
        }).catch(err => logError('记忆提取失败', (err as Error).message));
      }
    }
  } catch (err) {
    document.querySelectorAll('.rag-status').forEach(el => el.remove());

    if ((err as Error).name === 'AbortError') {
      const placeholder = document.querySelector('#messagesContainer .message.assistant.loading') as HTMLElement;
      const loadingDots = placeholder?.querySelector('.loading-dots');
      const loadingText = placeholder?.querySelector('.loading-text');
      if (loadingDots) loadingDots.remove();
      if (loadingText) loadingText.remove();
      placeholder?.classList.remove('loading');

      const contentDiv = placeholder?.querySelector('.msg-content');
      const partialMsg: ChatMessage = {
        role: 'assistant',
        content: assistantContent,
        timestamp: Date.now(),
        ...(modelName && { model: modelName }),
        ...(thinkContent && { think: thinkContent }),
        stopped: true
      };
      state.update(KEYS.CURRENT_SESSION, (session: any) => ({
        ...session,
        messages: [...session.messages, partialMsg],
        updatedAt: Date.now()
      }));

      if (contentDiv) {
        let html = assistantContent ? safeMarkdown(assistantContent) : '';
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

    const placeholder = document.querySelector('#messagesContainer .message.assistant.loading') as HTMLElement;
    const loadingDots = placeholder?.querySelector('.loading-dots');
    const loadingText = placeholder?.querySelector('.loading-text');
    if (loadingDots) loadingDots.remove();
    if (loadingText) loadingText.remove();
    placeholder?.classList.remove('loading');

    const contentDiv = placeholder?.querySelector('.msg-content');

    if (assistantContent && contentDiv) {
      state.update(KEYS.CURRENT_SESSION, (session: any) => ({
        ...session,
        messages: [...session.messages, { role: 'assistant', content: assistantContent + '\n\n`[已中断]`', timestamp: Date.now() } as ChatMessage],
        updatedAt: Date.now()
      }));
      contentDiv.innerHTML = safeMarkdown(assistantContent) + '<p><code>[已中断]</code></p>';
      await saveCurrentSession();
    } else {
      if (placeholder) placeholder.remove();
    }

    let errMsg = `❌ 错误: ${(err as Error).message}`;
    if ((err as Error).message.includes('Failed to fetch') || (err as Error).message.includes('NetworkError')) {
      errMsg = '❌ 连接失败。请检查：\n1. Ollama 是否正在运行\n2. 地址是否正确\n3. 是否设置了 OLLAMA_ORIGINS="*"';
      logError('连接失败', 'Ollama 服务不可达');
    } else if ((err as Error).message.includes('400')) {
      errMsg = '❌ 请求参数错误，可能是知识库内容超出模型上下文限制';
      logError('请求参数错误 (400)', (err as Error).message);
    } else if ((err as Error).message.includes('500')) {
      errMsg = '❌ Ollama 服务器错误，请检查 Ollama 日志';
      logError('Ollama 服务器错误 (500)', (err as Error).message);
    } else {
      logError('对话错误', (err as Error).message);
    }
    appendSystemMessage(errMsg);
  } finally {
    state.set(KEYS.IS_STREAMING, false);
    updateSendButton(false);
    state.set(KEYS.ABORT_CONTROLLER, null);
  }
}

async function sendMessageWithAgentLoop(text: string, currentSession: ChatSession, model: string): Promise<void> {
  const now = Date.now();
  const msgsToAdd: ChatMessage[] = [];
  const userFiles: ChatFile[] = pendingFiles.map(f => ({ name: f.name, language: f.language, size: f.size }));
  const images = pendingImages.map(img => img.base64);

  if (pendingImages.length > 0) {
    msgsToAdd.push({
      role: 'user',
      content: pendingImages.length === 1 ? `[上传了图片: ${pendingImages[0].name}]` : `[上传了 ${pendingImages.length} 张图片]`,
      images,
      timestamp: now
    });
  }

  if (text || pendingFiles.length > 0) {
    const msg: ChatMessage = {
      role: 'user',
      content: text || '',
      timestamp: now
    };
    if (userFiles.length > 0) {
      msg.files = userFiles;
      msg._fileContents = pendingFiles.map(f => ({ language: f.language, content: f.content }));
    }
    msgsToAdd.push(msg);
  }

  const isFirstMsg = currentSession.messages.length === 0;
  state.update(KEYS.CURRENT_SESSION, (session: any) => ({
    ...session,
    ...(isFirstMsg && {
      title: truncate(text || (pendingFiles.length > 0 ? `[文件: ${pendingFiles.map(f => f.name).join(', ')}]` : '[图片消息]'), 30),
      model
    }),
    messages: [...session.messages, ...msgsToAdd],
    updatedAt: Date.now()
  }));

  const freshSession = state.get<ChatSession>(KEYS.CURRENT_SESSION);

  enableAutoScroll();
  renderMessages();
  await saveCurrentSession();

  chatInputEl.value = '';
  pendingImages = [];
  pendingFiles = [];
  imagePreviewEl.style.display = 'none';
  imagePreviewEl.innerHTML = '';
  filePreviewEl.style.display = 'none';
  filePreviewEl.innerHTML = '';
  autoResizeTextarea();

  appendAssistantPlaceholder();
  state.set(KEYS.IS_STREAMING, true);
  updateSendButton(true);

  // 构建历史消息
  const historyMessages = freshSession.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map(m => {
      let content = m.content || '';
      if (m._fileContents && m._fileContents.length > 0) {
        const fileParts = m._fileContents.map(f => `📄 文件：\n\`\`\`${f.language}\n${f.content}\n\`\`\``);
        content = content ? content + '\n\n---\n' + fileParts.join('\n\n---\n') : fileParts.join('\n\n---\n');
      }
      return {
        role: m.role,
        content,
        ...(m.images?.length && { images: m.images })
      };
    });

  let assistantContent = '';
  let thinkContent = '';

  try {
    await runAgentLoop(text || (pendingFiles.length > 0 ? `请分析 ${pendingFiles.map(f => f.name).join(', ')}` : ''), images, historyMessages, {
      onThinking: (thinking) => {
        thinkContent = thinking;
        updateLastAssistantMessage(assistantContent, thinkContent || null, null);
      },
      onContent: (content) => {
        assistantContent = content;
        updateLastAssistantMessage(assistantContent, thinkContent || null, null);
      },
      onToolCallStart: (_call) => {
        // 实时更新已由 agent-engine 的 callbacks 处理
      },
      onToolCallResult: (_name, _result, _call) => {
        // 工具结果实时更新
      },
      onToolCallError: (_name, _error, _call) => {
        // 工具错误实时更新
      },
      onConfirmTool: async (call) => {
        return showToolConfirm(call);
      },
      onDone: async (finalContent, toolRecords, loopStats) => {
        assistantContent = finalContent;

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: assistantContent || '',
          timestamp: Date.now(),
          ...(thinkContent && { think: thinkContent }),
          ...(toolRecords?.length && { toolCalls: toolRecords }),
          ...(loopStats?.eval_count && { eval_count: loopStats.eval_count }),
          ...(loopStats?.total_duration && { total_duration: loopStats.total_duration }),
        };
        state.update(KEYS.CURRENT_SESSION, (session: any) => ({
          ...session,
          messages: [...session.messages, assistantMsg],
          updatedAt: Date.now()
        }));

        updateLastAssistantMessage(assistantContent, thinkContent || null, loopStats || null);
        renderMessages();
        await saveCurrentSession();
        updateTotalTokens();
      }
    });
  } catch (err) {
    logError('Agent Loop 错误', (err as Error).message);

    if ((err as Error).name === 'AbortError') {
      const placeholder = document.querySelector('#messagesContainer .message.assistant.loading') as HTMLElement;
      if (placeholder) {
        placeholder.classList.remove('loading');
        placeholder.querySelector('.loading-dots')?.remove();
        placeholder.querySelector('.loading-text')?.remove();
        const contentDiv = placeholder.querySelector('.msg-content');
        if (contentDiv) {
          let html = assistantContent ? safeMarkdown(assistantContent) : '';
          html += '<p><code>[已停止]</code></p>';
          contentDiv.innerHTML = html;
        }
      }
      const partialMsg: ChatMessage = {
        role: 'assistant',
        content: assistantContent,
        timestamp: Date.now(),
        ...(thinkContent && { think: thinkContent }),
        stopped: true
      };
      state.update(KEYS.CURRENT_SESSION, (session: any) => ({
        ...session,
        messages: [...session.messages, partialMsg],
        updatedAt: Date.now()
      }));
      appendSystemMessage('⏹ 已停止生成');
      await saveCurrentSession();
    } else {
      const placeholder = document.querySelector('#messagesContainer .message.assistant.loading') as HTMLElement;
      if (placeholder) {
        placeholder.classList.remove('loading');
        placeholder.querySelector('.loading-dots')?.remove();
        placeholder.querySelector('.loading-text')?.remove();
        if (!assistantContent) placeholder.remove();
        else {
          const contentDiv = placeholder.querySelector('.msg-content');
          if (contentDiv) contentDiv.innerHTML = safeMarkdown(assistantContent) + '<p><code>[已中断]</code></p>';
        }
      }

      let errMsg = `❌ 错误: ${(err as Error).message}`;
      if ((err as Error).message.includes('Failed to fetch') || (err as Error).message.includes('NetworkError')) {
        errMsg = '❌ 连接失败。请检查 Ollama 是否正在运行';
      }
      appendSystemMessage(errMsg);
    }
  } finally {
    state.set(KEYS.IS_STREAMING, false);
    updateSendButton(false);
    state.set(KEYS.ABORT_CONTROLLER, null);
  }
}

async function saveCurrentSession(): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  const isHistoryView = state.get<boolean>(KEYS.IS_HISTORY_VIEW);
  if (!currentSession || !db || isHistoryView) return;
  currentSession.updatedAt = Date.now();
  try {
    await db.saveSession(currentSession);
  } catch (err) {
    logError('保存会话失败', (err as Error).message);
  }
}
