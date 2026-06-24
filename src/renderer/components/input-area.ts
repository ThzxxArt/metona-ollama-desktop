/**
 * InputArea - 输入区域组件
 */

import { state, KEYS } from '../state/state.js';
import type { MetonaDesktopAPI } from '../types.js';
import { detectLanguage, truncate, escapeHtml, formatSize } from '../utils/utils.js';
import { getSelectedModel, isThinkEnabled, isVisionAvailable, isToolCallingSupported } from './model-bar.js';
import {
  renderMessages, clearMessagesDOM, appendAssistantPlaceholder, appendSystemMessage,
  updateLastAssistantMessage, clearMessages, safeMarkdown, enableAutoScroll, resetAutoScroll,
  appendToolCallCardToPlaceholder, updateToolCallCardInPlaceholder, resetCurrentPlaceholder
} from './chat-area.js';
import { showToast } from './toast.js';
import { addToolCard, startToolCard, updateToolCard, clearToolCardsExternal, clearTerminalExternal, getWorkspaceDirPath, hasActiveCards, showWorkingHint, clearWorkingHint } from './workspace-panel.js';
import { ChatDB } from '../db/chat-db.js';
import { OllamaAPI } from '../api/ollama.js';
import { runAgentLoop } from '../services/agent-engine.js';
import { estimateTokens } from '../services/context-manager.js';
import { searchMemories, buildMemoryContext, markMemoryUsed, extractMemoriesFromConversation, isMemoryEnabled } from '../services/memory-manager.js';
import { showToolConfirm } from './tool-confirm-modal.js';
import { logInfo, logStream, logError, logSuccess, logWarn, resetVideoProgress, updateVideoProgress } from '../services/log-service.js';
import type { ChatSession, ChatMessage, OllamaStreamChunk, FileContent, ChatFile, ToolCallRecord, AgentMode } from '../types.js';

let chatInputEl: HTMLTextAreaElement;
let btnSendEl: HTMLButtonElement;
let imagePreviewEl: HTMLElement;
let filePreviewEl: HTMLElement;
let videoPreviewEl: HTMLElement;
let planToggleCheckbox: HTMLInputElement;
let pendingImages: Array<{ name: string; base64: string }> = [];
let pendingFiles: Array<{ name: string; content: string; language: string; size: number }> = [];
let pendingVideoFrames: Array<{ name: string; base64: string; timestampSeconds: number }> = [];
let pendingVideoMeta: { fileName: string; duration: number; width: number; height: number } | null = null;
let completedVideos: Array<{ fileName: string; duration: number; frames: Array<{ name: string; base64: string; timestampSeconds: number }> }> = [];

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

const VIDEO_EXTENSIONS = new Set(['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v']);

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
  videoPreviewEl = document.querySelector('#videoPreview')!;

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

  // ── 视频上传：提取帧作为图片 ──
  document.querySelector('#btnAttachVideo')!.addEventListener('click', async () => {
    if (!isVisionAvailable()) {
      showToast('当前模型不支持图片/视频分析', 'warning');
      return;
    }
    const bridge = getBridge();
    if (!bridge) return;
    const paths = await bridge.dialog.openFile({
      filters: [{ name: '视频', extensions: Array.from(VIDEO_EXTENSIONS) }]
    });
    if (!paths || paths.length === 0) return;
    for (const p of paths) {
      await handleVideoPath(p);
    }
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

  // ── Plan Mode 切换 ──
  const planToggleEl = document.querySelector('#togglePlan') as HTMLInputElement;
  if (planToggleEl) {
    planToggleCheckbox = planToggleEl;
    planToggleEl.addEventListener('change', () => {
      const mode: AgentMode = planToggleEl.checked ? 'plan' : 'auto';
      state.set('agentMode', mode);
      // Plan Mode 切换时注册/移除 plan_track 工具
      import('../services/tool-registry.js').then(({ setPlanModeActive }) => {
        setPlanModeActive(mode === 'plan');
      });
      logInfo(`Agent 模式切换: ${mode === 'plan' ? 'Plan（先规划后执行）' : 'Auto（直接执行）'}`);
    });
  }
}

function autoResizeTextarea(): void {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 120) + 'px';
}

// ── 图片压缩管线 ──
const IMG_MAX_WIDTH = 1280;
const IMG_MAX_HEIGHT = 1280;
const IMG_QUALITY = 0.8;
const IMG_MAX_SIZE_BEFORE_COMPRESS = 300 * 1024; // 300KB以下不压缩

/**
 * Canvas 前端压缩图片：等比缩放 + JPEG 转换
 * base64 → Image → Canvas 缩放绘制 → toBlob → 压缩后 base64
 */
function compressImage(base64: string): Promise<{ compressed: string; origBytes: number; newBytes: number }> {
  return new Promise((resolve, reject) => {
    // 先计算原始 base64 的大小（字节数 ≈ base64长度 * 0.75）
    const origBytes = Math.ceil(base64.length * 0.75);
    // 小图跳过压缩
    if (origBytes <= IMG_MAX_SIZE_BEFORE_COMPRESS) {
      resolve({ compressed: base64, origBytes, newBytes: origBytes });
      return;
    }

    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      // 等比缩放
      if (width > IMG_MAX_WIDTH || height > IMG_MAX_HEIGHT) {
        const ratio = Math.min(IMG_MAX_WIDTH / width, IMG_MAX_HEIGHT / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (!blob) { resolve({ compressed: base64, origBytes, newBytes: origBytes }); return; }
        const reader = new FileReader();
        let newBytes = 0;
        reader.onloadend = () => {
          const compressed = (reader.result as string).split(',')[1] || base64;
          newBytes = blob.size;
          resolve({ compressed, origBytes, newBytes });
        };
        reader.onerror = () => { resolve({ compressed: base64, origBytes, newBytes: origBytes }); };
        reader.readAsDataURL(blob);
      }, 'image/jpeg', IMG_QUALITY);
    };
    img.onerror = () => resolve({ compressed: base64, origBytes, newBytes: origBytes });
    img.src = `data:image/png;base64,${base64}`;
  });
}

