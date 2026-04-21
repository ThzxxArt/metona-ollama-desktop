/**
 * InputArea - 输入区域组件
 */

import { state, KEYS } from '../state/state.js';
import type { MetonaDesktopAPI } from '../types.js';
import { detectLanguage, truncate, escapeHtml, formatSize } from '../utils/utils.js';
import { getSelectedModel, isThinkEnabled, isVisionAvailable, isToolCallingSupported } from './model-bar.js';
import {
  renderMessages, clearMessagesDOM, appendAssistantPlaceholder, appendSystemMessage,
  updateLastAssistantMessage, clearMessages, safeMarkdown, enableAutoScroll, updateTotalTokens,
  appendToolCallCardToPlaceholder, updateToolCallCardInPlaceholder
} from './chat-area.js';
import { showToast } from './toast.js';
import { addToolCard, updateToolCard, clearToolCardsExternal, clearTerminalExternal } from './workspace-panel.js';
import { ChatDB } from '../db/chat-db.js';
import { OllamaAPI } from '../api/ollama.js';
import { runAgentLoop } from '../services/agent-engine.js';
import { searchMemories, buildMemoryContext, markMemoryUsed, extractMemoriesFromConversation, isMemoryEnabled } from '../services/memory-manager.js';
import { showToolConfirm } from './tool-confirm-modal.js';
import { logInfo, logStream, logError, logSuccess, logWarn } from '../services/log-service.js';
import type { ChatSession, ChatMessage, OllamaStreamChunk, FileContent, ChatFile, ToolCallRecord } from '../types.js';

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

