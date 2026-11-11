// @vitest-environment jsdom
/**
 * UI 组件测试（聊天）：chat-area / input-area / history-modal / keybind-manager
 * 通过真实 DOM 事件与 Agent Loop 回调驱动。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const noop = () => {};

const hoisted = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logSession: vi.fn(),
  logWarn: vi.fn(),
  logSuccess: vi.fn(),
  logStream: vi.fn(),
  resetVideoProgress: vi.fn(),
  updateVideoProgress: vi.fn(),
  runAgentLoop: vi.fn(async () => {}),
  buildHistoryMessages: vi.fn(() => []),
  estimateTokens: vi.fn((s: string) => Math.ceil((s || '').length / 4)),
  getToolIcon: vi.fn((n: string) => (n === 'read_file' ? '📄' : '🔧')),
  formatToolName: vi.fn((n: string) => (n === 'read_file' ? '读取文件' : n)),
  getSelectedModel: vi.fn(() => 'test-model'),
  isVisionAvailable: vi.fn(() => true),
  isToolCallingSupported: vi.fn(() => true),
  showConfirm: vi.fn(async () => true),
  showPrompt: vi.fn(async () => ''),
  showToolConfirm: vi.fn(async () => true),
  addToolCard: vi.fn(),
  startToolCard: vi.fn(),
  updateToolCard: vi.fn(),
  clearToolCardsExternal: vi.fn(),
  clearTerminalExternal: vi.fn(),
  getWorkspaceDirPath: vi.fn(() => '/tmp/ws'),
  hasActiveCards: vi.fn(() => false),
  showWorkingHint: vi.fn(),
  clearWorkingHint: vi.fn(),
  saveSession: vi.fn(async () => ({ success: true })),
  resetSavedMsgTracking: vi.fn(),
  deleteSession: vi.fn(async () => ({ success: true })),
  listSessionSummaries: vi.fn(async () => [] as unknown[]),
  searchSessions: vi.fn(async () => [] as unknown[]),
  getSession: vi.fn(async () => null as unknown),
  saveFile: vi.fn(async () => '/tmp/out.txt'),
  writeFile: vi.fn(async () => ({ success: true })),
  openFile: vi.fn(async () => null as string[] | null),
  readFile: vi.fn(async () => ({ success: true, content: '' })),
  readFileBase64: vi.fn(async () => ({ success: true, content: 'aW1n', size: 10 })),
  lastCallbacks: null as Record<string, (...args: never[]) => unknown> | null,
  videoProgress: null as ((p: { current: number }) => void) | null,
  videoExtract: vi.fn(async () => ({
    success: true,
    frames: [{ name: 'f1', base64: 'frame1', timestampSeconds: 0 }],
    videoInfo: { duration: 2.5, width: 100, height: 100 },
  })),
  videoRemoveListener: vi.fn(),
}));

vi.mock('../src/renderer/services/log-service.js', () => ({
  logInfo: hoisted.logInfo,
  logError: hoisted.logError,
  logDebug: hoisted.logDebug,
  logSession: hoisted.logSession,
  logWarn: hoisted.logWarn,
  logSuccess: hoisted.logSuccess,
  logStream: hoisted.logStream,
  resetVideoProgress: hoisted.resetVideoProgress,
  updateVideoProgress: hoisted.updateVideoProgress,
}));

vi.mock('../src/renderer/services/agent-engine.js', () => ({
  runAgentLoop: hoisted.runAgentLoop,
  getTraceFallbackBackup: () => [],
  restoreTraceFallbackBackup: vi.fn(),
}));

vi.mock('../src/renderer/services/history-builder.js', () => ({
  buildHistoryMessages: hoisted.buildHistoryMessages,
}));

vi.mock('../src/renderer/services/context-manager.js', () => ({
  estimateTokens: hoisted.estimateTokens,
}));

vi.mock('../src/renderer/services/tool-registry.js', () => ({
  getToolIcon: hoisted.getToolIcon,
  formatToolName: hoisted.formatToolName,
}));

vi.mock('../src/renderer/components/model-bar.js', () => ({
  getSelectedModel: hoisted.getSelectedModel,
  isVisionAvailable: hoisted.isVisionAvailable,
  isToolCallingSupported: hoisted.isToolCallingSupported,
  getEffectiveNumCtx: () => 131072,
}));

vi.mock('../src/renderer/components/workspace-panel.js', () => ({
  addToolCard: hoisted.addToolCard,
  startToolCard: hoisted.startToolCard,
  updateToolCard: hoisted.updateToolCard,
  clearToolCardsExternal: hoisted.clearToolCardsExternal,
  clearTerminalExternal: hoisted.clearTerminalExternal,
  getWorkspaceDirPath: hoisted.getWorkspaceDirPath,
  hasActiveCards: hoisted.hasActiveCards,
  showWorkingHint: hoisted.showWorkingHint,
  clearWorkingHint: hoisted.clearWorkingHint,
}));

vi.mock('../src/renderer/components/prompt-modal.js', () => ({
  showConfirm: hoisted.showConfirm,
  showPrompt: hoisted.showPrompt,
  showHtmlConfirm: hoisted.showConfirm,
}));

vi.mock('../src/renderer/components/tool-confirm-modal.js', () => ({
  showToolConfirm: hoisted.showToolConfirm,
  initToolConfirmModal: vi.fn(),
}));

import {
  initChatArea,
  renderMessages,
  appendMessageDOM,
  appendAssistantPlaceholder,
  updateLastAssistantMessage,
  appendSystemMessage,
  clearMessages,
  clearMessagesDOM,
  resetCurrentPlaceholder,
  removeCurrentPlaceholder,
  ensureLoadingPlaceholder,
  enableAutoScroll,
  resetAutoScroll,
  scrollToBottom,
  safeMarkdown,
  highlightJsonContent,
  addToolResultHighlighting,
  exportAsMarkdown,
  exportAsHtml,
  exportAsTxt,
  initSearchBar,
} from '../src/renderer/components/chat-area.js';
import { initInputArea, sendMessage } from '../src/renderer/components/input-area.js';
import { initHistoryModal, openHistoryModal, closeHistoryModal } from '../src/renderer/components/history-modal.js';
import { initKeybindManager, getKeybindsByCategory } from '../src/renderer/components/keybind-manager.js';
import { initToast, showToast } from '../src/renderer/components/toast.js';
import { formatTime } from '../src/renderer/utils/utils.js';
import { state, KEYS } from '../src/renderer/state/state.js';
import type { ChatSession, ChatMessage, ToolCall } from '../src/renderer/types.js';

function el<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}

function makeSession(messages: ChatMessage[] = [], overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    title: '测试会话',
    model: 'test-model',
    messages,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  } as ChatSession;
}

function msg(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, timestamp: 1700000001000, ...extra } as ChatMessage;
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { function: { name, arguments: args } } as unknown as ToolCall;
}

function useVideoBridge(): void {
  (window.metonaDesktop as unknown as { video: unknown }).video = {
    extractFrames: hoisted.videoExtract,
    onProgress: (cb: (p: { current: number }) => void) => {
      hoisted.videoProgress = cb;
    },
    removeProgressListener: hoisted.videoRemoveListener,
  };
}

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf-8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';

  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: noop,
    removeEventListener: noop,
  }) as unknown as typeof window.matchMedia;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame;
  window.scrollTo = noop;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    speak: vi.fn(),
    cancel: vi.fn(),
  };
  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
    text: string;
    lang = '';
    rate = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  };
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();

  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = {
    isDesktop: true,
    dialog: {
      openFile: hoisted.openFile,
      saveFile: hoisted.saveFile,
      openDirectory: vi.fn(async () => null),
    },
    fs: { writeFile: hoisted.writeFile, readFile: hoisted.readFile, readFileBase64: hoisted.readFileBase64 },
    video: undefined,
  };

  if (!document.getElementById('memoryModal')) {
    const mem = document.createElement('div');
    mem.id = 'memoryModal';
    mem.style.display = 'none';
    document.body.appendChild(mem);
  }

  initToast();
  initChatArea();
  initSearchBar();
  initInputArea();
  initHistoryModal();
  initKeybindManager();
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.lastCallbacks = null;
  hoisted.videoProgress = null;
  hoisted.runAgentLoop.mockImplementation(async () => {});
  hoisted.getSelectedModel.mockReturnValue('test-model');
  hoisted.isVisionAvailable.mockReturnValue(true);
  hoisted.hasActiveCards.mockReturnValue(false);
  hoisted.showConfirm.mockResolvedValue(true);
  hoisted.getSession.mockResolvedValue(null);
  hoisted.listSessionSummaries.mockResolvedValue([]);
  hoisted.searchSessions.mockResolvedValue([]);
  hoisted.saveFile.mockResolvedValue('/tmp/out.txt');
  hoisted.writeFile.mockResolvedValue({ success: true });
  hoisted.openFile.mockResolvedValue(null);
  hoisted.readFile.mockResolvedValue({ success: true, content: '' });
  hoisted.readFileBase64.mockResolvedValue({ success: true, content: 'aW1n', size: 10 });
  hoisted.videoExtract.mockResolvedValue({
    success: true,
    frames: [{ name: 'f1', base64: 'frame1', timestampSeconds: 0 }],
    videoInfo: { duration: 2.5, width: 100, height: 100 },
  });
  useVideoBridge();
  (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

  state.set(KEYS.CURRENT_SESSION, makeSession());
  state.set(KEYS.IS_STREAMING, false);
  state.set(KEYS.IS_HISTORY_VIEW, false);
  state.set(KEYS.NUM_CTX, 131072);
  state.set(KEYS.API, { chatStream: vi.fn(async () => {}) });
  state.set(KEYS.DB, {
    saveSession: hoisted.saveSession,
    resetSavedMsgTracking: hoisted.resetSavedMsgTracking,
    deleteSession: hoisted.deleteSession,
    listSessionSummaries: hoisted.listSessionSummaries,
    searchSessions: hoisted.searchSessions,
    getSession: hoisted.getSession,
  } as never);
  state.set('_lastSystemPrompt', '');
  state.set(KEYS.ABORT_CONTROLLER, null);
  document.querySelectorAll('#toastContainer .toast').forEach((n) => n.remove());

  clearMessages();
  renderMessages();
  enableAutoScroll();
  el<HTMLTextAreaElement>('#chatInput').value = '';
  el('#searchBar').style.display = 'none';
  el('#searchCount').textContent = '';
  el('#historyModal').style.display = 'none';
  el('#historyBar').style.display = 'none';
  el('#inputArea').style.display = '';
  el('#settingsModal').style.display = 'none';
  el('#toolsModal').style.display = 'none';
  el('#helpModal').style.display = 'none';
  el('#tokenDashboardModal').style.display = 'none';
  el('#searxngModal').style.display = 'none';
  el('#toolConfirmModal').style.display = 'none';
  el('#logPanel').style.display = '';
  el('#historySearchInput').value = '';
  el('#historySearchClear').style.display = 'none';
  document.querySelectorAll('.remove-img, .remove-file, .remove-video').forEach((b) => (b as HTMLElement).click());
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────── chat-area 渲染 ───────────────────────────

describe('chat-area 渲染', () => {
  it('空会话显示空状态', () => {
    state.set(KEYS.CURRENT_SESSION, makeSession([]));
    renderMessages();
    expect(el('#emptyState').style.display).toBe('');
    expect(el('#messagesContainer').style.display).toBe('none');
    expect(el('#messagesContainer').innerHTML).toBe('');
  });

  it('渲染各类消息、附件、视频、工具调用与系统提示词卡片', () => {
    state.set('_lastSystemPrompt', '你是助手\n请遵守规则');
    const toolCalls = [
      { name: 'read_file', arguments: { path: 'a.ts' }, result: { success: true }, status: 'success', timestamp: 1 },
      {
        name: 'write_file',
        arguments: { command: 'x' },
        result: { success: false, error: 'denied' },
        status: 'error',
        timestamp: 2,
      },
      { name: 'run_command', arguments: {}, result: null, status: 'cancelled', timestamp: 3 },
      { name: 'web_search', arguments: { query: 'q' }, result: null, status: 'running', timestamp: 4 },
      { name: 'git', arguments: { action: 'status' }, result: null, status: 'pending', timestamp: 5 },
      {
        name: 'browser',
        arguments: { url: 'u', selector: 's', source: 'src', destination: 'dst' },
        result: null,
        status: 'success',
        timestamp: 6,
      },
    ] as ChatMessage['toolCalls'];
    const messages: ChatMessage[] = [
      msg('system', '系统消息不应渲染'),
      msg('user', 'hello <b>', {
        files: [
          { name: 'script.py', language: 'python', size: 10 },
          { name: 'Dockerfile', language: 'dockerfile', size: 5 },
        ],
        images: ['aaa'],
      }),
      msg('assistant', '# 标题', {
        think: '思考内容',
        model: 'qwen3',
        toolCalls,
        _videos: [{ fileName: 'a.mp4', frameCount: 3, duration: 2 }],
      }),
      msg('assistant', ''),
      msg('user', '历史摘要', { compressed: true }),
      msg('user', '', { images: ['bbb'] }),
      msg('assistant', '带帧', {
        _videoFrames: [
          { name: 'f', base64: 'x', timestampSeconds: 0 },
          { name: 'f2', base64: 'y', timestampSeconds: 1 },
        ],
      }),
    ];
    state.set(KEYS.CURRENT_SESSION, makeSession(messages));
    renderMessages();

    const container = el('#messagesContainer');
    expect(container.querySelectorAll('.message').length).toBe(5);
    expect(el('#emptyState').style.display).toBe('none');

    const userMsg = container.querySelector('.message.user') as HTMLElement;
    expect(userMsg.querySelector('.msg-content')?.textContent).toContain('<b>');
    expect(userMsg.querySelectorAll('.msg-img').length).toBe(1);
    expect(userMsg.querySelector('.file-icon')?.textContent).toBe('🐍');
    expect(userMsg.textContent).toContain('Dockerfile');

    const assistantMsg = container.querySelectorAll('.message.assistant')[0] as HTMLElement;
    expect(assistantMsg.querySelector('.model-tag')?.textContent).toBe('qwen3');
    expect(assistantMsg.querySelector('.system-prompt-card')).not.toBeNull();
    expect(assistantMsg.querySelector('.sp-preview')?.textContent).toContain('你是助手');
    expect(assistantMsg.querySelector('.think-content pre')?.textContent).toContain('思考内容');
    expect(assistantMsg.querySelector('.tool-calls-summary')?.textContent).toContain('6 个工具调用');
    expect(assistantMsg.querySelector('.tool-calls-summary')?.textContent).toContain('✅2');
    expect(assistantMsg.querySelector('.tool-calls-summary')?.textContent).toContain('❌1');
    expect(assistantMsg.querySelector('.tool-calls-summary')?.textContent).toContain('+1');
    expect(assistantMsg.querySelector('.tool-call-error')?.textContent).toContain('denied');
    expect(assistantMsg.textContent).toContain('用户取消了操作');
    expect(assistantMsg.textContent).toContain('a.mp4');
    expect(assistantMsg.querySelector('.msg-stats')).not.toBeNull();

    const compressed = container.querySelector('.msg-compressed-card') as HTMLElement;
    expect(compressed).not.toBeNull();
    expect(compressed.textContent).toContain('已压缩的历史对话摘要');
    expect(compressed.querySelector('.compressed-body')?.textContent).toContain('历史摘要');

    const imageOnly = container.querySelector('.message[data-index="5"]') as HTMLElement;
    expect(imageOnly.querySelector('.msg-content')).toBeNull();
    expect(imageOnly.querySelectorAll('.msg-img').length).toBe(1);

    const lastAssistant = container.querySelectorAll('.message.assistant')[1] as HTMLElement;
    expect(lastAssistant.querySelector('.msg-video-indicator')?.textContent).toContain('2 帧');

    // 系统提示词卡片点击可折叠
    const header = assistantMsg.querySelector('.system-prompt-header') as HTMLElement;
    const body = assistantMsg.querySelector('.system-prompt-body') as HTMLElement;
    header.click();
    expect(body.style.display).toBe('');
    header.click();
    expect(body.style.display).toBe('none');
  });

  it('增量渲染只追加新消息，清空后全量重建', () => {
    const session = makeSession([msg('user', 'one')]);
    state.set(KEYS.CURRENT_SESSION, session);
    renderMessages();
    const firstNode = el('#messagesContainer').querySelector('.message');
    expect(el('#messagesContainer').querySelectorAll('.message').length).toBe(1);

    session.messages.push(msg('assistant', 'two'));
    renderMessages();
    expect(el('#messagesContainer').querySelectorAll('.message').length).toBe(2);
    expect(el('#messagesContainer').querySelector('.message')).toBe(firstNode);

    clearMessagesDOM();
    renderMessages();
    expect(el('#messagesContainer').querySelectorAll('.message').length).toBe(2);
  });

  it('超过 200 条消息时折叠并显示提示', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 201; i++) messages.push(msg(i % 2 ? 'assistant' : 'user', `m${i}`));
    state.set(KEYS.CURRENT_SESSION, makeSession(messages));
    renderMessages();
    const notice = el('#messagesContainer .msg-truncated-notice');
    expect(notice.textContent).toContain('已折叠前 1 条消息');
    expect(el('#messagesContainer').querySelectorAll('.message').length).toBe(200);
  });

  it('safeMarkdown 处理空值与对象', () => {
    expect(safeMarkdown(null)).toBe('');
    expect(safeMarkdown(undefined)).toBe('');
    expect(safeMarkdown(0)).toContain('0');
    expect(safeMarkdown({ a: 1 })).toContain('object');
    expect(safeMarkdown('# hi')).toContain('<h1');
  });

  it('highlightJsonContent 格式化合法 JSON，非法内容仅转义', () => {
    const html = highlightJsonContent('{"a":1,"b":true,"c":null,"d":"x"}');
    expect(html).toContain('hl-json-key');
    expect(html).toContain('hl-json-number');
    expect(html).toContain('hl-json-boolean');
    expect(html).toContain('hl-json-null');
    const raw = highlightJsonContent('<not json>');
    expect(raw).toBe('&lt;not json&gt;');
  });

  it('代码块复制按钮与消息复制/朗读按钮', async () => {
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('assistant', '```js\nconst a = 1;\n```')]));
    renderMessages();
    const pre = el('#messagesContainer pre');
    const copyBtn = pre.querySelector('.code-copy-btn') as HTMLButtonElement;
    expect(copyBtn.textContent).toBe('📋 复制');
    pre.dispatchEvent(new MouseEvent('mouseenter'));
    expect(copyBtn.style.opacity).toBe('1');
    pre.dispatchEvent(new MouseEvent('mouseleave'));
    expect(copyBtn.style.opacity).toBe('0');
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    expect(copyBtn.textContent).toBe('✅ 已复制');

    const msgCopy = el('#messagesContainer .msg-copy-btn') as HTMLButtonElement;
    msgCopy.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(msgCopy.textContent).toBe('✅');

    const tts = el('#messagesContainer .msg-tts-btn') as HTMLButtonElement;
    tts.click();
    expect(window.speechSynthesis.speak).toHaveBeenCalled();
    expect(tts.textContent).toBe('⏹');
    tts.click();
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
    expect(tts.textContent).toBe('🔊');
  });

  it('复制失败时显示失败状态', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('denied'));
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('assistant', '```\nx\n```')]));
    renderMessages();
    const btn = el('#messagesContainer .code-copy-btn') as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(btn.textContent).toBe('❌ 失败');
  });

  it('addToolResultHighlighting 为工具结果添加高亮与复制按钮', async () => {
    const pre = document.createElement('pre');
    pre.className = 'tool-result-content';
    pre.textContent = '{"ok":true}';
    el('#messagesContainer').appendChild(pre);
    addToolResultHighlighting(el('#messagesContainer'));
    expect(pre.dataset.highlighted).toBe('true');
    expect(pre.querySelector('.hl-json-key')).not.toBeNull();
    const btn = pre.querySelector('.code-copy-btn') as HTMLButtonElement;
    pre.dispatchEvent(new MouseEvent('mouseenter'));
    expect(btn.style.opacity).toBe('1');
    btn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(btn.textContent).toBe('✅ 已复制');
    pre.remove();
  });

  it('滚动事件切换回到底部按钮，点击后恢复自动滚动', () => {
    const area = el('#chatArea');
    Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(area, 'clientHeight', { configurable: true, value: 500 });
    area.scrollTop = 100;
    area.dispatchEvent(new Event('scroll'));
    expect(el('#scrollToBottom').style.display).toBe('');
    area.scrollTop = 500;
    area.dispatchEvent(new Event('scroll'));
    expect(el('#scrollToBottom').style.display).toBe('none');

    area.scrollTop = 0;
    area.dispatchEvent(new Event('scroll'));
    expect(el('#scrollToBottom').style.display).toBe('');
    const scrollSpy = vi.spyOn(area, 'scrollTo').mockImplementation(() => {});
    el('#scrollToBottom').click();
    expect(el('#scrollToBottom').style.display).toBe('none');
    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  it('scrollToBottom 在自动滚动关闭时不执行', async () => {
    const area = el('#chatArea');
    Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(area, 'clientHeight', { configurable: true, value: 500 });
    area.scrollTop = 0;
    area.dispatchEvent(new Event('scroll'));
    const before = area.scrollTop;
    scrollToBottom();
    await new Promise((r) => setTimeout(r, 10));
    expect(area.scrollTop).toBe(before);
    resetAutoScroll();
  });
});

// ─────────────────────────── chat-area 流式与占位符 ───────────────────────────

describe('chat-area 流式更新', () => {
  it('appendAssistantPlaceholder 显示加载动画并轮转提示', () => {
    vi.useFakeTimers();
    appendAssistantPlaceholder();
    const loading = el('#messagesContainer .message.assistant.loading');
    expect(loading).not.toBeNull();
    expect(loading.querySelector('.loading-text')?.textContent).toBe('正在思考...');
    vi.advanceTimersByTime(3000);
    expect(loading.querySelector('.loading-text')?.textContent).toBe('正在分析问题...');
    removeCurrentPlaceholder();
    vi.advanceTimersByTime(3000);
    expect(el('#messagesContainer .message.assistant.loading')).toBeNull();
    resetCurrentPlaceholder();
  });

  it('updateLastAssistantMessage 完成态渲染系统提示词、思考、模型、工具与时间戳', async () => {
    state.set('_lastSystemPrompt', 'system prompt');
    state.set(KEYS.CURRENT_SESSION, makeSession([]));
    appendAssistantPlaceholder();
    const toolCalls = [
      { name: 'read_file', arguments: { path: 'a' }, result: { success: true }, status: 'success', timestamp: 1 },
    ] as ChatMessage['toolCalls'];
    updateLastAssistantMessage('final **md**', 'think text', null, 'qwen', 1700000002000, toolCalls);
    await new Promise((r) => setTimeout(r, 10));

    const node = el('#messagesContainer .message.assistant');
    expect(node.classList.contains('loading')).toBe(false);
    expect(node.querySelector('.loading-dots')).toBeNull();
    expect(node.querySelector('.system-prompt-card')).not.toBeNull();
    expect(node.querySelector('.model-tag')?.textContent).toBe('qwen');
    expect(node.querySelector('.msg-content')?.innerHTML).toContain('<strong>');
    expect(node.querySelector('.think-content pre')?.textContent).toBe('think text');
    expect(node.querySelector('.tool-calls-history')).not.toBeNull();
    expect(node.querySelector('.msg-stats')).not.toBeNull();

    // 再次更新：已有 think/tool/stat 节点时走更新分支
    updateLastAssistantMessage('again', 'think2', null, 'qwen2', 1700000003000, toolCalls);
    await new Promise((r) => setTimeout(r, 10));
    expect(node.querySelectorAll('.think-block').length).toBe(1);
    expect(node.querySelectorAll('.tool-calls-history').length).toBe(1);
    expect(node.querySelector('.model-tag')?.textContent).toBe('qwen2');
    expect(node.querySelector('.msg-stats')?.textContent).toContain(formatTime(1700000003000));
  });

  it('updateLastAssistantMessage 无占位符时安全返回', () => {
    clearMessages();
    expect(() => updateLastAssistantMessage('x', 'y', null, 'm', 1)).not.toThrow();
  });

  it('流式渲染使用 rAF 并补全未闭合 Markdown', async () => {
    appendAssistantPlaceholder();
    updateLastAssistantMessage('```js\nconst a = 1;\n`unclosed', null, null, 'm');
    await new Promise((r) => setTimeout(r, 20));
    const content = el('#messagesContainer .message.assistant .msg-content') as HTMLElement;
    expect(content.innerHTML).toContain('const a = 1');
    // 相同内容再次触发 rAF，命中内容指纹提前返回分支
    updateLastAssistantMessage('```js\nconst a = 1;\n`unclosed', null, null, 'm');
    await new Promise((r) => setTimeout(r, 20));
    // 增量小于阈值且已有内容 → 跳过渲染
    const long = 'a'.repeat(150);
    updateLastAssistantMessage(long, null, null, 'm');
    await new Promise((r) => setTimeout(r, 20));
    updateLastAssistantMessage(long + 'bbbbb', null, null, 'm');
    await new Promise((r) => setTimeout(r, 20));
    expect(content.textContent).not.toContain('bbbbb');
  });

  it('仅思考内容时创建 think 区块，最终无内容时重置流状态', async () => {
    appendAssistantPlaceholder();
    updateLastAssistantMessage('', 'only think', null, 'm');
    await new Promise((r) => setTimeout(r, 10));
    const node = el('#messagesContainer .message.assistant');
    expect(node.querySelector('.think-block')).not.toBeNull();
    expect(node.querySelector('.think-content pre')?.textContent).toBe('only think');
    expect(() => updateLastAssistantMessage('', null, null, 'm', 123)).not.toThrow();
  });

  it('ensureLoadingPlaceholder 复用现有 loading，失效后重建', () => {
    appendAssistantPlaceholder();
    const first = el('#messagesContainer .message.assistant.loading');
    // 直接调用内部逻辑通过再次 append 前先确保
    expect(el('#messagesContainer').querySelectorAll('.message.assistant.loading').length).toBe(1);
    removeCurrentPlaceholder();
    appendAssistantPlaceholder();
    const second = el('#messagesContainer .message.assistant.loading');
    expect(second).not.toBe(first);
    clearMessages();
  });

  it('appendSystemMessage 支持临时 class，clearMessages 重置', () => {
    appendSystemMessage('系统提示', 'temp-class');
    const node = el('#messagesContainer .temp-class');
    expect(node.textContent).toBe('系统提示');
    expect(el('#emptyState').style.display).toBe('none');
    clearMessages();
    expect(el('#messagesContainer').innerHTML).toBe('');
  });

  it('appendMessageDOM 可直接追加指定索引', () => {
    appendMessageDOM(msg('user', 'direct'), 7);
    const node = el('#messagesContainer .message.user');
    expect(node.dataset.index).toBe('7');
    clearMessages();
  });

  it('无当前会话时渲染空状态', () => {
    state.set(KEYS.CURRENT_SESSION, null);
    renderMessages();
    expect(el('#emptyState').style.display).toBe('');
    expect(el('#messagesContainer').innerHTML).toBe('');
  });

  it('超长系统提示词预览截断，文件图标覆盖 makefile/未知扩展', () => {
    state.set('_lastSystemPrompt', 'S'.repeat(200));
    state.set(
      KEYS.CURRENT_SESSION,
      makeSession([
        msg('user', 'files', {
          files: [
            { name: 'Makefile', language: 'makefile', size: 1 },
            { name: 'Dockerfile', language: 'dockerfile', size: 1 },
            { name: 'data.xyz', language: 'text', size: 1 },
          ],
        }),
        msg('assistant', 'ok'),
      ]),
    );
    renderMessages();
    const preview = el('#messagesContainer .sp-preview').textContent || '';
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(121);
    const icons = Array.from(el('#messagesContainer').querySelectorAll('.file-icon')).map((n) => n.textContent);
    expect(icons).toEqual(['🔨', '🐳', '📄']);
  });

  it('工具状态/名称回退与 content=null', () => {
    state.set(
      KEYS.CURRENT_SESSION,
      makeSession([
        msg('assistant', 'x', {
          toolCalls: [
            { name: 'unknown_tool', arguments: {}, result: null, status: 'weird', timestamp: 1 },
          ] as ChatMessage['toolCalls'],
        }),
      ]),
    );
    renderMessages();
    expect(el('#messagesContainer').textContent).toContain('unknown_tool');
    expect(el('#messagesContainer').textContent).toContain('weird');

    clearMessages();
    appendMessageDOM({ role: 'assistant', content: null, timestamp: 1 } as unknown as ChatMessage, 0);
    expect(el('#messagesContainer .message.assistant .msg-content')).not.toBeNull();
  });

  it('ensureLoadingPlaceholder 在已有非 loading 占位符后追加新 loading', () => {
    clearMessages();
    appendAssistantPlaceholder();
    updateLastAssistantMessage('done', null, null, 'm', 123);
    ensureLoadingPlaceholder();
    expect(el('#messagesContainer').querySelectorAll('.message.assistant').length).toBe(2);
    expect(el('#messagesContainer').querySelectorAll('.message.assistant.loading').length).toBe(1);
  });

  it('搜索跳过 script/style 文本', () => {
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'target visible')]));
    renderMessages();
    const content = el('#messagesContainer .msg-content');
    const script = document.createElement('script');
    script.textContent = 'var target = "hidden";';
    content.appendChild(script);
    el('#btnSearch').click();
    const input = el<HTMLInputElement>('#searchInput');
    input.value = 'target';
    input.dispatchEvent(new Event('input'));
    expect(el('#searchCount').textContent).toBe('1/1');
    el('#searchClose').click();
  });

  it('无内容消息的复制/朗读按钮安全返回', () => {
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'x')]));
    renderMessages();
    const manual = document.createElement('div');
    manual.className = 'message assistant';
    manual.innerHTML = '<div class="msg-body"></div>';
    el('#messagesContainer').appendChild(manual);
    renderMessages();
    const copy = manual.querySelector('.msg-copy-btn') as HTMLButtonElement;
    copy.click();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    const tts = manual.querySelector('.msg-tts-btn') as HTMLButtonElement;
    tts.click();
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it('addToolResultHighlighting 处理数组 JSON 与普通文本', () => {
    const jsonPre = document.createElement('pre');
    jsonPre.className = 'tool-result-content';
    jsonPre.textContent = '[1,2]';
    const textPre = document.createElement('pre');
    textPre.className = 'tool-result-content';
    textPre.textContent = 'plain text';
    el('#messagesContainer').append(jsonPre, textPre);
    addToolResultHighlighting(el('#messagesContainer'));
    expect(jsonPre.textContent).toContain('[\n  1,\n  2\n]');
    expect(textPre.querySelector('.code-copy-btn')).not.toBeNull();
    jsonPre.remove();
    textPre.remove();
  });
});

// ─────────────────────────── 对话内搜索 ───────────────────────────

describe('chat-area 搜索', () => {
  beforeEach(() => {
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'hello world'), msg('assistant', 'hello again')]));
    renderMessages();
    el('#searchBar').style.display = 'none';
    el('#searchInput').value = '';
    el('#searchCount').textContent = '';
  });

  it('打开/关闭搜索栏并高亮匹配', () => {
    el('#btnSearch').click();
    expect(el('#searchBar').style.display).toBe('');
    const input = el<HTMLInputElement>('#searchInput');
    input.value = 'hello';
    input.dispatchEvent(new Event('input'));
    expect(el('#searchCount').textContent).toBe('1/2');
    expect(document.querySelectorAll('.search-highlight').length).toBe(2);
    expect(document.querySelectorAll('.search-highlight-current').length).toBe(1);

    el('#searchNext').click();
    expect(el('#searchCount').textContent).toBe('2/2');
    el('#searchPrev').click();
    expect(el('#searchCount').textContent).toBe('1/2');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el('#searchCount').textContent).toBe('2/2');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(el('#searchCount').textContent).toBe('1/2');

    el('#searchClose').click();
    expect(el('#searchBar').style.display).toBe('none');
    expect(el('#searchInput').value).toBe('');
    expect(document.querySelectorAll('.search-highlight').length).toBe(0);
  });

  it('无匹配与空查询状态', () => {
    el('#btnSearch').click();
    const input = el<HTMLInputElement>('#searchInput');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    expect(el('#searchCount').textContent).toBe('无匹配');
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    expect(el('#searchCount').textContent).toBe('');
    el('#searchNext').click();
    el('#searchPrev').click();
  });

  it('Ctrl+F 打开搜索栏，再次 Ctrl+F 关闭，Escape 关闭', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(el('#searchBar').style.display).toBe('');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(el('#searchBar').style.display).toBe('none');
    el('#btnSearch').click();
    expect(el('#searchBar').style.display).toBe('');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el('#searchBar').style.display).toBe('none');
  });
});

// ─────────────────────────── 导出 ───────────────────────────

describe('chat-area 导出', () => {
  const session = makeSession(
    [
      msg('user', '用户内容', { files: [{ name: 'a.py', language: 'python', size: 1 }] }),
      msg('assistant', 'AI 内容', { think: '思考' }),
    ],
    { title: '标题 <x>', model: 'qwen' },
  );

  it('Markdown/HTML/TXT 导出写入文件', async () => {
    await exportAsMarkdown(session);
    let written = hoisted.writeFile.mock.calls.at(-1)![1] as string;
    expect(written).toContain('# 标题 <x>');
    expect(written).toContain('📎 `a.py`');
    expect(written).toContain('> **思考:** 思考');
    expect(hoisted.saveFile).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '标题 <x>.md' }));

    await exportAsHtml(session);
    written = hoisted.writeFile.mock.calls.at(-1)![1] as string;
    expect(written).toContain('&lt;x&gt;');
    expect(written).toContain('<div class="user">');
    expect(written).toContain('<div class="assistant">');

    await exportAsTxt(session);
    written = hoisted.writeFile.mock.calls.at(-1)![1] as string;
    expect(written).toContain('[用户]');
    expect(written).toContain('[AI]');
    expect(written).toContain('模型: qwen');
  });

  it('取消保存不写文件，写入失败记录错误', async () => {
    hoisted.saveFile.mockResolvedValueOnce(null);
    const before = hoisted.writeFile.mock.calls.length;
    await exportAsMarkdown(session);
    expect(hoisted.writeFile.mock.calls.length).toBe(before);

    hoisted.writeFile.mockResolvedValueOnce({ success: false, error: 'disk full' });
    await exportAsMarkdown(session);
    expect(hoisted.logError).toHaveBeenCalledWith('导出失败', 'disk full');
  });

  it('无 bridge 时回退浏览器下载', async () => {
    const bridge = (window as unknown as { metonaDesktop?: unknown }).metonaDesktop;
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = undefined;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await exportAsTxt(session);
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = bridge;
  });
});

// ─────────────────────────── input-area 发送与回调 ───────────────────────────

describe('input-area 发送', () => {
  it('空输入不发送，流式状态不重复发送', async () => {
    await sendMessage();
    expect(hoisted.runAgentLoop).not.toHaveBeenCalled();

    state.set(KEYS.IS_STREAMING, true);
    el<HTMLTextAreaElement>('#chatInput').value = 'x';
    await sendMessage();
    expect(hoisted.runAgentLoop).not.toHaveBeenCalled();
  });

  it('无模型时提示先选择模型', async () => {
    hoisted.getSelectedModel.mockReturnValue('');
    el<HTMLTextAreaElement>('#chatInput').value = 'hi';
    await sendMessage();
    expect(el('#messagesContainer').textContent).toContain('请先选择一个模型');
  });

  it('发送文本：写入会话、渲染、保存并清空输入', async () => {
    const session = makeSession([], { title: '新会话', model: 'test-model' });
    state.set(KEYS.CURRENT_SESSION, session);
    el<HTMLTextAreaElement>('#chatInput').value = 'hello agent';
    await sendMessage();

    expect(hoisted.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(hoisted.runAgentLoop.mock.calls[0][0]).toBe('hello agent');
    const live = state.get<ChatSession>(KEYS.CURRENT_SESSION)!;
    expect(live.title).toBe('hello agent');
    expect(live.messages[0].role).toBe('user');
    expect(live.messages[0].content).toBe('hello agent');
    expect(el<HTMLTextAreaElement>('#chatInput').value).toBe('');
    expect(hoisted.saveSession).toHaveBeenCalled();
    expect(el('#messagesContainer .message.user')).not.toBeNull();
    expect(hoisted.clearToolCardsExternal).toHaveBeenCalled();
    expect(hoisted.clearTerminalExternal).toHaveBeenCalled();
    expect(state.get(KEYS.IS_STREAMING)).toBe(false);
  });

  it('Agent Loop 回调驱动思考/内容/工具/迭代/完成', async () => {
    const session = makeSession([], { title: '新会话', model: 'test-model' });
    state.set(KEYS.CURRENT_SESSION, session);
    hoisted.runAgentLoop.mockImplementation(
      async (_c: string, _i: string[], _h: unknown, cb: Record<string, (...args: never[]) => unknown>) => {
        hoisted.lastCallbacks = cb;
      },
    );
    el<HTMLTextAreaElement>('#chatInput').value = 'run tools';
    await sendMessage();
    const cb = hoisted.lastCallbacks!;
    expect(cb).not.toBeNull();

    const call = toolCall('read_file', { path: 'a.ts' });
    cb.onToolCallPrepare(call as never);
    expect(hoisted.addToolCard).toHaveBeenCalledWith(expect.objectContaining({ name: 'read_file', status: 'pending' }));

    cb.onThinkingStart();
    cb.onThinking('thinking' as never);
    expect(el('#messagesContainer').textContent).toContain('thinking');
    cb.onContent('partial answer' as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#messagesContainer').textContent).toContain('partial answer');

    cb.onToolCallStart(call as never);
    expect(hoisted.startToolCard).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'read_file', status: 'running' }),
    );
    cb.onToolCallResult('read_file' as never, { success: true } as never, call as never);
    expect(hoisted.updateToolCard).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    cb.onToolCallError('write_file' as never, 'denied' as never, toolCall('write_file') as never);
    expect(hoisted.updateToolCard).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', result: { success: false, error: 'denied' } }),
    );

    await cb.onConfirmTool(call as never);
    expect(hoisted.showToolConfirm).toHaveBeenCalledWith(call);

    await cb.onNewIteration([] as never, { eval_count: 3, prompt_eval_count: 4, total_duration: 5 } as never);
    const live = state.get<ChatSession>(KEYS.CURRENT_SESSION)!;
    const prevAssistant = live.messages.filter((m) => m.role === 'assistant').at(-1)!;
    expect(prevAssistant.content).toBe('partial answer');
    expect(prevAssistant.think).toBe('thinking');
    expect(prevAssistant.toolCalls?.length).toBe(2);
    expect(prevAssistant.eval_count).toBe(3);

    cb.onContent('second answer' as never);
    await cb.onDone(
      'final answer' as never,
      [] as never,
      {
        eval_count: 10,
        prompt_eval_count: 20,
        prompt_eval_cached_count: 5,
        total_duration: 1000,
        done_reason: 'length',
      } as never,
    );
    const finalAssistant = state
      .get<ChatSession>(KEYS.CURRENT_SESSION)!
      .messages.filter((m) => m.role === 'assistant')
      .at(-1)!;
    expect(finalAssistant.content).toBe('final answer');
    expect(finalAssistant.prompt_eval_cached_count).toBe(5);
    expect(el('#toastContainer').textContent).toContain('输出达到模型上限');
    expect(hoisted.saveSession).toHaveBeenCalled();
  });

  it('onNewIteration 无有效载荷时跳过幽灵消息', async () => {
    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    hoisted.runAgentLoop.mockImplementation(
      async (_c: string, _i: string[], _h: unknown, cb: Record<string, (...args: never[]) => unknown>) => {
        hoisted.lastCallbacks = cb;
      },
    );
    el<HTMLTextAreaElement>('#chatInput').value = 'x';
    await sendMessage();
    await hoisted.lastCallbacks!.onNewIteration([] as never, {} as never);
    expect(state.get<ChatSession>(KEYS.CURRENT_SESSION)!.messages.filter((m) => m.role === 'assistant').length).toBe(0);
  });

  it('AbortError 停止生成并保存部分消息', async () => {
    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    state.set('_abortToolRecords', [
      { name: 'read_file', arguments: {}, result: null, status: 'success', timestamp: 1 },
    ]);
    hoisted.runAgentLoop.mockImplementation(
      async (_c: string, _i: string[], _h: unknown, cb: Record<string, (...args: never[]) => unknown>) => {
        hoisted.lastCallbacks = cb;
        cb.onContent('partial' as never);
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    );
    el<HTMLTextAreaElement>('#chatInput').value = 'x';
    await sendMessage();

    const partial = state
      .get<ChatSession>(KEYS.CURRENT_SESSION)!
      .messages.filter((m) => m.role === 'assistant')
      .at(-1)!;
    expect(partial.stopped).toBe(true);
    expect(partial.content).toBe('partial');
    expect(partial.toolCalls?.length).toBe(1);
    expect(el('#messagesContainer').textContent).toContain('已停止生成');
    expect(state.get('_abortToolRecords')).toBeNull();
  });

  it('AbortError 无有效内容时不入库', async () => {
    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    hoisted.runAgentLoop.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    el<HTMLTextAreaElement>('#chatInput').value = 'x';
    await sendMessage();
    expect(state.get<ChatSession>(KEYS.CURRENT_SESSION)!.messages.filter((m) => m.role === 'assistant').length).toBe(0);
    expect(el('#messagesContainer').textContent).toContain('[已停止]');
    expect(el('#messagesContainer').textContent).toContain('已停止生成');
  });

  it('网络错误显示连接失败并保存 partial', async () => {
    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    hoisted.runAgentLoop.mockImplementation(
      async (_c: string, _i: string[], _h: unknown, cb: Record<string, (...args: never[]) => unknown>) => {
        hoisted.lastCallbacks = cb;
        cb.onContent('partial' as never);
        throw new Error('Failed to fetch');
      },
    );
    el<HTMLTextAreaElement>('#chatInput').value = 'x';
    await sendMessage();
    const partial = state
      .get<ChatSession>(KEYS.CURRENT_SESSION)!
      .messages.filter((m) => m.role === 'assistant')
      .at(-1)!;
    expect(partial.interrupted).toBe(true);
    expect(el('#messagesContainer').textContent).toContain('连接失败');
  });

  it('普通错误无内容时移除占位符', async () => {
    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    hoisted.runAgentLoop.mockImplementation(async () => {
      throw new Error('boom');
    });
    el<HTMLTextAreaElement>('#chatInput').value = 'x';
    await sendMessage();
    expect(el('#messagesContainer').textContent).toContain('错误: boom');
    expect(el('#messagesContainer .message.assistant.loading')).toBeNull();
  });

  it('发送按钮在流式时触发中止，Escape 同样中止', async () => {
    const abort = { abort: vi.fn() };
    state.set(KEYS.ABORT_CONTROLLER, abort);
    state.set(KEYS.IS_STREAMING, true);
    el('#btnSend').click();
    expect(abort.abort).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(abort.abort).toHaveBeenCalledTimes(2);
  });

  it('Ctrl+Shift+C 复制最后一条 AI 回复', async () => {
    state.set(
      KEYS.CURRENT_SESSION,
      makeSession([msg('assistant', 'first'), msg('user', 'q'), msg('assistant', 'last answer')]),
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('last answer');
    expect(el('#toastContainer').textContent).toContain('已复制最后一条 AI 回复');
  });

  it('输入框 Enter 发送、Shift+Enter 换行、输入自动调整高度', async () => {
    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    const input = el<HTMLTextAreaElement>('#chatInput');
    input.value = 'via enter';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.runAgentLoop).toHaveBeenCalledWith('via enter', [], [], expect.any(Object));

    input.value = 'line';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(hoisted.runAgentLoop).toHaveBeenCalledTimes(1);

    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 200 });
    input.dispatchEvent(new Event('input'));
    expect(input.style.height).toBe('120px');
  });

  it('think 档位下拉写入状态', () => {
    const select = el<HTMLSelectElement>('#selectThinkLevel');
    select.value = 'medium';
    select.dispatchEvent(new Event('change'));
    expect(state.get('thinkLevel')).toBe('medium');
    expect(state.get('thinkEnabled')).toBe(true);
    select.value = 'off';
    select.dispatchEvent(new Event('change'));
    expect(state.get('thinkEnabled')).toBe(false);
  });

  it('无当前会话时发送直接返回', async () => {
    state.set(KEYS.CURRENT_SESSION, null);
    el<HTMLTextAreaElement>('#chatInput').value = 'x';
    await sendMessage();
    expect(hoisted.runAgentLoop).not.toHaveBeenCalled();
  });

  it('长消息日志详情截断', async () => {
    state.set(KEYS.CURRENT_SESSION, makeSession([], { title: '新会话' }));
    el<HTMLTextAreaElement>('#chatInput').value = 'L'.repeat(100);
    await sendMessage();
    expect(hoisted.logInfo).toHaveBeenCalledWith('发送消息: test-model', expect.stringMatching(/\.\.\.$/));
  });

  it('监控定时器在有/无活动卡片时显示工作提示', async () => {
    vi.useFakeTimers();
    let resolveLoop: (() => void) | null = null;
    hoisted.runAgentLoop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLoop = resolve;
        }),
    );
    state.set(KEYS.CURRENT_SESSION, makeSession([], { title: '新会话' }));
    el<HTMLTextAreaElement>('#chatInput').value = 'monitor';
    const p = sendMessage();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2100);
    expect(hoisted.showWorkingHint).toHaveBeenCalledWith('⏳ AI 正在处理中...');
    const calls = hoisted.showWorkingHint.mock.calls.length;
    hoisted.hasActiveCards.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(hoisted.showWorkingHint.mock.calls.length).toBe(calls);
    resolveLoop!();
    await p;
  });
});

// ─────────────────────────── input-area 附件 ───────────────────────────

describe('input-area 附件', () => {
  it('文件选择：成功预览、重复、非文本、读取失败、超限与移除', async () => {
    hoisted.openFile.mockResolvedValue(['/tmp/note.md', '/tmp/bin.exe', '/tmp/fail.md', '/tmp/big.md']);
    hoisted.readFile
      .mockResolvedValueOnce({ success: true, content: '# note' })
      .mockResolvedValueOnce({ success: false, error: 'denied' })
      .mockResolvedValueOnce({ success: true, content: 'x'.repeat(600 * 1024) });
    el('#btnAttachFile').click();
    await new Promise((r) => setTimeout(r, 20));

    expect(el('#filePreview').style.display).toBe('');
    expect(el('#filePreview').textContent).toContain('note.md');
    expect(el('#messagesContainer').textContent).toContain('不是支持的文本/代码文件');
    expect(el('#messagesContainer').textContent).toContain('读取 fail.md 失败');
    expect(el('#messagesContainer').textContent).toContain('超过 500KB 限制');

    hoisted.openFile.mockResolvedValue(['/tmp/note.md']);
    el('#btnAttachFile').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#messagesContainer').textContent).toContain('note.md 已添加');
    expect(el('#filePreview').querySelectorAll('.file-chip').length).toBe(1);

    (el('#filePreview .remove-file') as HTMLElement).click();
    expect(el('#filePreview').style.display).toBe('none');
  });

  it('文件选择取消/无 bridge 时不处理', async () => {
    hoisted.openFile.mockResolvedValue([]);
    el('#btnAttachFile').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.readFile).not.toHaveBeenCalled();

    const bridge = (window as unknown as { metonaDesktop?: unknown }).metonaDesktop;
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = undefined;
    el('#btnAttachFile').click();
    await new Promise((r) => setTimeout(r, 10));
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = bridge;
  });

  it('文件消息注入内容并剥离注释/截断', async () => {
    const jsContent = `// comment line\nconst x = 1;\n/* block */\n${'const y = 2;\n'.repeat(200)}`;
    hoisted.openFile.mockResolvedValue(['/tmp/app.js']);
    hoisted.readFile.mockResolvedValue({ success: true, content: jsContent });
    el('#btnAttachFile').click();
    await new Promise((r) => setTimeout(r, 20));

    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    el<HTMLTextAreaElement>('#chatInput').value = '';
    await sendMessage();
    const live = state.get<ChatSession>(KEYS.CURRENT_SESSION)!;
    const userMsg = live.messages[0];
    expect(userMsg.files?.[0].name).toBe('app.js');
    expect(userMsg.content).toBe('');
    expect(live.title).toBe('[文件: app.js]');
    const apiContent = hoisted.runAgentLoop.mock.calls[0][0] as string;
    expect(apiContent).toContain('app.js');
    expect(apiContent).not.toContain('comment line');
    expect(apiContent).not.toContain('block');
  });

  it('图片：不支持时提示，成功预览与移除，发送注入 images', async () => {
    hoisted.isVisionAvailable.mockReturnValue(false);
    el('#btnAttachImg').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#toastContainer').textContent).toContain('当前模型不支持图片分析');
    expect(hoisted.openFile).not.toHaveBeenCalled();

    hoisted.isVisionAvailable.mockReturnValue(true);
    hoisted.openFile.mockResolvedValue(['/tmp/a.png']);
    el('#btnAttachImg').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#imagePreview').style.display).toBe('');
    expect(el('#imagePreview .preview-thumb')).not.toBeNull();

    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    el<HTMLTextAreaElement>('#chatInput').value = '看图';
    await sendMessage();
    expect(state.get<ChatSession>(KEYS.CURRENT_SESSION)!.messages[0].images).toEqual(['aW1n']);
    expect(hoisted.runAgentLoop.mock.calls[0][1]).toEqual(['aW1n']);
  });

  it('图片读取失败/超限/异常/移除', async () => {
    hoisted.openFile.mockResolvedValue(['/tmp/fail.png', '/tmp/big.png', '/tmp/err.png']);
    hoisted.readFileBase64
      .mockResolvedValueOnce({ success: false, error: 'denied' })
      .mockResolvedValueOnce({ success: true, content: 'x', size: 21 * 1024 * 1024 })
      .mockRejectedValueOnce(new Error('io error'));
    el('#btnAttachImg').click();
    await new Promise((r) => setTimeout(r, 30));
    expect(el('#messagesContainer').textContent).toContain('读取 fail.png 失败');
    expect(el('#messagesContainer').textContent).toContain('超过 20MB 限制');
    expect(el('#messagesContainer').textContent).toContain('io error');

    hoisted.openFile.mockResolvedValue(['/tmp/ok.png']);
    hoisted.readFileBase64.mockResolvedValue({ success: true, content: 'ok', size: 5 });
    el('#btnAttachImg').click();
    await new Promise((r) => setTimeout(r, 20));
    (el('#imagePreview .remove-img') as HTMLElement).click();
    expect(el('#imagePreview').style.display).toBe('none');
  });

  it('图片发送时模型已不支持则阻止', async () => {
    hoisted.openFile.mockResolvedValue(['/tmp/a.png']);
    hoisted.readFileBase64.mockResolvedValue({ success: true, content: 'ok', size: 5 });
    el('#btnAttachImg').click();
    await new Promise((r) => setTimeout(r, 20));
    hoisted.isVisionAvailable.mockReturnValue(false);
    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    el<HTMLTextAreaElement>('#chatInput').value = 'x';
    await sendMessage();
    expect(el('#messagesContainer').textContent).toContain('当前模型不支持图片分析');
    expect(session.messages.length).toBe(0);
    expect(hoisted.runAgentLoop).not.toHaveBeenCalled();
  });

  it('视频：不支持/无桌面视频能力提示', async () => {
    hoisted.isVisionAvailable.mockReturnValue(false);
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#toastContainer').textContent).toContain('当前模型不支持图片/视频分析');

    hoisted.isVisionAvailable.mockReturnValue(true);
    hoisted.openFile.mockResolvedValue(['/tmp/a.mp4']);
    (window.metonaDesktop as unknown as { video: unknown }).video = undefined;
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#toastContainer').textContent).toContain('视频功能需要桌面版');
  });

  it('视频成功提取：进度更新、预览、发送帧与元数据、移除', async () => {
    hoisted.openFile.mockResolvedValue(['/tmp/a.mp4']);
    hoisted.videoExtract.mockImplementation(async () => {
      hoisted.videoProgress?.({ current: 3 });
      return {
        success: true,
        frames: [
          { name: 'f1', base64: 'frame1', timestampSeconds: 0 },
          { name: 'f2', base64: 'frame2', timestampSeconds: 1 },
        ],
        videoInfo: { duration: 2.5, width: 100, height: 100 },
      };
    });
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 30));
    expect(el('#messagesContainer').textContent).toContain('已提取 2 帧');
    expect(el('#videoPreview').style.display).toBe('');
    expect(el('#videoPreview .video-chip').textContent).toContain('a.mp4');

    const session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    el<HTMLTextAreaElement>('#chatInput').value = '分析视频';
    await sendMessage();
    const userMsg = state.get<ChatSession>(KEYS.CURRENT_SESSION)!.messages[0];
    expect((userMsg as unknown as { _videos?: unknown[] })._videos?.[0]).toEqual({
      fileName: 'a.mp4',
      frameCount: 2,
      duration: 2.5,
    });
    expect((userMsg as unknown as { _videoFrames?: unknown[] })._videoFrames?.length).toBe(2);
    expect(hoisted.runAgentLoop.mock.calls[0][1]).toEqual(['frame1', 'frame2']);
    expect(hoisted.runAgentLoop.mock.calls[0][0]).toContain('frame_count');
    expect(hoisted.runAgentLoop.mock.calls[0][0]).toContain('image_start');
  });

  it('视频提取失败与异常', async () => {
    hoisted.openFile.mockResolvedValue(['/tmp/bad.mp4']);
    hoisted.videoExtract.mockResolvedValueOnce({ success: false, error: 'bad codec' });
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#messagesContainer').textContent).toContain('视频帧提取失败: bad codec');
    expect(el('#videoPreview').style.display).toBe('none');

    hoisted.videoExtract.mockRejectedValueOnce(new Error('ffmpeg missing'));
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#messagesContainer').textContent).toContain('视频处理失败: ffmpeg missing');
    expect(hoisted.videoRemoveListener).toHaveBeenCalled();
  });

  it('视频进度原地更新聊天系统消息', async () => {
    let resolveExtract: ((v: unknown) => void) | null = null;
    hoisted.videoExtract.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExtract = resolve;
        }),
    );
    hoisted.openFile.mockResolvedValue(['/tmp/progress.mp4']);
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#videoPreview').textContent).toContain('提取中');
    hoisted.videoProgress?.({ current: 7 });
    expect(el('#videoPreview').textContent).toContain('提取中 · 7帧');
    expect(el('#messagesContainer').textContent).toContain('7 帧');
    resolveExtract!({
      success: true,
      frames: [],
      videoInfo: { duration: 0, width: 0, height: 0 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#videoPreview').style.display).toBe('');
    expect(el('#videoPreview').textContent).toContain('0帧');
  });

  it('无 bridge 时图片/文件/视频选择直接返回', async () => {
    const bridge = (window as unknown as { metonaDesktop?: unknown }).metonaDesktop;
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = undefined;
    hoisted.isVisionAvailable.mockReturnValue(true);
    el('#btnAttachImg').click();
    el('#btnAttachFile').click();
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.openFile).not.toHaveBeenCalled();
    (window as unknown as { metonaDesktop?: unknown }).metonaDesktop = bridge;
  });

  it('移除已完成视频与待处理视频', async () => {
    hoisted.openFile.mockResolvedValue(['/tmp/a.mp4']);
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 20));
    (el('#videoPreview .remove-video') as HTMLElement).click();
    expect(el('#videoPreview').style.display).toBe('none');

    let resolveExtract: ((v: unknown) => void) | null = null;
    hoisted.videoExtract.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExtract = resolve;
        }),
    );
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 10));
    (el('#videoPreview .remove-video') as HTMLElement).click();
    expect(el('#videoPreview').style.display).toBe('none');
    resolveExtract!({ success: true, frames: [], videoInfo: { duration: 0, width: 0, height: 0 } });
    await new Promise((r) => setTimeout(r, 20));
  });

  it('图片/视频单独发送时生成占位标题', async () => {
    hoisted.openFile.mockResolvedValue(['/tmp/a.png']);
    el('#btnAttachImg').click();
    await new Promise((r) => setTimeout(r, 20));
    let session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    await sendMessage();
    expect(state.get<ChatSession>(KEYS.CURRENT_SESSION)!.title).toBe('[图片消息]');

    hoisted.openFile.mockResolvedValue(['/tmp/a.mp4']);
    el('#btnAttachVideo').click();
    await new Promise((r) => setTimeout(r, 20));
    session = makeSession([], { title: '新会话' });
    state.set(KEYS.CURRENT_SESSION, session);
    const callsBefore = hoisted.runAgentLoop.mock.calls.length;
    await sendMessage();
    expect(state.get<ChatSession>(KEYS.CURRENT_SESSION)!.title).toBe('[视频消息]');
    expect(hoisted.runAgentLoop.mock.calls.length).toBe(callsBefore + 1);
  });
});

// ─────────────────────────── input-area 命令 ───────────────────────────

describe('input-area 命令', () => {
  it('/retry 参数校验与成功重试', async () => {
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'q')]));
    el<HTMLTextAreaElement>('#chatInput').value = '/retry';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('没有可重试的消息');

    state.set(KEYS.IS_STREAMING, true);
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'q'), msg('assistant', 'a')]));
    el<HTMLTextAreaElement>('#chatInput').value = '/retry';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('请先停止当前生成');
    state.set(KEYS.IS_STREAMING, false);

    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'summary', { compressed: true }), msg('assistant', 'a')]));
    el<HTMLTextAreaElement>('#chatInput').value = '/retry';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('没有找到用户消息');

    const session = makeSession([
      msg('user', 'q', {
        _fileContents: [{ name: 'a.js', language: 'javascript', content: `// c\n${'const x=1;\n'.repeat(200)}` }],
        _videoFrames: [{ name: 'f', base64: 'vf', timestampSeconds: 0 }],
      }),
      msg('assistant', 'old answer'),
    ]);
    state.set(KEYS.CURRENT_SESSION, session);
    hoisted.runAgentLoop.mockImplementation(
      async (_c: string, _i: string[], _h: unknown, cb: Record<string, (...args: never[]) => unknown>) => {
        hoisted.lastCallbacks = cb;
      },
    );
    el<HTMLTextAreaElement>('#chatInput').value = '/retry';
    await sendMessage();
    expect(session.messages.length).toBe(1);
    expect(hoisted.saveSession).toHaveBeenCalled();
    const content = hoisted.runAgentLoop.mock.calls.at(-1)![0] as string;
    expect(content).toContain('a.js');
    expect(content).not.toContain('// c');
    expect(hoisted.runAgentLoop.mock.calls.at(-1)![1]).toContain('vf');

    const cb = hoisted.lastCallbacks!;
    await cb.onNewIteration([] as never, { eval_count: 1 } as never);
    cb.onContent('retry answer' as never);
    await cb.onDone('retry final' as never, [] as never, { eval_count: 2 } as never);
    const assistant = state
      .get<ChatSession>(KEYS.CURRENT_SESSION)!
      .messages.filter((m) => m.role === 'assistant')
      .at(-1)!;
    expect(assistant.content).toBe('retry final');
  });

  it('/retry 失败显示错误并恢复状态', async () => {
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'q'), msg('assistant', 'a')]));
    hoisted.runAgentLoop.mockRejectedValueOnce(new Error('retry boom'));
    el<HTMLTextAreaElement>('#chatInput').value = '/retry';
    await sendMessage();
    expect(el('#messagesContainer').textContent).toContain('重试失败: retry boom');
    expect(state.get(KEYS.IS_STREAMING)).toBe(false);
    expect(hoisted.clearWorkingHint).toHaveBeenCalled();
  });

  it('/undo 参数校验与成功撤销', async () => {
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'q')]));
    el<HTMLTextAreaElement>('#chatInput').value = '/undo';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('没有可撤销的消息');

    state.set(KEYS.IS_STREAMING, true);
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'q'), msg('assistant', 'a')]));
    el<HTMLTextAreaElement>('#chatInput').value = '/undo';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('请先停止当前生成');
    state.set(KEYS.IS_STREAMING, false);

    state.set(KEYS.CURRENT_SESSION, makeSession([msg('assistant', 'a'), msg('assistant', 'b')]));
    el<HTMLTextAreaElement>('#chatInput').value = '/undo';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('没有找到用户消息');

    const session = makeSession([msg('user', 'q'), msg('assistant', 'a')]);
    state.set(KEYS.CURRENT_SESSION, session);
    el<HTMLTextAreaElement>('#chatInput').value = '/undo';
    await sendMessage();
    expect(session.messages.length).toBe(0);
    expect(hoisted.saveSession).toHaveBeenCalled();
    expect(el('#toastContainer').textContent).toContain('已撤销上一轮对话');
  });

  it('/compress 参数校验、成功摘要、空摘要与异常', async () => {
    state.set(KEYS.CURRENT_SESSION, makeSession([msg('user', 'q')]));
    el<HTMLTextAreaElement>('#chatInput').value = '/compress';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('消息太少，无需压缩');

    const six = Array.from({ length: 6 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`));
    state.set(KEYS.IS_STREAMING, true);
    state.set(KEYS.CURRENT_SESSION, makeSession(six));
    el<HTMLTextAreaElement>('#chatInput').value = '/compress';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('请先停止当前生成');
    state.set(KEYS.IS_STREAMING, false);

    state.set(KEYS.CURRENT_SESSION, makeSession(six));
    state.set(KEYS.API, undefined);
    el<HTMLTextAreaElement>('#chatInput').value = '/compress';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('请先选择模型');

    hoisted.getSelectedModel.mockReturnValue('');
    state.set(KEYS.API, { chatStream: vi.fn(async () => {}) });
    state.set(KEYS.CURRENT_SESSION, makeSession(six, { model: '' }));
    el<HTMLTextAreaElement>('#chatInput').value = '/compress';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('请先选择模型');
    hoisted.getSelectedModel.mockReturnValue('test-model');

    const eight = Array.from({ length: 8 }, (_, i) =>
      msg(
        i % 2 ? 'assistant' : 'user',
        i === 3 ? 'x'.repeat(600) : `m${i}`,
        i === 3 ? { toolCalls: [{ name: 'read_file' }] as ChatMessage['toolCalls'] } : {},
      ),
    );
    const session = makeSession(eight);
    state.set(KEYS.CURRENT_SESSION, session);
    const chatStream = vi.fn(async (_params: unknown, onChunk: (c: { message?: { content?: string } }) => void) => {
      onChunk({ message: { content: '摘要' } });
      onChunk({ message: { content: '内容' } });
    });
    state.set(KEYS.API, { chatStream });
    el<HTMLTextAreaElement>('#chatInput').value = '/compress';
    await sendMessage();
    expect(chatStream).toHaveBeenCalled();
    const summary = session.messages.find((m) => m.compressed)!;
    expect(summary.content).toContain('已压缩 4 条消息');
    expect(summary.content).toContain('摘要内容');
    expect(el('#toastContainer').textContent).toContain('已压缩 4 条消息为摘要');

    state.set(KEYS.CURRENT_SESSION, makeSession(eight));
    state.set(KEYS.API, { chatStream: vi.fn(async () => {}) });
    el<HTMLTextAreaElement>('#chatInput').value = '/compress';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('压缩失败：模型未返回内容');

    state.set(KEYS.CURRENT_SESSION, makeSession(eight));
    state.set(KEYS.API, { chatStream: vi.fn(async () => Promise.reject(new Error('llm down'))) });
    el<HTMLTextAreaElement>('#chatInput').value = '/compress';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('压缩失败: llm down');

    const compressedMiddle = Array.from({ length: 8 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', `m${i}`, i >= 2 && i <= 5 ? { compressed: true } : {}),
    );
    state.set(KEYS.CURRENT_SESSION, makeSession(compressedMiddle));
    el<HTMLTextAreaElement>('#chatInput').value = '/compress';
    await sendMessage();
    expect(el('#toastContainer').textContent).toContain('中间消息已全部压缩');
  });

  it('/retry 无选中模型时回退会话模型，onDone 无迭代直接入库', async () => {
    hoisted.getSelectedModel.mockReturnValue('');
    const session = makeSession([msg('user', 'q'), msg('assistant', 'a')], { model: 'fallback-model' });
    state.set(KEYS.CURRENT_SESSION, session);
    hoisted.runAgentLoop.mockImplementation(
      async (_c: string, _i: string[], _h: unknown, cb: Record<string, (...args: never[]) => unknown>) => {
        hoisted.lastCallbacks = cb;
      },
    );
    el<HTMLTextAreaElement>('#chatInput').value = '/retry';
    await sendMessage();
    expect(hoisted.runAgentLoop).toHaveBeenCalled();

    await hoisted.lastCallbacks!.onDone(
      'direct final' as never,
      [] as never,
      {
        eval_count: 1,
        prompt_eval_count: 2,
        prompt_eval_cached_count: 0,
        total_duration: 3,
      } as never,
    );
    const assistant = state
      .get<ChatSession>(KEYS.CURRENT_SESSION)!
      .messages.filter((m) => m.role === 'assistant')
      .at(-1)!;
    expect(assistant.content).toBe('direct final');
    expect(assistant.eval_count).toBe(1);
  });
});

// ─────────────────────────── history-modal ───────────────────────────

describe('history-modal', () => {
  const summaries = [
    { id: 's1', title: '会话 <1>', model: 'm1', created_at: 1, updated_at: 200, message_count: 2 },
    { id: 's2', title: '会话2', model: 'm2', created_at: 2, updated_at: 100, message_count: 3 },
  ];

  it('打开列表、排序、空状态与关闭', async () => {
    hoisted.listSessionSummaries.mockResolvedValue(summaries);
    el('#btnHistory').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#historyModal').style.display).toBe('');
    expect(hoisted.listSessionSummaries).toHaveBeenCalled();
    const items = document.querySelectorAll('#historyList .history-item');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('会话 <1>');
    expect(items[0].querySelector('.history-title')?.textContent).toBe('会话 <1>');
    expect(el('#historyPagination').textContent).toContain('共 2 条');
    el('#btnCloseHistory').click();
    expect(el('#historyModal').style.display).toBe('none');

    hoisted.listSessionSummaries.mockResolvedValue([]);
    el('#btnHistory').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#historyList').textContent).toContain('暂无历史记录');
    el('#historyModal').click();
    expect(el('#historyModal').style.display).toBe('none');
  });

  it('分页渲染、翻页与禁用按钮', async () => {
    const many = Array.from({ length: 55 }, (_, i) => ({
      id: `s${i}`,
      title: `t${i}`,
      model: 'm',
      created_at: i,
      updated_at: i,
      message_count: 1,
    }));
    hoisted.listSessionSummaries.mockResolvedValue(many);
    openHistoryModal();
    await new Promise((r) => setTimeout(r, 20));
    const pagination = el('#historyPagination');
    expect(pagination.textContent).toContain('共 55 条');
    expect(pagination.querySelectorAll('.page-btn').length).toBeGreaterThan(3);
    expect(pagination.querySelector('.page-ellipsis')).not.toBeNull();
    const page2 = pagination.querySelector('.page-btn[data-page="2"]') as HTMLElement;
    page2.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#historyPagination').querySelector('.page-btn.active')?.textContent).toBe('2');

    const calls = hoisted.listSessionSummaries.mock.calls.length;
    const disabled = el('#historyPagination').querySelector('.page-btn.disabled') as HTMLElement;
    if (disabled) disabled.click();
    expect(hoisted.listSessionSummaries.mock.calls.length).toBe(calls);
    closeHistoryModal();
  });

  it('搜索防抖、清除与无结果', async () => {
    hoisted.searchSessions.mockResolvedValue([summaries[0]]);
    openHistoryModal();
    await new Promise((r) => setTimeout(r, 20));
    const input = el<HTMLInputElement>('#historySearchInput');
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    expect(hoisted.searchSessions).toHaveBeenCalledWith('abc');
    expect(el('#historySearchClear').style.display).toBe('');
    expect(document.querySelectorAll('#historyList .history-item').length).toBe(1);

    hoisted.searchSessions.mockResolvedValue([]);
    input.value = 'none';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    expect(el('#historyList').textContent).toContain('未找到匹配的会话');

    el('#historySearchClear').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(input.value).toBe('');
    expect(el('#historySearchClear').style.display).toBe('none');
    expect(hoisted.listSessionSummaries).toHaveBeenCalled();
  });

  it('点击条目加载会话并切到历史只读视图', async () => {
    const session = makeSession([msg('user', 'history q'), msg('assistant', 'history a')], { id: 's1', title: '历史' });
    hoisted.listSessionSummaries.mockResolvedValue(summaries);
    hoisted.getSession.mockResolvedValue(session);
    openHistoryModal();
    await new Promise((r) => setTimeout(r, 20));
    (document.querySelector('#historyList .history-info') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.get(KEYS.CURRENT_SESSION)).toBe(session);
    expect(state.get(KEYS.IS_HISTORY_VIEW)).toBe(true);
    expect(hoisted.resetSavedMsgTracking).toHaveBeenCalled();
    expect(el('#historyBar').style.display).toBe('');
    expect(el('#inputArea').style.display).toBe('none');
    expect(hoisted.clearToolCardsExternal).toHaveBeenCalled();
    expect(hoisted.clearTerminalExternal).toHaveBeenCalled();
    expect(el('#messagesContainer').textContent).toContain('history q');
    expect(el('#historyModal').style.display).toBe('none');
  });

  it('会话不存在时不切换', async () => {
    hoisted.listSessionSummaries.mockResolvedValue(summaries);
    hoisted.getSession.mockResolvedValue(null);
    openHistoryModal();
    await new Promise((r) => setTimeout(r, 20));
    (document.querySelector('#historyList .history-info') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.logWarn).toHaveBeenCalledWith('会话不存在', 's1');
  });

  it('删除会话：确认、当前会话回到新会话、取消', async () => {
    const newChat = el('#btnNewChat');
    const spy = vi.fn();
    newChat.addEventListener('click', spy);
    state.set(KEYS.CURRENT_SESSION, makeSession([], { id: 's1' }));
    hoisted.listSessionSummaries.mockResolvedValue(summaries);
    openHistoryModal();
    await new Promise((r) => setTimeout(r, 20));
    (document.querySelector('#historyList .btn-delete-session') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.showConfirm).toHaveBeenCalledWith('确定删除此会话？', '删除会话');
    expect(hoisted.deleteSession).toHaveBeenCalledWith('s1');
    expect(spy).toHaveBeenCalled();

    hoisted.showConfirm.mockResolvedValueOnce(false);
    (document.querySelector('#historyList .btn-delete-session') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.deleteSession).toHaveBeenCalledTimes(1);
    newChat.removeEventListener('click', spy);
  });

  it('导出三种格式，会话不存在不导出', async () => {
    hoisted.listSessionSummaries.mockResolvedValue(summaries);
    const session = makeSession([msg('user', 'u'), msg('assistant', 'a')], { id: 's1', title: '导出' });
    hoisted.getSession.mockResolvedValue(session);
    openHistoryModal();
    await new Promise((r) => setTimeout(r, 20));
    (document.querySelector('#historyList .btn-export-md') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    (document.querySelector('#historyList .btn-export-html') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    (document.querySelector('#historyList .btn-export-txt') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.writeFile).toHaveBeenCalledTimes(3);

    hoisted.getSession.mockResolvedValue(null);
    const before = hoisted.writeFile.mock.calls.length;
    (document.querySelector('#historyList .btn-export-txt') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.writeFile.mock.calls.length).toBe(before);
  });

  it('退出历史视图触发新建会话', () => {
    const spy = vi.fn();
    el('#btnNewChat').addEventListener('click', spy);
    el('#btnExitHistory').click();
    expect(spy).toHaveBeenCalled();
  });

  it('无数据库时打开与点击安全返回', async () => {
    state.set(KEYS.DB, null);
    openHistoryModal();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#historyModal').style.display).toBe('');
    closeHistoryModal();
  });

  it('点击空白区域/分页信息/无数据库条目不处理', async () => {
    hoisted.listSessionSummaries.mockResolvedValue(summaries);
    openHistoryModal();
    await new Promise((r) => setTimeout(r, 20));
    el('#historyList').click();
    el('#historyPagination').click();
    state.set(KEYS.DB, null);
    (document.querySelector('#historyList .history-info') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el('#historyModal').style.display).toBe('');
  });

  it('无模型会话显示“无模型”，页码超出时回退第一页', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `m${i}`,
      title: `t${i}`,
      model: '',
      created_at: i,
      updated_at: i,
      message_count: 1,
    }));
    hoisted.listSessionSummaries.mockResolvedValue(many);
    openHistoryModal();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#historyList').textContent).toContain('无模型');
    (el('#historyPagination .page-btn[data-page="3"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#historyPagination').querySelector('.page-btn.active')?.textContent).toBe('3');

    hoisted.searchSessions.mockResolvedValue(many.slice(0, 5));
    const input = el<HTMLInputElement>('#historySearchInput');
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    expect(document.querySelectorAll('#historyList .history-item').length).toBe(5);
    expect(el('#historyPagination').querySelectorAll('.page-btn').length).toBe(0);
    closeHistoryModal();
  });
});

// ─────────────────────────── keybind-manager ───────────────────────────

describe('keybind-manager', () => {
  function resetModals(): void {
    [
      'settingsModal',
      'historyModal',
      'helpModal',
      'toolsModal',
      'tokenDashboardModal',
      'toolConfirmModal',
      'searxngModal',
      'memoryModal',
    ].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.style.display = 'none';
    });
  }

  beforeEach(() => {
    resetModals();
    state.set(KEYS.ABORT_CONTROLLER, null);
    hoisted.showConfirm.mockResolvedValue(true);
    el('#logPanel').style.display = '';
    el('#searchBar').style.display = 'none';
    el('#btnSend').classList.remove('disabled');
  });

  it('Esc 关闭模态框、记忆面板与工具确认', () => {
    resetModals();
    el('#settingsModal').style.display = '';
    el('#memoryModal').style.display = '';
    el('#toolConfirmModal').style.display = '';
    const closeSpy = vi.fn();
    const cancelSpy = vi.fn();
    el('#btnCloseSettings').addEventListener('click', closeSpy);
    el('#toolCancelBtn').addEventListener('click', cancelSpy);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
    expect(el('#memoryModal').style.display).toBe('none');
    expect(cancelSpy).toHaveBeenCalled();
    el('#btnCloseSettings').removeEventListener('click', closeSpy);
    el('#toolCancelBtn').removeEventListener('click', cancelSpy);
  });

  it('Esc 关闭搜索栏', () => {
    el('#searchBar').style.display = '';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el('#searchBar').style.display).toBe('none');
  });

  it('Ctrl+Shift+Backspace 中止 Agent 或提示无任务', () => {
    const abort = { abort: vi.fn() };
    state.set(KEYS.ABORT_CONTROLLER, abort);
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(abort.abort).toHaveBeenCalled();
    expect(hoisted.logInfo).toHaveBeenCalledWith('快捷键中止 Agent');

    state.set(KEYS.ABORT_CONTROLLER, null);
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(el('#toastContainer').textContent).toContain('当前没有正在运行的 Agent');
  });

  it('Ctrl+Shift+L 切换日志面板', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(el('#logPanel').style.display).toBe('none');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(el('#logPanel').style.display).toBe('');
  });

  it('模态框打开时只响应 Ctrl+, 并关闭设置', () => {
    el('#settingsModal').style.display = '';
    const newChatSpy = vi.fn();
    const closeSpy = vi.fn();
    el('#btnNewChat').addEventListener('click', newChatSpy);
    el('#btnCloseSettings').addEventListener('click', closeSpy);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
    expect(newChatSpy).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
    el('#btnNewChat').removeEventListener('click', newChatSpy);
    el('#btnCloseSettings').removeEventListener('click', closeSpy);
  });

  it('模态框打开时 Ctrl+, 打开设置（设置未打开时）', () => {
    resetModals();
    el('#helpModal').style.display = '';
    const settingsSpy = vi.fn();
    el('#btnSettings').addEventListener('click', settingsSpy);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
    expect(settingsSpy).toHaveBeenCalled();
    el('#btnSettings').removeEventListener('click', settingsSpy);
  });

  it('普通快捷键：新建、发送、聚焦、搜索、记忆、历史、设置', () => {
    const newChatSpy = vi.fn();
    const sendSpy = vi.fn();
    const focusSpy = vi.fn();
    const searchSpy = vi.fn();
    const memorySpy = vi.fn();
    const historySpy = vi.fn();
    const settingsSpy = vi.fn();
    el('#btnNewChat').addEventListener('click', newChatSpy);
    el('#btnSend').addEventListener('click', sendSpy);
    el('#chatInput').addEventListener('focus', focusSpy);
    el('#btnSearch').addEventListener('click', searchSpy);
    el('#btnMemory').addEventListener('click', memorySpy);
    el('#btnHistory').addEventListener('click', historySpy);
    el('#btnSettings').addEventListener('click', settingsSpy);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
    expect(newChatSpy).toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(sendSpy).toHaveBeenCalled();
    el('#btnSend').classList.add('disabled');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    el('#btnSend').classList.remove('disabled');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }));
    expect(focusSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(searchSpy).toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true }));
    expect(memorySpy).toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true }));
    expect(historySpy).toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
    expect(settingsSpy).toHaveBeenCalled();

    el('#btnNewChat').removeEventListener('click', newChatSpy);
    el('#btnSend').removeEventListener('click', sendSpy);
    el('#chatInput').removeEventListener('focus', focusSpy);
    el('#btnSearch').removeEventListener('click', searchSpy);
    el('#btnMemory').removeEventListener('click', memorySpy);
    el('#btnHistory').removeEventListener('click', historySpy);
    el('#btnSettings').removeEventListener('click', settingsSpy);
  });

  it('Ctrl+L 清空对话：确认/取消', async () => {
    const newChatSpy = vi.fn();
    el('#btnNewChat').addEventListener('click', newChatSpy);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.showConfirm).toHaveBeenCalledWith('确定清空当前对话？此操作不可恢复！', '清空对话');
    expect(newChatSpy).toHaveBeenCalled();
    expect(el('#toastContainer').textContent).toContain('对话已清空');

    hoisted.showConfirm.mockResolvedValueOnce(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(newChatSpy).toHaveBeenCalledTimes(1);
    el('#btnNewChat').removeEventListener('click', newChatSpy);
  });

  it('metaKey 组合同样生效，非 Ctrl 忽略', () => {
    const newChatSpy = vi.fn();
    el('#btnNewChat').addEventListener('click', newChatSpy);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    expect(newChatSpy).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }));
    expect(newChatSpy).toHaveBeenCalled();
    el('#btnNewChat').removeEventListener('click', newChatSpy);
  });

  it('getKeybindsByCategory 按分类分组', () => {
    const grouped = getKeybindsByCategory();
    expect(grouped.chat.length).toBeGreaterThan(0);
    expect(grouped.navigation.length).toBeGreaterThan(0);
    expect(grouped.system.length).toBeGreaterThan(0);
    expect(grouped.agent[0].keys).toBe('Ctrl+Shift+Backspace');
  });
});
