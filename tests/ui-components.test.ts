// @vitest-environment jsdom
/**
 * UI 组件测试（核心）：toast / lightbox / header / model-bar /
 * prompt-modal / tool-confirm-modal / tools-modal
 *
 * 全部通过真实 DOM 事件驱动，断言可观察的 DOM 结果与 bridge 调用参数。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const noop = () => {};

const hoisted = vi.hoisted(() => ({
  logConnection: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logModel: vi.fn(),
  logWarn: vi.fn(),
  logSession: vi.fn(),
  logSetting: vi.fn(),
  logSuccess: vi.fn(),
  logToolStart: vi.fn(),
  logToolResult: vi.fn(),
  logThink: vi.fn(),
  logStream: vi.fn(),
  logMemory: vi.fn(),
  logRAG: vi.fn(),
  logInit: vi.fn(),
  logAgentLoop: vi.fn(),
  logModelResponse: vi.fn(),
  resetStreamProgress: vi.fn(),
  logStreamProgress: vi.fn(),
  resetVideoProgress: vi.fn(),
  updateVideoProgress: vi.fn(),
  addLog: vi.fn(),
  initLogPanel: vi.fn(),
  setToolMode: vi.fn(),
  saveSetting: vi.fn(async () => {}),
}));

vi.mock('../src/renderer/services/log-service.js', () => ({
  logConnection: hoisted.logConnection,
  logError: hoisted.logError,
  logDebug: hoisted.logDebug,
  logInfo: hoisted.logInfo,
  logModel: hoisted.logModel,
  logWarn: hoisted.logWarn,
  logSession: hoisted.logSession,
  logSetting: hoisted.logSetting,
  logSuccess: hoisted.logSuccess,
  logToolStart: hoisted.logToolStart,
  logToolResult: hoisted.logToolResult,
  logThink: hoisted.logThink,
  logStream: hoisted.logStream,
  logMemory: hoisted.logMemory,
  logRAG: hoisted.logRAG,
  logInit: hoisted.logInit,
  logAgentLoop: hoisted.logAgentLoop,
  logModelResponse: hoisted.logModelResponse,
  resetStreamProgress: hoisted.resetStreamProgress,
  logStreamProgress: hoisted.logStreamProgress,
  resetVideoProgress: hoisted.resetVideoProgress,
  updateVideoProgress: hoisted.updateVideoProgress,
  addLog: hoisted.addLog,
  initLogPanel: hoisted.initLogPanel,
}));

vi.mock('../src/renderer/services/tool-registry.js', () => ({
  TOOL_DEFINITIONS: [
    { function: { name: 'read_file', description: '读取文件的长描述' } },
    { function: { name: 'write_file', description: '写入文件的长描述' } },
    { function: { name: 'custom_tool', description: '自定义工具描述'.repeat(30) } },
  ],
  MODE_TOOLS: ['read_file', 'write_file'],
  setToolMode: hoisted.setToolMode,
  getToolIcon: (name: string) => (name === 'read_file' ? '📄' : '🔧'),
  formatToolName: (name: string) => (name === 'read_file' ? '读取文件' : name),
  getEnabledToolDefinitions: () => [],
}));

import { initToast, showToast } from '../src/renderer/components/toast.js';
import { initLightbox, openLightbox, closeLightbox } from '../src/renderer/components/lightbox.js';
import {
  initHeader,
  checkConnection,
  updateConnectionInfo,
  updateRunningModels,
} from '../src/renderer/components/header.js';
import {
  initModelBar,
  loadModels,
  clearModelCapabilityCache,
  getSelectedModel,
  setSelectedModel,
  isThinkEnabled,
  getThinkLevel,
  isToolCallingSupported,
  getModelContextLength,
  getCurrentModelName,
  getEffectiveNumCtx,
  isVisionAvailable,
  formatCtxLen,
} from '../src/renderer/components/model-bar.js';
import { showPrompt, showConfirm, showHtmlConfirm } from '../src/renderer/components/prompt-modal.js';
import { initToolConfirmModal, showToolConfirm } from '../src/renderer/components/tool-confirm-modal.js';
import { initToolsModal, openToolsModal, closeToolsModal } from '../src/renderer/components/tools-modal.js';
import { state, KEYS } from '../src/renderer/state/state.js';
import type { ToolCall } from '../src/renderer/types.js';

let bodyHtml = '';

function el<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}

function makeApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getVersion: vi.fn(async () => ({ version: '0.40.16' })),
    listModels: vi.fn(async () => ({ models: [] })),
    showModel: vi.fn(async () => ({ capabilities: [], model_info: {} })),
    psModels: vi.fn(async () => ({ models: [] })),
    unloadModels: vi.fn(async () => ({ success: true, unloaded: 0 })),
    ...overrides,
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { function: { name, arguments: args } } as unknown as ToolCall;
}

beforeAll(() => {
  bodyHtml = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf-8');
  document.body.innerHTML = bodyHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';

  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: noop,
    removeEventListener: noop,
  }) as unknown as typeof window.matchMedia;
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame;
  window.scrollTo = noop;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
    escape: (s: string) => s.replace(/["\\]/g, '\\$&'),
  };

  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = {
    isDesktop: true,
    dialog: { openFile: vi.fn(async () => null), saveFile: vi.fn(async () => null) },
    fs: { writeFile: vi.fn(async () => ({ success: true })) },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  clearModelCapabilityCache();
  document.querySelectorAll('#toastContainer .toast').forEach((n) => n.remove());
  el('#lightbox').style.display = 'none';
  el('#settingsModal').style.display = 'none';
  el('#toolsModal').style.display = 'none';
  el('#toolConfirmModal').style.display = 'none';
  state.set(KEYS.DB, { saveSetting: hoisted.saveSetting } as never);
  state.set(KEYS.API, makeApi() as never);
  state.set(KEYS.CURRENT_SESSION, null);
  state.set(KEYS.NUM_CTX, 131072);
  state.set('_defaultModel', '');
  state.set('thinkLevel', 'off');
  state.set('thinkEnabled', false);
  state.set('modelSupportsTools', false);
  state.set('globalToolMode', 'confirm');
  state.set('connection', { mode: 'local' });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────── Toast ───────────────────────────

describe('toast', () => {
  it('渲染消息、图标与类型，duration 后进入移除动画', () => {
    vi.useFakeTimers();
    initToast();
    showToast('保存成功', 'success', 100);
    const toast = el('#toastContainer .toast');
    expect(toast.className).toContain('success');
    expect(toast.textContent).toBe('✓保存成功');
    vi.advanceTimersByTime(100);
    expect(toast.classList.contains('removing')).toBe(true);
    toast.dispatchEvent(new Event('animationend'));
    expect(document.querySelector('#toastContainer .toast')).toBeNull();
  });

  it('未知类型回退 info 图标，消息按纯文本渲染', () => {
    initToast();
    showToast('<img src=x onerror=alert(1)>', 'mystery' as never);
    const toast = el('#toastContainer .toast');
    expect(toast.querySelector('.toast-icon')?.textContent).toBe('ℹ');
    expect(toast.querySelectorAll('img').length).toBe(0);
    expect(toast.textContent).toContain('<img');
  });

  it('容器不存在时静默忽略', () => {
    const container = el('#toastContainer');
    container.remove();
    initToast();
    expect(() => showToast('x')).not.toThrow();
    document.body.appendChild(container);
    initToast();
  });
});

// ─────────────────────────── Lightbox ───────────────────────────

describe('lightbox', () => {
  beforeAll(() => initLightbox());

  it('open/close 切换显示与图片地址', () => {
    openLightbox('data:image/png;base64,abc');
    expect(el('#lightbox').style.display).toBe('');
    expect(el<HTMLImageElement>('#lightboxImg').src).toContain('data:image/png;base64,abc');
    closeLightbox();
    expect(el('#lightbox').style.display).toBe('none');
    expect(el<HTMLImageElement>('#lightboxImg').getAttribute('src')).toBe('');
  });

  it('点击遮罩或关闭按钮关闭', () => {
    openLightbox('data:image/png;base64,x');
    el('#lightbox').click();
    expect(el('#lightbox').style.display).toBe('none');
    openLightbox('data:image/png;base64,y');
    el('#lightboxClose').click();
    expect(el('#lightbox').style.display).toBe('none');
  });

  it('点击带 data-lightbox 的消息图片打开预览', () => {
    const img = document.createElement('img');
    img.dataset.lightbox = 'true';
    img.src = 'data:image/png;base64,msg';
    el('#messagesContainer').appendChild(img);
    img.click();
    expect(el('#lightbox').style.display).toBe('');
    expect(el<HTMLImageElement>('#lightboxImg').src).toContain('msg');
    img.remove();
  });

  it('点击普通图片不打开预览', () => {
    closeLightbox();
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,plain';
    el('#messagesContainer').appendChild(img);
    img.click();
    expect(el('#lightbox').style.display).toBe('none');
    img.remove();
  });
});

// ─────────────────────────── Header ───────────────────────────

describe('header', () => {
  beforeAll(() => initHeader());

  it('checkConnection 成功更新状态与标题', async () => {
    const result = await checkConnection();
    expect(result.ok).toBe(true);
    expect(el('#connStatus').className).toBe('conn-status connected');
    expect(el('#connStatus .status-label').textContent).toBe('已连接');
    expect(el('#connStatus').title).toContain('0.40.16');
    expect(hoisted.logConnection).toHaveBeenCalledWith('connected', 'Ollama v0.40.16');
  });

  it('checkConnection 失败显示未连接', async () => {
    state.set(KEYS.API, makeApi({ getVersion: vi.fn(async () => Promise.reject(new Error('down'))) }) as never);
    const result = await checkConnection();
    expect(result.ok).toBe(false);
    expect(el('#connStatus').className).toBe('conn-status disconnected');
    expect(el('#connStatus .status-label').textContent).toBe('未连接');
    expect(hoisted.logConnection).toHaveBeenCalledWith('disconnected', 'down');
  });

  it('checkConnection 无 API 返回错误且不修改 DOM', async () => {
    state.set(KEYS.API, undefined);
    const before = el('#connStatus').className;
    const result = await checkConnection();
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('API 未初始化');
    expect(el('#connStatus').className).toBe(before);
  });

  it('updateConnectionInfo 成功显示版本与本地/云端/远程标签', async () => {
    await updateConnectionInfo();
    expect(el('#connBadge').textContent).toBe('✓ 已连接 · 本地');
    expect(el('#connBadge').className).toBe('status-badge success');
    expect(el('#serverVersion').textContent).toBe('v0.40.16');

    state.set('connection', { mode: 'remote', remoteKind: 'cloud' });
    await updateConnectionInfo();
    expect(el('#connBadge').textContent).toContain('云端');

    state.set('connection', { mode: 'remote', remoteKind: 'self-hosted' });
    await updateConnectionInfo();
    expect(el('#connBadge').textContent).toContain('远程');
  });

  it('updateConnectionInfo 失败与无 API', async () => {
    state.set(KEYS.API, makeApi({ getVersion: vi.fn(async () => Promise.reject(new Error('offline'))) }) as never);
    await updateConnectionInfo();
    expect(el('#connBadge').textContent).toBe('✗ 未连接');
    expect(el('#connBadge').className).toBe('status-badge error');
    expect(hoisted.logError).toHaveBeenCalledWith('连接检测失败', 'offline');

    state.set(KEYS.API, undefined);
    await updateConnectionInfo();
    expect(el('#connBadge').textContent).toBe('✗ 未连接');
  });

  it('updateRunningModels 渲染模型、空列表与错误', async () => {
    state.set(
      KEYS.API,
      makeApi({
        psModels: vi.fn(async () => ({
          models: [
            { name: 'qwen3:8b', size_vram: 2048, context_length: 32768 },
            { name: 'llama3', size_vram: 0 },
          ],
        })),
      }) as never,
    );
    await updateRunningModels();
    expect(el('#runningModels').innerHTML).toContain('qwen3:8b');
    expect(el('#runningModels').innerHTML).toContain('32K ctx');
    expect(el('#runningModels').innerHTML).toContain('llama3');

    state.set(KEYS.API, makeApi({ psModels: vi.fn(async () => ({ models: [] })) }) as never);
    await updateRunningModels();
    expect(el('#runningModels').textContent).toContain('无运行中的模型');

    state.set(KEYS.API, makeApi({ psModels: vi.fn(async () => Promise.reject(new Error('x'))) }) as never);
    await updateRunningModels();
    expect(el('#runningModels').textContent).toContain('无法获取运行信息');

    state.set(KEYS.API, undefined);
    await updateRunningModels();
    expect(el('#runningModels').textContent).toContain('无法获取运行信息');
  });
});

// ─────────────────────────── ModelBar ───────────────────────────

describe('model-bar', () => {
  beforeAll(() => initModelBar());

  it('loadModels 渲染排序、大小、云端标记、能力图标与上下文', async () => {
    state.set('_defaultModel', 'a-model');
    state.set('thinkLevel', 'medium');
    state.set(
      KEYS.API,
      makeApi({
        listModels: vi.fn(async () => ({
          models: [
            { name: 'b-model', size: 2048 },
            { name: 'a-model', size: 1024 },
            { name: 'cloud-model', size: 0, remote_model: 'x', remote_host: 'ollama.com' },
          ],
        })),
        showModel: vi.fn(async (name: string) => {
          if (name === 'a-model') {
            return {
              capabilities: ['completion', 'thinking', 'vision', 'tools'],
              model_info: { 'a-model.context_length': 32768 },
            };
          }
          if (name === 'b-model') return { capabilities: ['completion'], model_info: {} };
          return { capabilities: ['completion'], model_info: {} };
        }),
      }) as never,
    );

    await loadModels();

    const select = el<HTMLSelectElement>('#modelSelect');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['a-model', 'b-model', 'cloud-model']);
    expect(select.value).toBe('a-model');
    const aText = select.options[0].textContent || '';
    expect(aText).toContain('1.0 KB');
    expect(aText).toContain('[32K]');
    expect(aText).toContain('🧠');
    expect(aText).toContain('👁️');
    expect(aText).toContain('🔧');
    expect(select.options[2].textContent).toContain('☁️');

    expect(el('#badgeThink').style.display).toBe('');
    expect(el('#badgeVision').style.display).toBe('');
    expect(el('#badgeTools').style.display).toBe('');
    const think = el<HTMLSelectElement>('#selectThinkLevel');
    expect(think.disabled).toBe(false);
    expect(think.value).toBe('medium');
    expect(isThinkEnabled()).toBe(true);
    expect(getThinkLevel()).toBe('medium');
    expect(isToolCallingSupported()).toBe(true);
    expect(isVisionAvailable()).toBe(true);
    expect(getModelContextLength()).toBe(32768);
    expect(getCurrentModelName()).toBe('a-model');
    expect(getSelectedModel()).toBe('a-model');
    // 用户设置优先，不再被模型标称上限钳制
    expect(getEffectiveNumCtx()).toBe(131072);
    state.set(KEYS.NUM_CTX, 65536);
    expect(getEffectiveNumCtx()).toBe(65536);
    state.set(KEYS.NUM_CTX, 1024);
    expect(getEffectiveNumCtx()).toBe(1024);
  });

  it('loadModels 空列表与加载失败显示占位', async () => {
    state.set(KEYS.API, makeApi({ listModels: vi.fn(async () => ({ models: [] })) }) as never);
    await loadModels();
    expect(el('#modelSelect').textContent).toContain('未获取到模型');
    expect(el('#badgeThink').style.display).toBe('none');
    expect(el('#badgeVision').style.display).toBe('none');

    state.set(KEYS.API, makeApi({ listModels: vi.fn(async () => Promise.reject(new Error('net'))) }) as never);
    await loadModels();
    expect(el('#modelSelect').textContent).toContain('加载失败 - 检查连接');
    expect(hoisted.logError).toHaveBeenCalledWith('加载模型列表失败', 'net');
  });

  it('loadModels 无 API 时直接返回', async () => {
    state.set(KEYS.API, undefined);
    await expect(loadModels()).resolves.toBeUndefined();
  });

  it('能力检测失败使用保守回退', async () => {
    state.set(
      KEYS.API,
      makeApi({
        listModels: vi.fn(async () => ({ models: [{ name: 'bad-model', size: 1 }] })),
        showModel: vi.fn(async () => Promise.reject(new Error('no info'))),
      }) as never,
    );
    state.set('_defaultModel', 'bad-model');
    await loadModels();
    expect(el('#badgeThink').style.display).toBe('none');
    expect(el('#badgeVision').style.display).toBe('none');
    expect(isToolCallingSupported()).toBe(false);
    expect(hoisted.logWarn).toHaveBeenCalledWith('能力检测失败: bad-model', 'no info');
  });

  it('过滤后无选中值时自动选中首个并持久化', async () => {
    // 首项 value 为空字符串且默认模型不匹配 → 过滤后 options 非空但 value 仍为空，
    // 触发 filterEmbedModels 末尾的自动选中/持久化分支
    state.set('_defaultModel', 'missing-model');
    state.set(
      KEYS.API,
      makeApi({
        listModels: vi.fn(async () => ({
          models: [
            { name: '', size: 1 },
            { name: 'chat', size: 2 },
          ],
        })),
        showModel: vi.fn(async (name: string) => ({
          capabilities: ['completion'],
          model_info: {},
        })),
      }) as never,
    );
    await loadModels();
    const select = el<HTMLSelectElement>('#modelSelect');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'chat']);
    expect(hoisted.saveSetting).toHaveBeenCalledWith('selectedModel', '');
  });

  it('非 completion 模型从选项移除', async () => {
    state.set('_defaultModel', '');
    state.set(
      KEYS.API,
      makeApi({
        listModels: vi.fn(async () => ({
          models: [
            { name: 'embed', size: 1 },
            { name: 'chat', size: 2 },
          ],
        })),
        showModel: vi.fn(async (name: string) => ({
          capabilities: name === 'chat' ? ['completion'] : ['embedding'],
          model_info: {},
        })),
      }) as never,
    );
    await loadModels();
    const select = el<HTMLSelectElement>('#modelSelect');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['chat']);
    expect(hoisted.logDebug).toHaveBeenCalledWith('模型 embed 不是 completion 模型，已移除');
  });

  it('模型切换保存设置并更新当前会话，空值清空能力', async () => {
    state.set(KEYS.CURRENT_SESSION, { id: 's', model: 'old', messages: [] });
    state.set(
      KEYS.API,
      makeApi({
        showModel: vi.fn(async () => ({ capabilities: ['completion', 'tools'], model_info: {} })),
      }) as never,
    );
    el<HTMLSelectElement>('#modelSelect').innerHTML =
      '<option value="new-model">new</option><option value="">none</option>';
    el<HTMLSelectElement>('#modelSelect').value = 'new-model';
    el<HTMLSelectElement>('#modelSelect').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.saveSetting).toHaveBeenCalledWith('selectedModel', 'new-model');
    expect(state.get<{ model: string }>(KEYS.CURRENT_SESSION)?.model).toBe('new-model');
    expect(state.get('_defaultModel')).toBe('new-model');
    expect(el('#badgeTools').style.display).toBe('');

    el<HTMLSelectElement>('#modelSelect').value = '';
    el<HTMLSelectElement>('#modelSelect').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.get('modelSupportsTools')).toBe(false);
    expect(el('#badgeThink').style.display).toBe('none');
    expect(el('#badgeVision').style.display).toBe('none');
    expect(el('#badgeTools').style.display).toBe('none');
  });

  it('think 下拉切换写入状态', () => {
    const think = el<HTMLSelectElement>('#selectThinkLevel');
    expect(think.querySelector('option[value="max"]')).not.toBeNull();
    think.value = 'high';
    think.dispatchEvent(new Event('change'));
    expect(state.get('thinkLevel')).toBe('high');
    expect(state.get('thinkEnabled')).toBe(true);
    think.value = 'max';
    think.dispatchEvent(new Event('change'));
    expect(state.get('thinkLevel')).toBe('max');
    expect(state.get('thinkEnabled')).toBe(true);
    think.value = 'off';
    think.dispatchEvent(new Event('change'));
    expect(state.get('thinkEnabled')).toBe(false);
  });

  it('setSelectedModel 触发 change 并更新会话', async () => {
    state.set(KEYS.CURRENT_SESSION, { id: 's', model: 'old', messages: [] });
    state.set(
      KEYS.API,
      makeApi({ showModel: vi.fn(async () => ({ capabilities: ['completion'], model_info: {} })) }) as never,
    );
    el<HTMLSelectElement>('#modelSelect').innerHTML = '<option value="x">x</option>';
    setSelectedModel('x');
    await new Promise((r) => setTimeout(r, 10));
    expect(getSelectedModel()).toBe('x');
    expect(state.get<{ model: string }>(KEYS.CURRENT_SESSION)?.model).toBe('x');
  });

  it('formatCtxLen 三种量级', () => {
    expect(formatCtxLen(1048576)).toBe('1M');
    expect(formatCtxLen(32768)).toBe('32K');
    expect(formatCtxLen(512)).toBe('512');
  });

  it('同名模型按大小排序，缺省 capabilities/model_info 使用空值', async () => {
    state.set('_defaultModel', '');
    state.set(
      KEYS.API,
      makeApi({
        listModels: vi.fn(async () => ({
          models: [
            { name: 'same', size: 2048 },
            { name: 'same', size: 1024 },
          ],
        })),
        showModel: vi.fn(async () => ({ capabilities: ['completion'] })),
      }) as never,
    );
    await loadModels();
    const sizes = Array.from(el<HTMLSelectElement>('#modelSelect').options).map((o) => o.dataset.size);
    expect(sizes).toEqual(['1024', '2048']);
    expect(el('#badgeThink').style.display).toBe('none');
  });

  it('API 缺失时切换模型/能力检查安全返回', async () => {
    state.set(KEYS.API, undefined);
    el<HTMLSelectElement>('#modelSelect').innerHTML = '<option value="m">m</option>';
    el<HTMLSelectElement>('#modelSelect').value = 'm';
    el<HTMLSelectElement>('#modelSelect').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.get('_defaultModel')).toBe('m');
  });

  it('空选择时 getter 返回安全默认值', () => {
    el<HTMLSelectElement>('#modelSelect').innerHTML = '<option value="">无</option>';
    el<HTMLSelectElement>('#modelSelect').value = '';
    expect(isToolCallingSupported()).toBe(false);
    expect(getModelContextLength()).toBe(0);
    expect(getCurrentModelName()).toBe('');
    expect(getSelectedModel()).toBe('');
    state.set(KEYS.NUM_CTX, 131072);
    expect(getEffectiveNumCtx()).toBe(131072);
  });

  it('think low 档位恢复与缓存上下文', async () => {
    state.set('thinkLevel', 'low');
    state.set(
      KEYS.API,
      makeApi({
        listModels: vi.fn(async () => ({ models: [{ name: 'low-model', size: 1 }] })),
        showModel: vi.fn(async () => ({
          capabilities: ['completion', 'thinking'],
          model_info: { 'low-model.context_length': 8192 },
        })),
      }) as never,
    );
    state.set('_defaultModel', 'low-model');
    await loadModels();
    expect(el<HTMLSelectElement>('#selectThinkLevel').value).toBe('low');
    expect(getThinkLevel()).toBe('low');
    state.set(KEYS.NUM_CTX, 4096);
    expect(getEffectiveNumCtx()).toBe(4096);
    state.set(KEYS.NUM_CTX, 16384);
    expect(getEffectiveNumCtx()).toBe(16384);
  });
});

// ─────────────────────────── PromptModal ───────────────────────────

describe('prompt-modal', () => {
  it('showPrompt 文本输入：确定返回值', async () => {
    const p = showPrompt({ title: '重命名', message: '请输入 <名称>', defaultValue: 'abc', placeholder: '名称' });
    const input = el<HTMLInputElement>('#promptInput');
    expect(input.value).toBe('abc');
    expect(el('#promptTitle').textContent).toBe('重命名');
    expect(el('#promptBody').textContent).toContain('<名称>');
    input.value = 'new-name';
    el('#promptOk').click();
    await expect(p).resolves.toBe('new-name');
    expect(el('#promptModal').style.display).toBe('none');
  });

  it('showPrompt 取消/遮罩/Escape 返回 null', async () => {
    let p = showPrompt({ title: 'a' });
    el('#promptCancel').click();
    await expect(p).resolves.toBeNull();

    p = showPrompt({ title: 'b' });
    el('#promptModal').click();
    await expect(p).resolves.toBeNull();

    p = showPrompt({ title: 'c' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  it('showPrompt Enter 确认，textarea 中 Enter 不关闭', async () => {
    let p = showPrompt({ title: 'a', defaultValue: 'v' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p).resolves.toBe('v');

    p = showPrompt({ title: 'b', type: 'textarea', defaultValue: 'line1' });
    const textarea = el<HTMLTextAreaElement>('#promptInput');
    textarea.value = 'line1\nline2';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el('#promptModal').style.display).toBe('');
    el('#promptOk').click();
    await expect(p).resolves.toBe('line1\nline2');
  });

  it('showPrompt select/password 类型与默认选中', async () => {
    let p = showPrompt({
      title: '选择',
      type: 'select',
      defaultValue: 'b',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const select = el<HTMLSelectElement>('#promptInput');
    expect(select.value).toBe('b');
    select.value = 'a';
    el('#promptOk').click();
    await expect(p).resolves.toBe('a');

    p = showPrompt({ title: '密码', type: 'password', defaultValue: 'secret' });
    const password = el<HTMLInputElement>('#promptInput');
    expect(password.type).toBe('password');
    el('#promptOk').click();
    await expect(p).resolves.toBe('secret');
  });

  it('showPrompt 聚焦与全选（input/textarea）', async () => {
    vi.useFakeTimers();
    let p = showPrompt({ title: 'a', defaultValue: 'abc' });
    const input = el<HTMLInputElement>('#promptInput');
    const focusSpy = vi.spyOn(input, 'focus');
    const selectSpy = vi.spyOn(input, 'select');
    vi.advanceTimersByTime(60);
    expect(focusSpy).toHaveBeenCalled();
    expect(selectSpy).toHaveBeenCalled();
    el('#promptOk').click();
    await p;

    p = showPrompt({ title: 'b', type: 'textarea' });
    const textarea = el<HTMLTextAreaElement>('#promptInput');
    const taFocus = vi.spyOn(textarea, 'focus');
    vi.advanceTimersByTime(60);
    expect(taFocus).toHaveBeenCalled();
    el('#promptOk').click();
    await p;
  });

  it('showConfirm 返回 true/false', async () => {
    let p = showConfirm('确定删除？', '删除');
    expect(el('#promptTitle').textContent).toBe('删除');
    expect(el('#promptBody').textContent).toContain('确定删除？');
    el('#promptOk').click();
    await expect(p).resolves.toBe(true);

    p = showConfirm('确定？');
    el('#promptCancel').click();
    await expect(p).resolves.toBe(false);
  });

  it('showHtmlConfirm 宽屏模式设置尺寸与按钮文案', async () => {
    const p = showHtmlConfirm('<b>危险命令</b>', '确认执行', true);
    const modal = el('#promptModal .modal') as HTMLElement;
    expect(modal.style.maxWidth).toBe('640px');
    expect(modal.style.maxHeight).toBe('85vh');
    expect(el('#promptOk').textContent).toBe('✅ 批准执行');
    expect(el('#promptBody').innerHTML).toContain('<b>危险命令</b>');
    el('#promptOk').click();
    await expect(p).resolves.toBe(true);

    const p2 = showHtmlConfirm('<i>x</i>');
    expect((el('#promptModal .modal') as HTMLElement).style.maxWidth).toBe('420px');
    el('#promptCancel').click();
    await expect(p2).resolves.toBe(false);
  });
});

// ─────────────────────────── ToolConfirmModal ───────────────────────────

describe('tool-confirm-modal', () => {
  it('模态框不存在时直接返回 false', async () => {
    const modal = el('#toolConfirmModal');
    modal.remove();
    await expect(showToolConfirm(toolCall('read_file', { path: 'a.txt' }))).resolves.toBe(false);
    document.body.appendChild(modal);
  });

  it('懒加载初始化并渲染 read_file 路径', async () => {
    const p = showToolConfirm(toolCall('read_file', { path: 'src/index.ts' }));
    expect(el('#toolConfirmModal').style.display).toBe('');
    expect(el('#toolConfirmTitle').textContent).toContain('确认操作');
    expect(el('#toolConfirmTitle').textContent).toContain('读取文件');
    expect(el('#toolConfirmBody').textContent).toContain('src/index.ts');
    el('#toolConfirmBtn').click();
    await expect(p).resolves.toBe(true);
    expect(el('#toolConfirmModal').style.display).toBe('none');
  });

  it('paths 批量、run_command、write_file 内容预览与转义', async () => {
    initToolConfirmModal();
    let p = showToolConfirm(toolCall('delete_file', { paths: ['a.txt', '<b>.txt'] }));
    expect(el('#toolConfirmBody').textContent).toContain('路径（2 项）');
    expect(el('#toolConfirmBody').textContent).toContain('a.txt');
    expect(el('#toolConfirmBody').querySelector('b')).toBeNull();
    el('#toolCancelBtn').click();
    await expect(p).resolves.toBe(false);

    p = showToolConfirm(toolCall('run_command', { command: 'echo hi' }));
    expect(el('#toolConfirmBody').textContent).toContain('命令：');
    expect(el('#toolConfirmBody').textContent).toContain('echo hi');
    el('#toolConfirmBtn').click();
    await p;

    p = showToolConfirm(toolCall('write_file', { path: 'a', content: 'x'.repeat(600) }));
    expect(el('#toolConfirmBody').textContent).toContain('内容预览');
    expect(el('#toolConfirmBody').textContent).toContain('...');
    el('#toolConfirmBtn').click();
    await p;
  });

  it('队列逐个确认并显示剩余数量', async () => {
    initToolConfirmModal();
    const p1 = showToolConfirm(toolCall('read_file', { path: '1' }));
    const p2 = showToolConfirm(toolCall('read_file', { path: '2' }));
    const p3 = showToolConfirm(toolCall('read_file', { path: '3' }));
    el('#toolConfirmBtn').click();
    await expect(p1).resolves.toBe(true);
    expect(el('#toolConfirmBody').textContent).toContain('路径：');
    expect(el('#toolConfirmBody').textContent).toContain('2');
    expect(el('#toolConfirmBody').textContent).toContain('队列中还有 1 个待确认');
    el('#toolCancelBtn').click();
    await expect(p2).resolves.toBe(false);
    expect(el('#toolConfirmBody').textContent).toContain('3');
    el('#toolCancelBtn').click();
    await expect(p3).resolves.toBe(false);
  });

  it('点击遮罩取消当前请求', async () => {
    initToolConfirmModal();
    const p = showToolConfirm(toolCall('run_command', { command: 'rm x' }));
    el('#toolConfirmModal').click();
    await expect(p).resolves.toBe(false);
  });

  it('空闲时点击遮罩不报错，空 paths/小内容/无命令分支', async () => {
    initToolConfirmModal();
    el('#toolConfirmModal').click();
    expect(el('#toolConfirmModal').style.display).toBe('none');

    let p = showToolConfirm(toolCall('read_file', { paths: [] }));
    expect(el('#toolConfirmBody').textContent).not.toContain('路径');
    el('#toolConfirmBtn').click();
    await p;

    p = showToolConfirm(toolCall('read_file', { paths: 'not-array' }));
    el('#toolConfirmBtn').click();
    await p;

    p = showToolConfirm(toolCall('write_file', { path: 'a', content: 'short' }));
    expect(el('#toolConfirmBody').textContent).not.toContain('...');
    el('#toolConfirmBtn').click();
    await p;

    p = showToolConfirm(toolCall('run_command', {}));
    expect(el('#toolConfirmBody').textContent).not.toContain('命令：');
    el('#toolConfirmBtn').click();
    await p;

    p = showToolConfirm(toolCall('file_transfer', { path: 'x' }));
    expect(el('#toolConfirmBody').textContent).toContain('路径：');
    el('#toolConfirmBtn').click();
    await p;
  });
});

// ─────────────────────────── ToolsModal ───────────────────────────

describe('tools-modal', () => {
  beforeAll(() => initToolsModal());

  it('初始化渲染工具卡片与说明回退', () => {
    const cards = document.querySelectorAll('#toolsGrid .tool-card');
    expect(cards.length).toBe(3);
    expect(el('#toolsGrid').textContent).toContain('read_file');
    expect(el('#toolsGrid').textContent).toContain('读取文本/二进制文件');
    const custom = document.querySelector('#toolsGrid .tool-card[data-tool="custom_tool"] .tool-card-desc');
    expect(custom?.textContent?.length).toBeLessThanOrEqual(120);
    expect(custom?.textContent).toContain('自定义工具描述');
  });

  it('打开时同步全局模式，切换模式更新徽章并持久化', async () => {
    state.set('globalToolMode', 'auto');
    openToolsModal();
    expect(el('#toolsModal').style.display).toBe('');
    const select = el<HTMLSelectElement>('#select_global_tool_mode');
    expect(select.value).toBe('auto');
    const managedBadge = document.querySelector('#toolsGrid .tool-card[data-tool="read_file"] .tool-card-badge');
    expect(managedBadge?.textContent).toBe('自动');

    select.value = 'confirm';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.setToolMode).toHaveBeenCalledWith('read_file', 'confirm');
    expect(hoisted.setToolMode).toHaveBeenCalledWith('write_file', 'confirm');
    expect(hoisted.saveSetting).toHaveBeenCalledWith('globalToolMode', 'confirm');
    expect(state.get('globalToolMode')).toBe('confirm');
    expect(managedBadge?.textContent).toBe('需确认');
    expect(el('#toastContainer').textContent).toContain('工具执行模式：需确认');
  });

  it('关闭按钮与遮罩关闭', () => {
    openToolsModal();
    el('#btnCloseTools').click();
    expect(el('#toolsModal').style.display).toBe('none');
    openToolsModal();
    el('#toolsModal').click();
    expect(el('#toolsModal').style.display).toBe('none');
    closeToolsModal();
    expect(el('#toolsModal').style.display).toBe('none');
  });

  it('缺少 grid/select 或 DB 时安全返回', async () => {
    state.set(KEYS.DB, null);
    const select = el<HTMLSelectElement>('#select_global_tool_mode');
    select.value = 'auto';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));

    el('#toolsGrid').remove();
    openToolsModal();
    el('#select_global_tool_mode').remove();
    initToolsModal();
    openToolsModal();
    expect(el('#toolsModal').style.display).toBe('');
  });
});