function getBridge(): MetonaDesktopAPI | undefined {
  return window.metonaDesktop;
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
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
      properties: ['openFile'],
      multiple: false
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
      const result = await bridge.fs.readFileBase64(filePath);
      if (!result.success) {
        appendSystemMessage(`❌ 读取 ${name} 失败: ${result.error}`);
        continue;
      }
      const size = result.size ?? 0;
      if (size > maxSize) {
        appendSystemMessage(`⚠️ 图片 ${name} 超过 20MB 限制`);
        continue;
      }
      const base64 = result.content!;
      pendingImages.push({ name, base64 });
      logInfo(`图片已添加: ${name}`, formatSize(size));
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

// ══════════════════════════════════════════════
// v4.1 会话管理命令：/retry, /undo, /compress
// ══════════════════════════════════════════════

async function handleRetry(): Promise<void> {
  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  if (!currentSession || currentSession.messages.length < 2) {
    showToast('没有可重试的消息', 'warning');
    return;
  }
  if (state.get<boolean>(KEYS.IS_STREAMING)) {
    showToast('请先停止当前生成', 'warning');
    return;
  }

  // 找到最后一条 user 消息
  let lastUserIdx = -1;
  for (let i = currentSession.messages.length - 1; i >= 0; i--) {
    if (currentSession.messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) { showToast('没有找到用户消息', 'warning'); return; }

  // 删除该 user 消息之后的所有消息（assistant 回复 + 可能的 tool 调用链）
  const removedCount = currentSession.messages.length - lastUserIdx - 1;
  const userMsg = currentSession.messages[lastUserIdx];
  currentSession.messages = currentSession.messages.slice(0, lastUserIdx + 1);

  logInfo(`重试: 删除了 ${removedCount} 条消息，重新发送`);

  const db = state.get<ChatDB | null>(KEYS.DB);
  if (db) await db.saveSession(currentSession);

  clearMessagesDOM();
  renderMessages();

  // 重新触发 Agent Loop / 普通聊天
  const toolCallingEnabled = state.get<boolean>('toolCallingEnabled', false);
  const model = getSelectedModel() || currentSession.model;

  // 新一轮开始：清理上一轮的工作空间状态
  if (toolCallingEnabled) {
    clearToolCardsExternal();
    clearTerminalExternal();
  }

  appendAssistantPlaceholder();
  state.set(KEYS.IS_STREAMING, true);
  updateSendButton(true);

  if (toolCallingEnabled) {
    const historyMessages = currentSession.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1) // 不包含刚保留的最后一条 user 消息
      .slice(-20)
      .map(m => {
        let content = m.content || '';
        if (m._fileContents?.length) {
          const fileParts = m._fileContents.map(f => `📄 文件：\n\`\`\`${f.language}\n${f.content}\n\`\`\``);
          content = content ? content + '\n\n---\n' + fileParts.join('\n\n---\n') : fileParts.join('\n\n---\n');
        }
        return { role: m.role, content, ...(m.images?.length && { images: m.images }) };
      });

    try {
      let retryContent = '';
      let retryThinkContent = '';
      let retryIterations = 0;
      await runAgentLoop(userMsg.content || '', userMsg.images || [], historyMessages, {
        onNewIteration: () => {
          if (retryContent) {
            const prevMsg: ChatMessage = {
              role: 'assistant', content: retryContent, timestamp: Date.now(),
              ...(retryThinkContent && { think: retryThinkContent }),
            };
            state.update(KEYS.CURRENT_SESSION, (s: ChatSession | null) => ({
              ...s, messages: [...s.messages, prevMsg], updatedAt: Date.now()
            }));
            renderMessages();
          }
          appendAssistantPlaceholder();
          retryContent = '';
          retryThinkContent = '';
          retryIterations++;
        },
        onThinking: (thinking) => { retryThinkContent = thinking; updateLastAssistantMessage(retryContent, thinking, null); },
        onContent: (content) => { retryContent = content; updateLastAssistantMessage(content, retryThinkContent || null, null); },
        onToolCallStart: (call) => {
          addToolCard({
            name: call.function.name, arguments: call.function.arguments,
            result: null, status: 'running', timestamp: Date.now()
          });
        },
        onToolCallResult: (name, result, call) => {
          updateToolCard({
            name, arguments: call.function.arguments,
            result, status: result.success ? 'success' : 'error', timestamp: Date.now()
          });
        },
        onToolCallError: (name, error, call) => {
          updateToolCard({
            name, arguments: call.function.arguments,
            result: { success: false, error }, status: 'error', timestamp: Date.now()
          });
        },
        onConfirmTool: async (call) => showToolConfirm(call),
        onDone: async (finalContent, toolRecords, loopStats) => {
          retryContent = finalContent;
          if (retryIterations > 0) {
            updateLastAssistantMessage(finalContent, retryThinkContent || null, loopStats || null);
            state.update(KEYS.CURRENT_SESSION, (s: ChatSession | null) => {
              const msgs = [...s.messages];
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant') {
                  if (toolRecords?.length) msgs[i] = { ...msgs[i], toolCalls: toolRecords };
                  if (loopStats?.eval_count) msgs[i] = { ...msgs[i], eval_count: loopStats.eval_count };
                  if (loopStats?.total_duration) msgs[i] = { ...msgs[i], total_duration: loopStats.total_duration };
                  break;
                }
              }
              return { ...s, messages: msgs, updatedAt: Date.now() };
            });
          } else {
            const assistantMsg: ChatMessage = {
              role: 'assistant', content: finalContent || '', timestamp: Date.now(),
              ...(retryThinkContent && { think: retryThinkContent }),
              ...(toolRecords?.length && { toolCalls: toolRecords }),
              ...(loopStats?.eval_count && { eval_count: loopStats.eval_count }),
              ...(loopStats?.total_duration && { total_duration: loopStats.total_duration }),
            };
            state.update(KEYS.CURRENT_SESSION, (s: ChatSession | null) => ({
              ...s, messages: [...s.messages, assistantMsg], updatedAt: Date.now()
            }));
            updateLastAssistantMessage(finalContent, retryThinkContent || null, loopStats || null);
          }
          renderMessages();
          await saveCurrentSession();
          updateTotalTokens();
        }
      });
    } catch (err) {
      logError('重试失败', (err as Error).message);
      appendSystemMessage(`❌ 重试失败: ${(err as Error).message}`);
    }
  } else {
    // 普通聊天模式重试 - 直接调用 sendMessage
    chatInputEl.value = userMsg.content || '';
    state.set(KEYS.IS_STREAMING, false);
    updateSendButton(false);
    await sendMessage();
    return;
  }

  state.set(KEYS.IS_STREAMING, false);
  updateSendButton(false);
}