async function handleImagePaths(paths: string[]): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  const maxSize = 20 * 1024 * 1024;

  // 并行读取所有图片
  const results = await Promise.all(paths.map(async (filePath) => {
    const name = filePath.split(/[/\\]/).pop() || filePath;
    try {
      const result = await bridge.fs.readFileBase64(filePath);
      if (!result.success) return { name, error: result.error };
      const size = result.size ?? 0;
      if (size > maxSize) return { name, error: `超过 20MB 限制` };
      return { name, base64: result.content!, size };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  }));

  for (const r of results) {
    if ('error' in r && r.error) {
      appendSystemMessage(`❌ 读取 ${r.name} 失败: ${r.error}`);
      continue;
    }
    if ('base64' in r) {
      const imgResult = r as { name: string; base64: string; size: number };
      const { compressed, origBytes, newBytes } = await compressImage(imgResult.base64);
      pendingImages.push({ name: imgResult.name, base64: compressed });
      if (origBytes !== newBytes) {
        logInfo(`图片已压缩: ${r.name}`, `${formatSize(origBytes)} → ${formatSize(newBytes)} (${Math.round((1 - newBytes / origBytes) * 100)}%)`);
      } else {
        logInfo(`图片已添加: ${r.name}`, formatSize(origBytes));
      }
    }
  }
  renderImagePreviews();
}

async function handleVideoPath(filePath: string): Promise<void> {
  const bridge = getBridge();
  if (!bridge?.video) {
    showToast('视频功能需要桌面版', 'warning');
    return;
  }

  const name = filePath.split(/[/\\]/).pop() || filePath;

  // 聊天区：开始消息（带 class 标记，后续原地更新进度）
  logInfo('🎬 正在提取视频帧', name);
  appendSystemMessage(`🎬 正在提取视频帧 (1fps): ${name}...`, 'sysmsg-video-progress');
  pendingVideoMeta = { fileName: name, duration: 0, width: 0, height: 0 };
  renderVideoPreview();
  resetVideoProgress(name);

  // 监听提取进度：实时更新日志条目 + 视频芯片 + 聊天区系统消息
  let progressEl: HTMLElement | null = null;
  bridge.video.onProgress(({ current }) => {
    updateVideoProgress(current);
    if (!progressEl) progressEl = videoPreviewEl.querySelector('.video-meta');
    if (progressEl) progressEl.textContent = `提取中 · ${current}帧`;
    // 聊天区系统消息原地更新
    const sysMsg = document.querySelector('.sysmsg-video-progress');
    if (sysMsg) sysMsg.textContent = `🎬 正在提取视频帧 (1fps): ${name}...  ${current} 帧`;
  });

  try {
    const result = await bridge.video.extractFrames(filePath, { maxFrames: 600, maxWidth: 512 });
    bridge.video.removeProgressListener();

    if (!result.success) {
      const sysMsg = document.querySelector('.sysmsg-video-progress');
      if (sysMsg) { sysMsg.classList.remove('sysmsg-video-progress'); sysMsg.textContent = `❌ 视频帧提取失败: ${result.error || ''}`; }
      pendingVideoFrames = [];
      pendingVideoMeta = null;
      renderVideoPreview();
      logError('视频帧提取失败', result.error || '');
      return;
    }

    const frameCount = result.frames!.length;
    const duration = result.videoInfo!.duration;

    // 移入 completedVideos，清除 pending 状态（避免预览重复）
    completedVideos.push({ fileName: name, duration, frames: [...result.frames!] });
    pendingVideoFrames = [];
    pendingVideoMeta = null;

    // 完成：聊天区系统消息原地更新为完成
    const sysMsg = document.querySelector('.sysmsg-video-progress');
    if (sysMsg) {
      sysMsg.classList.remove('sysmsg-video-progress');
      sysMsg.textContent = `✅ ${name}: 已提取 ${frameCount} 帧 (1fps 采样)`;
    }
    logSuccess('✅ 视频帧提取完成', `${frameCount} 帧 / ${duration.toFixed(1)}s (1fps)`);
    renderVideoPreview();
  } catch (err) {
    bridge.video.removeProgressListener();
    const sysMsg = document.querySelector('.sysmsg-video-progress');
    if (sysMsg) { sysMsg.classList.remove('sysmsg-video-progress'); sysMsg.textContent = `❌ 视频处理失败: ${(err as Error).message}`; }
    pendingVideoFrames = [];
    pendingVideoMeta = null;
    renderVideoPreview();
    logError('视频帧提取失败', (err as Error).message);
  }
}

function renderVideoPreview(): void {
  const all: Array<{ fileName: string; frameCount: number; duration: number; isPending: boolean }> = [];
  if (pendingVideoMeta) {
    all.push({ fileName: pendingVideoMeta.fileName, frameCount: pendingVideoFrames.length, duration: pendingVideoMeta.duration, isPending: true });
  }
  for (const v of completedVideos) {
    all.push({ fileName: v.fileName, frameCount: v.frames.length, duration: v.duration, isPending: false });
  }

  if (all.length === 0) {
    videoPreviewEl.style.display = 'none';
    videoPreviewEl.innerHTML = '';
    return;
  }
  videoPreviewEl.style.display = '';
  videoPreviewEl.innerHTML = all.map((v, i) => {
    const meta = v.isPending && v.duration <= 0 ? '提取中...' : `${v.frameCount}帧 · ${v.duration.toFixed(0)}s`;
    return `
    <div class="video-chip">
      <span class="video-icon">🎬</span>
      <span class="video-name">${escapeHtml(v.fileName)}</span>
      <span class="video-meta">${meta}</span>
      <button class="remove-video" data-idx="${i}">×</button>
    </div>`;
  }).join('');
  videoPreviewEl.querySelectorAll('.remove-video').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt((e.target as HTMLElement).dataset.idx!);
      // 从 all 数组反查是 pending 还是 completed
      if (idx === 0 && pendingVideoMeta) {
        pendingVideoFrames = [];
        pendingVideoMeta = null;
      } else {
        const completedIdx = pendingVideoMeta ? idx - 1 : idx;
        completedVideos.splice(completedIdx, 1);
      }
      renderVideoPreview();
    });
  });
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
  if (!bridge) return;

  // 并行读取所有文件
  const results = await Promise.all(paths.map(async (filePath) => {
    const name = filePath.split(/[/\\]/).pop() || filePath;
    if (!isTextFile(name)) return { name, error: `不是支持的文本/代码文件` };
    try {
      const result = await bridge.fs.readFile(filePath);
      if (!result.success) return { name, error: result.error };
      const content = result.content as string;
      const size = new TextEncoder().encode(content).length;
      if (size > MAX_FILE_SIZE) return { name, error: `超过 500KB 限制（${formatSize(size)}）` };
      if (pendingFiles.some(f => f.name === name)) return { name, skipped: true };
      return { name, content, language: detectLanguage(name), size };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  }));

  for (const r of results) {
    if ('skipped' in r) {
      appendSystemMessage(`ℹ️ ${r.name} 已添加`);
      continue;
    }
    if ('error' in r && r.error) {
      appendSystemMessage(`❌ 读取 ${r.name} 失败: ${r.error}`);
      continue;
    }
    if ('content' in r) {
      const fileResult = r as { name: string; content: string; language: string; size: number };
      pendingFiles.push({ name: fileResult.name, content: fileResult.content, language: fileResult.language, size: fileResult.size });
      logInfo(`文件已添加: ${fileResult.name}`, formatSize(fileResult.size));
    }
  }
  renderFilePreviews();
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

  // 重新触发 Agent Loop
  const model = getSelectedModel() || currentSession.model;

  // 新一轮开始：清理上一轮的工作空间状态
  clearToolCardsExternal();
  clearTerminalExternal();

  appendAssistantPlaceholder();
  state.set(KEYS.IS_STREAMING, true);
  updateSendButton(true);

  // 始终走 Agent Loop
  const historyMessages = currentSession.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1) // 不包含刚保留的最后一条 user 消息
      .slice(-20)
      .map(m => {
        let content = m.content || '';
        if (m._fileContents?.length) {
          const fileParts = buildFileContentParts(m._fileContents);
          content = content ? content + '\n\n---\n' + fileParts.join('\n\n---\n') : fileParts.join('\n\n---\n');
        }
        return { role: m.role, content, ...(m.images?.length && { images: m.images }), ...((m as any)._videoFrames?.length && { images: [...(m.images || []), ...(m as any)._videoFrames.map((f: any) => f.base64)] }) };
      });

    let retryMonitor: ReturnType<typeof setInterval> | null = null;

    try {
      let retryContent = '';
      let retryThinkContent = '';
      let retryIterations = 0;

      // 构建重试用的完整内容和 images（含文件内容和视频帧）
      let retryUserContent = userMsg.content || '';
      const retryImages: string[] = [...(userMsg.images || [])];
      if ((userMsg as any)._fileContents?.length) {
        const fileParts = buildFileContentParts((userMsg as any)._fileContents);
        retryUserContent = retryUserContent ? retryUserContent + '\n\n---\n' + fileParts.join('\n\n---\n') : fileParts.join('\n\n---\n');
      }
      if ((userMsg as any)._videoFrames?.length) {
        retryImages.push(...(userMsg as any)._videoFrames.map((f: any) => f.base64));
      }

      // ── 监控定时器 ──
      retryMonitor = setInterval(() => {
        if (!hasActiveCards()) {
          showWorkingHint('⏳ AI 正在处理中...');
        }
      }, 2000);
      await runAgentLoop(retryUserContent, retryImages, historyMessages, {
        onToolCallPrepare: (call) => {
          addToolCard({
            name: call.function.name, arguments: call.function.arguments,
            result: null, status: 'pending', timestamp: Date.now()
          });
        },
        onNewIteration: (toolCalls) => {
          if (retryContent || toolCalls) {
            const now = Date.now();
            const toolCallRecords: ToolCallRecord[] | undefined = toolCalls?.map(tc => ({
              name: tc.function.name, arguments: tc.function.arguments,
              result: null, status: 'running' as const, timestamp: now
            }));
            const prevMsg: ChatMessage = {
              role: 'assistant', content: retryContent || '', timestamp: now,
              ...(retryThinkContent && { think: retryThinkContent }),
              ...(toolCallRecords?.length && { toolCalls: toolCallRecords }),
            };
            state.update(KEYS.CURRENT_SESSION, (s: any) => ({
              ...s, messages: [...s.messages, prevMsg], updatedAt: Date.now()
            }));
            renderMessages();
          }
          appendAssistantPlaceholder();
          retryContent = '';
          retryThinkContent = '';
          retryIterations++;
        },
        onThinking: (thinking) => { retryThinkContent = thinking; updateLastAssistantMessage(retryContent, thinking, null, getSelectedModel()); },
        onContent: (content) => { retryContent = content; updateLastAssistantMessage(content, retryThinkContent || null, null, getSelectedModel()); },
        onToolCallStart: (call) => {
          startToolCard({
            name: call.function.name, arguments: call.function.arguments,
            result: null, status: 'running', timestamp: Date.now()
          });
        },
        onToolCallResult: (name, result, call) => {
          updateToolCard({
            name, arguments: call.function.arguments,
            result, status: result.success ? 'success' : 'error', timestamp: Date.now()
          });
          updateMessageToolRecord(name, result.success ? 'success' : 'error', result);
        },
        onToolCallError: (name, error, call) => {
          updateToolCard({
            name, arguments: call.function.arguments,
            result: { success: false, error }, status: 'error', timestamp: Date.now()
          });
          updateMessageToolRecord(name, 'error', { success: false, error });
        },
        onConfirmTool: async (call) => showToolConfirm(call),
        onPlanReady: async (plan: string, steps: string[]) => {
          try {
            const { showHtmlConfirm } = await import('./prompt-modal.js');
            const html = buildPlanConfirmHtml(plan, steps);
            return showHtmlConfirm(html, '📋 执行计划确认', true);
          } catch (err) {
            logWarn('Plan Mode: 弹窗加载失败，自动批准', (err as Error).message);
            return true;
          }
        },
        onDone: async (finalContent, toolRecords, loopStats) => {
          retryContent = finalContent;
          if (retryIterations > 0) {
            if (finalContent) {
              const lastMsg: ChatMessage = {
                role: 'assistant', content: finalContent, timestamp: Date.now(),
                ...(retryThinkContent && { think: retryThinkContent }),
                ...(toolRecords?.length && { toolCalls: toolRecords }),
                ...(loopStats?.eval_count && { eval_count: loopStats.eval_count }),
                ...(loopStats?.prompt_eval_count && { prompt_eval_count: loopStats.prompt_eval_count }),
                ...(loopStats?.total_duration && { total_duration: loopStats.total_duration }),
              };
              state.update(KEYS.CURRENT_SESSION, (s: any) => ({
                ...s, messages: [...s.messages, lastMsg], updatedAt: Date.now()
              }));
            }
            updateLastAssistantMessage(finalContent, retryThinkContent || null, loopStats || null, getSelectedModel(), Date.now(), toolRecords?.length ? toolRecords : undefined);
          } else {
            const assistantMsg: ChatMessage = {
              role: 'assistant', content: finalContent || '', timestamp: Date.now(),
              ...(retryThinkContent && { think: retryThinkContent }),
              ...(toolRecords?.length && { toolCalls: toolRecords }),
              ...(loopStats?.eval_count && { eval_count: loopStats.eval_count }),
              ...(loopStats?.prompt_eval_count && { prompt_eval_count: loopStats.prompt_eval_count }),
              ...(loopStats?.total_duration && { total_duration: loopStats.total_duration }),
            };
            state.update(KEYS.CURRENT_SESSION, (s: any) => ({
              ...s, messages: [...s.messages, assistantMsg], updatedAt: Date.now()
            }));
            updateLastAssistantMessage(finalContent, retryThinkContent || null, loopStats || null, getSelectedModel(), Date.now(), toolRecords?.length ? toolRecords : undefined);
          }
          renderMessages();
          await saveCurrentSession();
          if (loopStats?.prompt_eval_count) updateCtxRemain(loopStats.prompt_eval_count);
        }
      });
    } catch (err) {
    logError('重试失败', (err as Error).message);
    appendSystemMessage(`❌ 重试失败: ${(err as Error).message}`);
  } finally {
    if (retryMonitor) clearInterval(retryMonitor as unknown as number);
    clearWorkingHint();
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

  // 取中间的消息做摘要（保留首尾各 2 条，跳过已压缩的）
  const messages = currentSession.messages;
  const keepStart = 2;
  const keepEnd = 2;
  const head = messages.slice(0, keepStart);
  const tail = messages.slice(-keepEnd);
  const middle = messages.slice(keepStart, messages.length - keepEnd);

  // 过滤掉已压缩的消息，避免重复压缩
  const uncompressedMiddle = middle.filter(m => !m.compressed);
  if (uncompressedMiddle.length === 0) {
    showToast('中间消息已全部压缩，无需再次压缩', 'info');
    return;
  }

  const conversationText = uncompressedMiddle.map(m => {
    const role = m.role === 'user' ? '用户' : 'AI';
    let content = m.content || '';
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
        content: `请将以下对话摘要为一段简洁的上下文总结。保留关键信息：讨论的主题、得出的结论、用户的偏好、未完成的任务、关键工具调用结果。用中文输出，不超过 500 字。\n\n对话记录：\n${conversationText}`
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

    // 构建压缩后的摘要消息（标记 compressed）
    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `📋 以下是对之前对话的摘要（已压缩 ${uncompressedMiddle.length} 条消息）：\n\n${summary}`,
      timestamp: Date.now(),
      compressed: true
    };

    // 保留已压缩的中间消息 + 新摘要
    const alreadyCompressed = middle.filter(m => m.compressed);
    currentSession.messages = [...head, ...alreadyCompressed, summaryMsg, ...tail];

    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) await db.saveSession(currentSession);

    clearMessagesDOM();
    renderMessages();

    logInfo(`上下文压缩完成: ${uncompressedMiddle.length} 条 → 1 条摘要`);
    showToast(`已压缩 ${uncompressedMiddle.length} 条消息为摘要`, 'success');
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

/** 更新剩余上下文显示 */
function updateCtxRemain(promptEvalCount?: number): void {
  const el = document.querySelector('#ctxRemain') as HTMLElement;
  if (!el) return;
  const total = state.get<number>(KEYS.NUM_CTX, 0);
  if (!total || !promptEvalCount || promptEvalCount <= 0) {
    el.style.display = 'none';
    return;
  }
  const remain = total - promptEvalCount;
  if (remain <= 0) {
    el.style.display = 'inline-flex';
    el.textContent = '⚠ 上下文已满';
    el.style.color = 'var(--danger, #e74c3c)';
  } else {
    el.style.display = 'inline-flex';
    el.style.color = '';
    const fmt = remain >= 1024 ? `${(remain / 1024).toFixed(0)}K` : String(remain);
    el.textContent = `剩余 ${fmt}`;
  }
}

export function clearCtxRemain(): void {
  const el = document.querySelector('#ctxRemain') as HTMLElement;
  if (el) el.style.display = 'none';
}

/** Token 预算比例：文件内容最多占用上下文窗口的比例 */
const FILE_TOKEN_BUDGET_RATIO = 0.3;

// ── 注释剥离 ──

interface CommentRule { single: RegExp | null; multi: [RegExp, string] | null }

const COMMENT_RULES: Record<string, CommentRule> = {
  javascript:  { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  typescript:  { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  tsx:         { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  jsx:         { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  java:        { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  c:           { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  cpp:         { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  csharp:      { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  go:          { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  rust:        { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  swift:       { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  kotlin:      { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  scala:       { single: /\/\/.*$/gm, multi: [/\/\*[\s\S]*?\*\//g, ''] },
  css:         { single: null,          multi: [/\/\*[\s\S]*?\*\//g, ''] },
  python:      { single: /#.*$/gm,      multi: [/('''[\s\S]*?'''|\"\"\"[\s\S]*?\"\"\")/g, ''] },
  ruby:        { single: /#.*$/gm,      multi: null },
  perl:        { single: /#.*$/gm,      multi: null },
  shell:       { single: /#.*$/gm,      multi: null },
  bash:        { single: /#.*$/gm,      multi: null },
  r:           { single: /#.*$/gm,      multi: null },
  yaml:        { single: /#.*$/gm,      multi: null },
  sql:         { single: /--.*$/gm,     multi: [/\/\*[\s\S]*?\*\//g, ''] },
  lua:         { single: /--.*$/gm,     multi: [/--\[\[[\s\S]*?\]\]/g, ''] },
  haskell:     { single: /--.*$/gm,     multi: [/\{-[\s\S]*?-\}/g, ''] },
  html:        { single: null,          multi: [/<!--[\s\S]*?-->/g, ''] },
  xml:         { single: null,          multi: [/<!--[\s\S]*?-->/g, ''] },
  markdown:    { single: null,          multi: [/<!--[\s\S]*?-->/g, ''] },
};

function stripComments(content: string, language: string): string {
  const rule = COMMENT_RULES[language];
  if (!rule) return content;

  let result = content;
  if (rule.single) result = result.replace(rule.single, '');
  if (rule.multi) result = result.replace(rule.multi[0], rule.multi[1]);

  // 压缩连续空白行：>2个连续换行 → 2个换行
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

/**
	 * 构建文件内容 Parts，带 token 预算感知
	 * - 小文件直接嵌入，大文件按预算截断
	 * - 代码文件自动剥离注释
	 */

/** 构建 Plan Mode 确认弹窗 HTML */
function buildPlanConfirmHtml(plan: string, steps: string[]): string {
  const renderedPlan = safeMarkdown(plan.slice(0, 2000));
  const truncated = plan.length > 2000;

  const stepsHtml = steps.length > 0
    ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-subtle);">
        <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px;">
          📌 执行步骤（共 ${steps.length} 步）
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${steps.map((s, i) => `
            <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 12px;background:var(--bg-layer);border-radius:var(--radius-control);border-left:3px solid var(--accent);">
              <span style="flex-shrink:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;background:var(--accent-subtle);border-radius:50%;font-size:13px;font-weight:700;color:var(--accent);">${i + 1}</span>
              <span style="font-size:13px;line-height:1.6;color:var(--text-primary);padding-top:2px;">${escapeHtml(s)}</span>
            </div>
          `).join('')}
        </div>
      </div>`
    : '';

  return `
    <div style="font-size:13px;line-height:1.7;">
      <div style="margin-bottom:12px;padding:10px 14px;background:var(--accent-subtle);border-radius:var(--radius-control);border:1px solid rgba(232,115,74,0.12);">
        <span style="font-size:13px;font-weight:600;color:var(--accent);">🤖 AI 执行计划</span>
        <span style="font-size:11px;color:var(--text-tertiary);margin-left:8px;">批准后 AI 将按步骤依次执行，每完成一步自动标记进度</span>
      </div>
      <div style="padding:4px 0;color:var(--text-primary);">
        ${renderedPlan}
        ${truncated ? '<div style="margin-top:8px;font-size:11px;color:var(--text-tertiary);">…（计划内容已截断）</div>' : ''}
      </div>
      ${stepsHtml}
    </div>
  `;
}

function buildFileContentParts(fileContents: Array<{ language: string; content: string }>): string[] {
  const numCtx = state.get<number>(KEYS.NUM_CTX, 24576);
  const fileBudget = Math.floor(numCtx * FILE_TOKEN_BUDGET_RATIO);
  let usedTokens = 0;
  const maxSingleFileTokens = Math.floor(fileBudget * 0.5); // 单文件不超过预算的50%

  return fileContents.map((f, i) => {
    const lang = f.language || '';
    const rawTokens = estimateTokens(f.content);
    const total = fileContents.length;

    // 文件足够小，直接全量（不剥离注释，保持完整性）
    if (rawTokens <= 500 && usedTokens + rawTokens <= fileBudget) {
      usedTokens += rawTokens;
      return `📄 文件 ${i + 1}/${total}：\n\n\`\`\`${lang}\n${f.content}\n\`\`\``;
    }

    // 大文件：剥离注释 + token 预算截断
    const remaining = fileBudget - usedTokens;
    if (remaining <= 0) {
      return `⚠️ 文件 ${i + 1}/${total} 因 token 预算耗尽被跳过 (${f.content.length} 字符)`;
    }

    let text = stripComments(f.content, lang);
    let truncated = false;

    // 如果剥离注释后仍然超预算，截断到剩余预算
    const strippedTokens = estimateTokens(text);
    if (strippedTokens > maxSingleFileTokens) {
      // 按比例截取字符：预算 / 估算tokens * 长度
      const ratio = Math.min(1, maxSingleFileTokens / strippedTokens);
      const cutAt = Math.floor(text.length * ratio);
      text = text.slice(0, cutAt);
      truncated = true;
    }

    const finalTokens = estimateTokens(text);
    if (usedTokens + finalTokens > fileBudget) {
      const ratio = Math.min(1, remaining / finalTokens);
      const cutAt = Math.floor(text.length * ratio);
      text = text.slice(0, cutAt);
      truncated = true;
    }

    usedTokens += estimateTokens(text);
    const label = strippedTokens !== rawTokens ? ' (已剥离注释)' : '';
    const truncLabel = truncated ? ' [已截断]' : '';
    return `📄 文件 ${i + 1}/${total}${label}${truncLabel}：\n\n\`\`\`${lang}\n${text}\n\`\`\``;
  });
}

function buildApiMessages(messages: ChatMessage[]): Array<{ role: string; content: string; images?: string[] }> {
  return messages.map(m => {
    let content = m.content || '';
    if (m._fileContents && m._fileContents.length > 0) {
      const fileParts = buildFileContentParts(m._fileContents);
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
  resetAutoScroll(); // 发送新消息时强制恢复自动滚动

  if (pendingImages.length > 0 && !isVisionAvailable()) {
    appendSystemMessage('⚠️ 当前模型不支持图片分析，请移除图片后重试');
    return;
  }

  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  if (!currentSession) return;

  // 所有消息统一走 Agent Loop
  await sendMessageWithAgentLoop(text, currentSession, model);
  return;
}

/** 更新当前会话消息中最近一个 'running' 状态的同名工具记录 */
function updateMessageToolRecord(toolName: string, status: 'success' | 'error', result: Record<string, unknown>): void {
  let updated = false;
  state.update(KEYS.CURRENT_SESSION, (session: any) => {
    if (!session) return session;
    const messages = [...session.messages];
    // 从后往前找最近一条包含该工具 running 状态记录的消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg.toolCalls) continue;
      const idx = msg.toolCalls.findIndex((tc: any) => tc.name === toolName && tc.status === 'running');
      if (idx !== -1) {
        const updatedRecords = [...msg.toolCalls];
        updatedRecords[idx] = { ...updatedRecords[idx], status, result };
        messages[i] = { ...msg, toolCalls: updatedRecords };
        updated = true;
        return { ...session, messages, updatedAt: Date.now() };
      }
    }
    return session;
  });
  // 状态更新后重新渲染消息，使工具卡片状态即时生效
  if (updated) renderMessages();
}

async function sendMessageWithAgentLoop(text: string, currentSession: ChatSession, model: string): Promise<void> {
  const now = Date.now();
  const msgsToAdd: ChatMessage[] = [];
  const userFiles: ChatFile[] = pendingFiles.map(f => ({ name: f.name, language: f.language, size: f.size }));

  // 合并图片和视频帧为统一的 images 数组
  const images: string[] = [
    ...pendingImages.map(img => img.base64),
    ...pendingVideoFrames.map(f => f.base64),
    ...completedVideos.flatMap(v => v.frames.map(f => f.base64))
  ];
  let apiContentForModel = text || '';
  const hasVideos = pendingVideoFrames.length > 0 || completedVideos.length > 0;
  const hasAttachments = pendingImages.length > 0 || hasVideos || userFiles.length > 0;

  if (hasAttachments) {
    // 聊天卡片显示用的简短描述
    const displayParts: string[] = [];
    if (text) displayParts.push(text);
    if (pendingVideoMeta && pendingVideoFrames.length > 0) {
      displayParts.push(`[视频: ${pendingVideoMeta.fileName}, ${pendingVideoFrames.length}帧, 1fps]`);
    }
    for (const v of completedVideos) {
      displayParts.push(`[视频: ${v.fileName}, ${v.frames.length}帧, 1fps]`);
    }
    if (pendingImages.length === 1) {
      displayParts.push(`[图片: ${pendingImages[0].name}]`);
    } else if (pendingImages.length > 1) {
      displayParts.push(`[${pendingImages.length} 张图片]`);
    }
    for (const f of userFiles) {
      displayParts.push(`[文件: ${f.name}]`);
    }
    const displayContent = displayParts.join('\n');

    // Ollama API 用的完整描述（文字 + 文件 + 视频帧序列 + 图片提示）
    const apiParts: string[] = [];
    if (text) apiParts.push(text);
    if (userFiles.length > 0) {
      const fileContents = pendingFiles.map(f => ({ language: f.language, content: f.content }));
      const fileParts = buildFileContentParts(fileContents);
      apiParts.push(...fileParts);
      logInfo('📄 文件内容已注入', `${fileParts.length} 段, 共 ${fileContents.reduce((s, f) => s + f.content.length, 0)} 字符`);
    }
    if (pendingImages.length === 1) {
      apiParts.push(`[已上传图片: ${pendingImages[0].name} — 此图片已随消息提供，你可以直接分析，无需去磁盘查找]`);
    } else if (pendingImages.length > 1) {
      apiParts.push(`[已上传 ${pendingImages.length} 张图片: ${pendingImages.map(img => img.name).join(', ')} — 这些图片已随消息提供，你可以直接分析，无需去磁盘查找]`);
    }
    let allVids: Array<{ name: string; count: number; dur: number; frames: Array<{ timestampSeconds: number; name: string; base64: string }> }> = [];
    if (hasVideos) {
      if (pendingVideoMeta && pendingVideoFrames.length > 0) {
        allVids.push({ name: pendingVideoMeta.fileName, count: pendingVideoFrames.length, dur: pendingVideoMeta.duration, frames: pendingVideoFrames });
      }
      for (const v of completedVideos) {
        allVids.push({ name: v.fileName, count: v.frames.length, dur: v.duration, frames: v.frames });
      }
      const parts: string[] = [];
      for (const v of allVids) {
        const fl = v.frames.map(f => `  ${String(f.timestampSeconds).padStart(4, ' ')}s — ${f.name}`).join('\n');
        parts.push(`[视频帧序列 · ${v.name} · ${v.count}帧 · 1fps · ${v.dur.toFixed(0)}s]\n${fl}`);
      }
      apiParts.push(parts.join('\n\n'));
      apiParts.push('以上为视频帧序列，按时间顺序排列。');
    }
    apiContentForModel = apiParts.join('\n\n');

    const msg: ChatMessage = {
      role: 'user',
      content: displayContent,
      images: [...pendingImages.map(img => img.base64)],
      timestamp: now
    };
    if (allVids.length > 0) {
      const totalFrames = allVids.flatMap(v => v.frames);
      msg._videoFrames = totalFrames;
      msg._videos = allVids.map(v => ({ fileName: v.name, frameCount: v.count, duration: v.dur }));
    }
    if (userFiles.length > 0) {
      msg.files = userFiles;
      msg._fileContents = pendingFiles.map(f => ({ language: f.language, content: f.content }));
    }
    msgsToAdd.push(msg);
  } else if (text || pendingFiles.length > 0) {
    // 纯文本/纯文件消息（无图片、视频附件）
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
      title: truncate(text || (pendingFiles.length > 0 ? `[文件: ${pendingFiles.map(f => f.name).join(', ')}]` : pendingVideoMeta ? '[视频消息]' : '[图片消息]'), 30),
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
  pendingVideoFrames = [];
  pendingVideoMeta = null;
  completedVideos = [];
  imagePreviewEl.style.display = 'none';
  imagePreviewEl.innerHTML = '';
  filePreviewEl.style.display = 'none';
  filePreviewEl.innerHTML = '';
  videoPreviewEl.style.display = 'none';
  videoPreviewEl.innerHTML = '';
  autoResizeTextarea();

  // 新一轮开始：清理上一轮的工作空间状态
  clearToolCardsExternal();
  clearTerminalExternal();

  enableAutoScroll(); // renderMessages 的 DOM 操作可能触发 scroll 事件导致 autoScroll=false
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
        const fileParts = buildFileContentParts(m._fileContents);
        content = content ? content + '\n\n---\n' + fileParts.join('\n\n---\n') : fileParts.join('\n\n---\n');
      }
      return {
        role: m.role,
        content,
        ...(m.images?.length && { images: m.images }),
        ...((m as any)._videoFrames?.length && { images: [...(m.images || []), ...(m as any)._videoFrames.map((f: any) => f.base64)] })
      };
    });

  let assistantContent = '';
  let thinkContent = '';
  let agentModeIterations = 0; // 跟踪 onNewIteration 调用次数
  state.set('_currentEvalCount', 0); // 重置累计 token 计数，防止跨会话残留
  let lastIterationEvalCount = 0; // 上一轮迭代结束时的累计 token 数
  let lastIterationStartTime = Date.now(); // 当前迭代开始时间

  // ── 监控定时器：流式输出期间持续显示工作提示 ──
  // 模型生成大参数 tool_call 可能需要几分钟，期间工作空间显示提示
  const monitorInterval = setInterval(() => {
    if (!hasActiveCards()) {
      showWorkingHint('⏳ AI 正在处理中...');
    }
  }, 2000);

  try {
    await runAgentLoop(apiContentForModel || (pendingFiles.length > 0 ? `请分析 ${pendingFiles.map(f => f.name).join(', ')}` : ''), images, historyMessages, {
      /** 模型正在生成 tool_call 参数中 — 提前在工作空间显示"准备中"卡片 */
      onToolCallPrepare: (call) => {
        addToolCard({
          name: call.function.name, arguments: call.function.arguments,
          result: null, status: 'pending', timestamp: Date.now()
        });
      },
      onNewIteration: (toolCalls) => {
        // Agent Loop 新迭代开始：保存上一轮内容为独立消息，创建新 placeholder
        // 先移除旧 placeholder（防止被 renderMessages 当作已渲染消息计数）
        const oldPlaceholder = document.querySelector('#messagesContainer .message.assistant.loading') as HTMLElement;
        if (oldPlaceholder) oldPlaceholder.remove();

        // 有文本内容 或 有工具调用 → 保存为独立消息
        if (assistantContent || toolCalls) {
          const now = Date.now();
          // 计算本轮迭代的 token 和时长
          const currentEvalCount = state.get<number>('_currentEvalCount', 0);
          const iterationEvalCount = Math.max(0, currentEvalCount - lastIterationEvalCount);
          const iterationDuration = (now - lastIterationStartTime) * 1e6;

          const toolCallRecords: ToolCallRecord[] | undefined = toolCalls?.map(tc => ({
            name: tc.function.name,
            arguments: tc.function.arguments,
            result: null,
            status: 'running' as const,
            timestamp: now
          }));

          const prevMsg: ChatMessage = {
            role: 'assistant',
            content: assistantContent || '',
            timestamp: now,
            ...(thinkContent && { think: thinkContent }),
            ...(toolCallRecords?.length && { toolCalls: toolCallRecords }),
            ...(iterationEvalCount > 0 && { eval_count: iterationEvalCount }),
            ...(iterationDuration > 0 && { total_duration: iterationDuration }),
          };
          state.update(KEYS.CURRENT_SESSION, (session: any) => ({
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
        updateLastAssistantMessage(assistantContent, thinkContent || null, null, getSelectedModel());
      },
      onContent: (content) => {
        assistantContent = content;
        updateLastAssistantMessage(assistantContent, thinkContent || null, null, getSelectedModel());
      },
      onToolCallStart: (call) => {
        startToolCard({
          name: call.function.name, arguments: call.function.arguments,
          result: null, status: 'running', timestamp: Date.now()
        });
      },
      onToolCallResult: (name, result, call) => {
        updateToolCard({
          name, arguments: call.function.arguments,
          result, status: result.success ? 'success' : 'error', timestamp: Date.now()
        });
        updateMessageToolRecord(name, result.success ? 'success' : 'error', result);
      },
      onToolCallError: (name, error, call) => {
        updateToolCard({
          name, arguments: call.function.arguments,
          result: { success: false, error }, status: 'error', timestamp: Date.now()
        });
        updateMessageToolRecord(name, 'error', { success: false, error });
      },
      onConfirmTool: async (call) => {
        return showToolConfirm(call);
      },
      /** Plan Mode — 计划生成后等待用户确认（Markdown 渲染） */
      onPlanReady: async (plan: string, steps: string[]) => {
        try {
          const { showHtmlConfirm } = await import('./prompt-modal.js');
          const html = buildPlanConfirmHtml(plan, steps);
          const approved = await showHtmlConfirm(html, '📋 执行计划确认', true);
          if (approved) {
            logInfo('Plan Mode: 用户批准计划');
          }
          return approved;
        } catch (err) {
          logWarn('Plan Mode: 弹窗加载失败，自动批准', (err as Error).message);
          return true; // 加载失败时自动批准，不阻断执行
        }
      },
      onDone: async (finalContent, toolRecords, loopStats) => {
        assistantContent = finalContent;

        // 如果有多个迭代，最后一条消息已由 onNewIteration 保存，这里创建新消息保存最终回复
        if (agentModeIterations > 0) {
          if (assistantContent) {
            // 最后一轮迭代的 stats（loopStats.eval_count 即为最后一轮的 token 数）
            const lastIterDuration = (Date.now() - lastIterationStartTime) * 1e6;

            const lastMsg: ChatMessage = {
              role: 'assistant',
              content: assistantContent,
              timestamp: Date.now(),
              ...(thinkContent && { think: thinkContent }),
              ...(toolRecords?.length && { toolCalls: toolRecords }),
              ...(loopStats?.eval_count && { eval_count: loopStats.eval_count }),
              ...(loopStats?.prompt_eval_count && { prompt_eval_count: loopStats.prompt_eval_count }),
              ...(loopStats?.total_duration && { total_duration: loopStats.total_duration }),
            };
            state.update(KEYS.CURRENT_SESSION, (session: any) => ({
              ...session,
              messages: [...session.messages, lastMsg],
              updatedAt: Date.now()
            }));
          }
          updateLastAssistantMessage(assistantContent, thinkContent || null, loopStats || null, getSelectedModel(), Date.now(), toolRecords?.length ? toolRecords : undefined);
        } else {
          // 单迭代模式：正常保存
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: assistantContent || '',
            timestamp: Date.now(),
            ...(thinkContent && { think: thinkContent }),
            ...(toolRecords?.length && { toolCalls: toolRecords }),
            ...(loopStats?.eval_count && { eval_count: loopStats.eval_count }),
            ...(loopStats?.prompt_eval_count && { prompt_eval_count: loopStats.prompt_eval_count }),
            ...(loopStats?.total_duration && { total_duration: loopStats.total_duration }),
          };
          state.update(KEYS.CURRENT_SESSION, (session: any) => ({
            ...session,
            messages: [...session.messages, assistantMsg],
            updatedAt: Date.now()
          }));
          updateLastAssistantMessage(assistantContent, thinkContent || null, loopStats || null, getSelectedModel(), Date.now(), toolRecords?.length ? toolRecords : undefined);
        }
        renderMessages();
        await saveCurrentSession();
        // 更新剩余上下文
        if (loopStats?.prompt_eval_count) updateCtxRemain(loopStats.prompt_eval_count);
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
        if (!assistantContent) {
          placeholder.remove();
          resetCurrentPlaceholder();
        } else {
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
    clearInterval(monitorInterval);
    clearWorkingHint();
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