async function handleUndo(): Promise<void> {
  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  if (!currentSession || currentSession.messages.length < 2) {
    showToast('没有可撤销的消息', 'warning');
    return;
  }
  if (state.get<boolean>(KEYS.IS_STREAMING)) {
    showToast('请先停止当前生成', 'warning');
    return;
  }

  // 从末尾删除：先删 assistant（含可能的 tool 消息），再删 user
  const msgs = currentSession.messages;
  let removeEnd = msgs.length;
  let removeStart = msgs.length - 1;

  // 找到最后一条 user 消息的位置
  while (removeStart >= 0 && msgs[removeStart].role !== 'user') {
    removeStart--;
  }
  if (removeStart < 0) { showToast('没有找到用户消息', 'warning'); return; }

  // 删除 user 消息及之后的所有消息
  const removedCount = removeEnd - removeStart;
  currentSession.messages = msgs.slice(0, removeStart);

  logInfo(`撤销: 删除了 ${removedCount} 条消息`);

  const db = state.get<ChatDB | null>(KEYS.DB);
  if (db) await db.saveSession(currentSession);

  clearMessagesDOM();
  renderMessages();
  updateTotalTokens();
  showToast('已撤销上一轮对话', 'success');
}

async function handleCompress(): Promise<void> {
  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  if (!currentSession || currentSession.messages.length < 6) {
    showToast('消息太少，无需压缩', 'warning');
    return;
  }
  if (state.get<boolean>(KEYS.IS_STREAMING)) {
    showToast('请先停止当前生成', 'warning');
    return;
  }

  const api = state.get<OllamaAPI>(KEYS.API);
  const model = getSelectedModel() || currentSession.model;
  if (!api || !model) {
    showToast('请先选择模型', 'warning');
    return;
  }

  logInfo('上下文压缩: 开始');

  // 取中间的消息做摘要（保留首尾各 2 条）
  const messages = currentSession.messages;
  const keepStart = 2;
  const keepEnd = 2;
  const head = messages.slice(0, keepStart);
  const tail = messages.slice(-keepEnd);
  const middle = messages.slice(keepStart, messages.length - keepEnd);

  const conversationText = middle.map(m => {
    const role = m.role === 'user' ? '用户' : 'AI';
    let content = m.content || '';
    // 截断过长内容
    if (content.length > 500) content = content.slice(0, 500) + '...';
    if (m.toolCalls?.length) content += ` [工具调用: ${m.toolCalls.map(t => t.name).join(', ')}]`;
    return `${role}: ${content}`;
  }).join('\n');

  showToast('正在压缩上下文...', 'info');

  try {
    let summary = '';
    await api.chatStream({
      model,
      messages: [{
        role: 'user',
        content: `请将以下对话摘要为一段简洁的上下文总结。保留关键信息：讨论的主题、得出的结论、用户的偏好、未完成的任务。用中文输出，不超过 500 字。\n\n对话记录：\n${conversationText}`
      }],
      stream: true,
      think: false,
      options: { num_ctx: 8192, temperature: 0.3 }
    } as any, (chunk: OllamaStreamChunk) => {
      if (chunk.message?.content) {
        summary += chunk.message.content;
      }
    });

    if (!summary.trim()) {
      showToast('压缩失败：模型未返回内容', 'error');
      return;
    }

    // 构建压缩后的消息列表
    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `📋 以下是对之前对话的摘要（已压缩 ${middle.length} 条消息）：\n\n${summary}`,
      timestamp: Date.now()
    };

    currentSession.messages = [...head, summaryMsg, ...tail];

    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) await db.saveSession(currentSession);

    clearMessagesDOM();
    renderMessages();
    updateTotalTokens();

    logInfo(`上下文压缩完成: ${middle.length} 条 → 1 条摘要`);
    showToast(`已压缩 ${middle.length} 条消息为摘要`, 'success');
  } catch (err) {
    logError('上下文压缩失败', (err as Error).message);
    showToast(`压缩失败: ${(err as Error).message}`, 'error');
  }
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

  // ── v4.1 会话管理命令 ──
  if (text === '/retry') {
    chatInputEl.value = '';
    await handleRetry();
    return;
  }
  if (text === '/undo') {
    chatInputEl.value = '';
    await handleUndo();
    return;
  }
  if (text === '/compress') {
    chatInputEl.value = '';
    await handleCompress();
    return;
  }

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
  state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => ({
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
    if (numCtx) chatParams.options = { num_ctx: numCtx, temperature };

    // ── Agent 记忆注入 ──
    if (isMemoryEnabled()) {
      const userMessage = text || (msgsToAdd.find(m => m.role === 'user')?.content || '');
      if (userMessage) {
        const relevantMemories = searchMemories(userMessage, 6);
        if (relevantMemories.length > 0) {
          const memoryContext = buildMemoryContext(relevantMemories);
          chatParams.system = memoryContext;
          for (const m of relevantMemories) {
            await markMemoryUsed(m.id);
          }
          appendSystemMessage(`🧠 已注入 ${relevantMemories.length} 条相关记忆`, 'memory-status');
        }
      }
    }

    await api.chatStream(chatParams as any, (chunk: OllamaStreamChunk) => {
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
      ...(finalStats && { eval_count: finalStats.eval_count, total_duration: finalStats.total_duration })
    };
    state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => ({
      ...session,
      messages: [...session.messages, assistantMsg],
      updatedAt: Date.now()
    }));

    if (finalStats) {
      updateLastAssistantMessage(assistantContent, thinkContent || null, finalStats, modelName || undefined);
    }

    await saveCurrentSession();
    updateTotalTokens();

    // ── 自动提取记忆（非阻塞）──
    if (isMemoryEnabled() && freshSession.messages.length >= 10) {
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
      state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => ({
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
      state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => ({
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
      errMsg = '❌ 请求参数错误，可能是上下文过长';
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
    const imgDesc = pendingImages.length === 1 ? `[上传了图片: ${pendingImages[0].name}]` : `[上传了 ${pendingImages.length} 张图片]`;
    const msg: ChatMessage = {
      role: 'user',
      content: text ? `${text}\n\n${imgDesc}` : imgDesc,
      images,
      timestamp: now
    };
    if (userFiles.length > 0) {
      msg.files = userFiles;
      msg._fileContents = pendingFiles.map(f => ({ language: f.language, content: f.content }));
    }
    msgsToAdd.push(msg);
  } else if (text || pendingFiles.length > 0) {
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
  state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => ({
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

  // 新一轮开始：清理上一轮的工作空间状态
  clearToolCardsExternal();
  clearTerminalExternal();

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
  let agentModeIterations = 0; // 跟踪 onNewIteration 调用次数
  state.set('_currentEvalCount', 0); // 重置累计 token 计数，防止跨会话残留
  let lastIterationEvalCount = 0; // 上一轮迭代结束时的累计 token 数
  let lastIterationStartTime = Date.now(); // 当前迭代开始时间

  try {
    await runAgentLoop(text || (pendingFiles.length > 0 ? `请分析 ${pendingFiles.map(f => f.name).join(', ')}` : ''), images, historyMessages, {
      onNewIteration: () => {
        // Agent Loop 新迭代开始：保存上一轮内容为独立消息，创建新 placeholder
        // 先移除旧 placeholder（防止被 renderMessages 当作已渲染消息计数）
        const oldPlaceholder = document.querySelector('#messagesContainer .message.assistant.loading') as HTMLElement;
        if (oldPlaceholder) oldPlaceholder.remove();

        if (assistantContent) {
          const now = Date.now();
          // 计算本轮迭代的 token 和时长
          const currentEvalCount = state.get<number>('_currentEvalCount', 0);
          const iterationEvalCount = Math.max(0, currentEvalCount - lastIterationEvalCount);
          const iterationDuration = (now - lastIterationStartTime) * 1e6;

          const prevMsg: ChatMessage = {
            role: 'assistant',
            content: assistantContent,
            timestamp: now,
            ...(thinkContent && { think: thinkContent }),
            ...(iterationEvalCount > 0 && { eval_count: iterationEvalCount }),
            ...(iterationDuration > 0 && { total_duration: iterationDuration }),
          };
          state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => ({
            ...session,
            messages: [...session.messages, prevMsg],
            updatedAt: Date.now()
          }));
          renderMessages();

          lastIterationEvalCount = currentEvalCount;
          lastIterationStartTime = Date.now();
        }
        // 创建新 placeholder，重置内容
        appendAssistantPlaceholder();
        assistantContent = '';
        thinkContent = '';
        agentModeIterations++;
      },
      onThinking: (thinking) => {
        thinkContent = thinking;
        updateLastAssistantMessage(assistantContent, thinkContent || null, null);
      },
      onContent: (content) => {
        assistantContent = content;
        updateLastAssistantMessage(assistantContent, thinkContent || null, null);
      },
      onToolCallStart: (call) => {
        addToolCard({
          name: call.function.name, arguments: call.function.arguments,
          result: null, status: 'running', timestamp: Date.now()
        });
      },
      onToolCallResult: (name, result, call) => {
        updateToolCard({
          name, arguments: call.function.arguments,
          result, status: result.success ? 'success' : 'error', timestamp: Date.now()
        });
      },
      onToolCallError: (name, error, call) => {
        updateToolCard({
          name, arguments: call.function.arguments,
          result: { success: false, error }, status: 'error', timestamp: Date.now()
        });
      },
      onConfirmTool: async (call) => {
        return showToolConfirm(call);
      },
      onDone: async (finalContent, toolRecords, loopStats) => {
        assistantContent = finalContent;

        // 如果有多个迭代，最后一条消息已由 onNewIteration 保存，这里只更新 placeholder
        if (agentModeIterations > 0) {
          // 最后一轮迭代的 per-iteration stats（保证每条消息统计一致，不重复计数）
          const finalEvalCount = loopStats?.eval_count || 0;
          const lastIterTokens = Math.max(0, finalEvalCount - lastIterationEvalCount);
          const lastIterDuration = (Date.now() - lastIterationStartTime) * 1e6;
          const perIterStats = {
            eval_count: lastIterTokens > 0 ? lastIterTokens : undefined,
            total_duration: lastIterDuration > 0 ? lastIterDuration : undefined,
          };

          updateLastAssistantMessage(assistantContent, thinkContent || null, perIterStats);
          // 更新最后一条消息的工具记录和 per-iteration stats（onNewIteration 保存时没有 toolCalls）
          state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => {
            const msgs = [...session.messages];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant') {
                if (toolRecords?.length) msgs[i] = { ...msgs[i], toolCalls: toolRecords };
                if (lastIterTokens > 0) msgs[i] = { ...msgs[i], eval_count: lastIterTokens };
                if (lastIterDuration > 0) msgs[i] = { ...msgs[i], total_duration: lastIterDuration };
                break;
              }
            }
            return { ...session, messages: msgs, updatedAt: Date.now() };
          });
        } else {
          // 单迭代模式：正常保存
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: assistantContent || '',
            timestamp: Date.now(),
            ...(thinkContent && { think: thinkContent }),
            ...(toolRecords?.length && { toolCalls: toolRecords }),
            ...(loopStats?.eval_count && { eval_count: loopStats.eval_count }),
            ...(loopStats?.total_duration && { total_duration: loopStats.total_duration }),
          };
          state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => ({
            ...session,
            messages: [...session.messages, assistantMsg],
            updatedAt: Date.now()
          }));
          updateLastAssistantMessage(assistantContent, thinkContent || null, loopStats || null);
        }
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
      // 获取中止时已执行的工具记录
      const abortToolRecords = state.get<ToolCallRecord[] | null>('_abortToolRecords', null);
      if (abortToolRecords) state.set('_abortToolRecords', null);

      const partialMsg: ChatMessage = {
        role: 'assistant',
        content: assistantContent,
        timestamp: Date.now(),
        ...(thinkContent && { think: thinkContent }),
        ...(abortToolRecords?.length && { toolCalls: abortToolRecords }),
        stopped: true
      };
      state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => ({
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
