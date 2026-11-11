/**
 * ModelBar - 模型选择栏组件
 */

import { state, KEYS } from '../state/state.js';
import type { ChatSession } from '../types.js';
import { formatSize } from '../utils/utils.js';
import { OllamaAPI } from '../api/ollama.js';
import { ChatDB } from '../db/chat-db.js';
import { logModel, logDebug, logError, logWarn } from '../services/log-service.js';
import type { OllamaModelDetail, ModelCaps } from '../types.js';

let modelSelectEl: HTMLSelectElement;
let badgeThinkEl: HTMLElement;
let badgeVisionEl: HTMLElement;
let badgeToolsEl: HTMLElement;
let thinkSelect: HTMLSelectElement;
let thinkWrap: HTMLElement;
let btnAttachImg: HTMLButtonElement;
let btnAttachVideo: HTMLButtonElement;

const modelCapabilityCache = new Map<string, ModelCaps>();

export function initModelBar(): void {
  modelSelectEl = document.querySelector('#modelSelect')!;
  badgeThinkEl = document.querySelector('#badgeThink')!;
  badgeVisionEl = document.querySelector('#badgeVision')!;
  badgeToolsEl = document.querySelector('#badgeTools')!;
  thinkSelect = document.querySelector('#selectThinkLevel')!;
  thinkWrap = thinkSelect;
  btnAttachImg = document.querySelector('#btnAttachImg')!;
  btnAttachVideo = document.querySelector('#btnAttachVideo')!;

  // Think 档位：off / low / medium / high
  thinkSelect.addEventListener('change', () => {
    const level = thinkSelect.value;
    state.set('thinkLevel', level);
    state.set('thinkEnabled', level !== 'off');
    logDebug(`Think 档位: ${level}`);
  });

  modelSelectEl.addEventListener('change', async () => {
    const model = modelSelectEl.value;
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) await db.saveSetting('selectedModel', model);
    state.set('_defaultModel', model);
    state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => (session ? { ...session, model } : session));
    if (model) {
      logModel(model, '切换');
      await checkModelCapability(model);
    } else {
      setThinkAvailable(false);
      setVisionAvailable(false);
      badgeThinkEl.style.display = 'none';
      badgeVisionEl.style.display = 'none';
      badgeToolsEl.style.display = 'none';
      state.set('modelSupportsTools', false);
    }
  });
}

export async function loadModels(): Promise<void> {
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  try {
    const data = await api.listModels();
    modelSelectEl.innerHTML = '';

    if (!data.models || data.models.length === 0) {
      const savedModel = state.get<string>('_defaultModel', '');
      const provider = state.get<{ provider?: string } | null>('connection', null)?.provider;
      if (savedModel && provider && provider !== 'ollama') {
        modelSelectEl.innerHTML = '';
        const option = document.createElement('option');
        option.value = savedModel;
        option.textContent = `${savedModel}（自定义）`;
        modelSelectEl.appendChild(option);
        modelSelectEl.value = savedModel;
        await checkModelCapability(savedModel);
        return;
      }
      modelSelectEl.innerHTML = '<option value="">未获取到模型（可在设置中手动填写）</option>';
      badgeThinkEl.style.display = 'none';
      badgeVisionEl.style.display = 'none';
      setThinkAvailable(false);
      setVisionAvailable(false);
      logWarn('未获取到模型列表');
      return;
    }

    logModel(`${data.models.length} 个模型`, '加载列表');

    data.models
      .sort((a, b) => {
        const nameA = a.name.toLowerCase(),
          nameB = b.name.toLowerCase();
        if (nameA !== nameB) return nameA.localeCompare(nameB);
        return (a.size || 0) - (b.size || 0);
      })
      .forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.dataset.size = String(m.size || 0);
        if (m.remote_model || m.remote_host) {
          opt.dataset.remoteHost = m.remote_host || 'ollama.com';
          opt.dataset.remoteModel = m.remote_model || '';
        }
        const diskSize = formatSize(m.size || 0);
        const cloud = m.remote_model || m.remote_host ? ' ☁️' : '';
        opt.textContent = (diskSize ? `${m.name} · ${diskSize}` : m.name) + cloud;
        modelSelectEl.appendChild(opt);
      });

    const defaultModel = state.get<string>('_defaultModel', '');
    if (defaultModel) modelSelectEl.value = defaultModel;

    if (modelSelectEl.value) {
      await checkModelCapability(modelSelectEl.value);
    }

    await filterEmbedModels(data.models);
  } catch (err) {
    logError('加载模型列表失败', (err as Error).message);
    modelSelectEl.innerHTML = '<option value="">加载失败 - 检查连接</option>';
    badgeThinkEl.style.display = 'none';
    badgeVisionEl.style.display = 'none';
    setThinkAvailable(false);
    setVisionAvailable(false);
  }
}

/** 根据能力为下拉框选项添加图标标记 + 模型自身上下文长度 */
function updateOptionIcons(): void {
  for (const opt of Array.from(modelSelectEl.options)) {
    const caps = modelCapabilityCache.get(opt.value);
    if (!caps) continue;
    const diskSize = opt.dataset.size ? formatSize(parseInt(opt.dataset.size)) : '';
    const base = diskSize ? `${opt.value} · ${diskSize}` : opt.value;
    const icons: string[] = [];
    if (opt.dataset.remoteHost) icons.push('☁️');
    if (caps.think) icons.push('🧠');
    if (caps.vision) icons.push('👁️');
    if (caps.tools) icons.push('🔧');
    // 显示模型自身的上下文长度
    const modelCtx = caps.contextLength > 0 ? ` [${formatCtxLen(caps.contextLength)}]` : '';
    opt.textContent = `${base}${modelCtx}${icons.length > 0 ? '  ' + icons.join('') : ''}`;
  }
}

async function filterEmbedModels(models: Array<{ name: string }>): Promise<void> {
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  for (const m of models) {
    try {
      const info = await api.showModel(m.name);
      const caps = info.capabilities || [];
      const isCompletion = caps.includes('completion');

      // 从 model_info 提取上下文长度（仅用于显示，不再覆盖用户设置）
      let contextLength = 2048;
      for (const key of Object.keys(info.model_info || {})) {
        if (key.endsWith('.context_length')) {
          contextLength = Number(info.model_info![key]) || 2048;
          break;
        }
      }

      modelCapabilityCache.set(m.name, {
        think: caps.includes('thinking'),
        vision: caps.includes('vision'),
        tools: caps.includes('tools'),
        completion: isCompletion,
        contextLength,
      });
      if (!isCompletion) {
        const opt = modelSelectEl.querySelector(`option[value="${CSS.escape(m.name)}"]`);
        if (opt) opt.remove();
        logDebug(`模型 ${m.name} 不是 completion 模型，已移除`);
      }
    } catch {
      /* ignore */
    }
  }

  updateOptionIcons();

  if (!modelSelectEl.value && modelSelectEl.options.length > 0) {
    modelSelectEl.value = modelSelectEl.options[0].value;
    state.set('_defaultModel', modelSelectEl.value);
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) await db.saveSetting('selectedModel', modelSelectEl.value);
    await checkModelCapability(modelSelectEl.value);
  }
}

async function checkModelCapability(modelName: string): Promise<void> {
  if (modelCapabilityCache.has(modelName)) {
    const cached = modelCapabilityCache.get(modelName)!;
    applyCapability(modelName, cached);
    return;
  }

  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  try {
    const info = await api.showModel(modelName);
    const capabilities = info.capabilities || [];

    // 从 model_info 中提取模型实际上下文长度
    let contextLength = 2048; // 默认保守值
    const modelInfo = info.model_info || {};
    for (const key of Object.keys(modelInfo)) {
      if (key.endsWith('.context_length')) {
        contextLength = Number(modelInfo[key]) || 2048;
        break;
      }
    }

    const caps: ModelCaps = {
      think: capabilities.includes('thinking'),
      vision: capabilities.includes('vision'),
      tools: capabilities.includes('tools'),
      completion: capabilities.includes('completion'),
      contextLength,
    };
    modelCapabilityCache.set(modelName, caps);
    logDebug(`能力检测: ${modelName}`, `ctx: ${contextLength}, ` + capabilities.join(', '));

    applyCapability(modelName, caps);
  } catch (err) {
    logWarn(`能力检测失败: ${modelName}`, (err as Error).message);
    const fallback: ModelCaps = { think: false, vision: false, tools: false, completion: true, contextLength: 2048 };
    modelCapabilityCache.set(modelName, fallback);
    applyCapability(modelName, fallback);
  }
}

function applyCapability(_modelName: string, caps: { think: boolean; vision: boolean; tools: boolean }): void {
  setThinkAvailable(caps.think);
  setVisionAvailable(caps.vision);
  badgeThinkEl.style.display = caps.think ? '' : 'none';
  badgeVisionEl.style.display = caps.vision ? '' : 'none';
  badgeToolsEl.style.display = caps.tools ? '' : 'none';
  state.set('modelSupportsTools', caps.tools);
}

function setThinkAvailable(available: boolean): void {
  if (available) {
    thinkSelect.disabled = false;
    const current = state.get<string>('thinkLevel', 'off');
    thinkSelect.value = current === 'low' || current === 'medium' || current === 'high' ? current : 'off';
    state.set('thinkEnabled', thinkSelect.value !== 'off');
    thinkWrap.title = 'Think 档位：low / medium / high';
    thinkWrap.classList.remove('unavailable');
  } else {
    thinkSelect.value = 'off';
    thinkSelect.disabled = true;
    state.set('thinkLevel', 'off');
    state.set('thinkEnabled', false);
    thinkWrap.title = '当前模型不支持 Think 模式';
    thinkWrap.classList.add('unavailable');
  }
}

function setVisionAvailable(available: boolean): void {
  if (!btnAttachImg) return;
  if (available) {
    btnAttachImg.disabled = false;
    btnAttachImg.title = '上传图片';
    btnAttachImg.classList.remove('disabled');
    if (btnAttachVideo) {
      btnAttachVideo.disabled = false;
      btnAttachVideo.title = '上传视频（提取帧分析）';
      btnAttachVideo.classList.remove('disabled');
    }
  } else {
    btnAttachImg.disabled = true;
    btnAttachImg.title = '当前模型不支持图片分析';
    btnAttachImg.classList.add('disabled');
    if (btnAttachVideo) {
      btnAttachVideo.disabled = true;
      btnAttachVideo.title = '当前模型不支持图片/视频分析';
      btnAttachVideo.classList.add('disabled');
    }
  }
}

export function isVisionAvailable(): boolean {
  return btnAttachImg && !btnAttachImg.disabled;
}

export function getSelectedModel(): string {
  return modelSelectEl.value;
}

export function setSelectedModel(modelName: string): void {
  modelSelectEl.value = modelName;
  modelSelectEl.dispatchEvent(new Event('change'));
}

export function isThinkEnabled(): boolean {
  return thinkSelect.value !== 'off' && !thinkSelect.disabled;
}

/** 当前 Think 档位（供请求体使用） */
export function getThinkLevel(): false | 'low' | 'medium' | 'high' {
  if (thinkSelect.disabled || thinkSelect.value === 'off') return false;
  return thinkSelect.value as 'low' | 'medium' | 'high';
}

/** 检查当前选中的模型是否支持 Tool Calling */
export function isToolCallingSupported(): boolean {
  const model = modelSelectEl?.value;
  if (!model) return false;
  const caps = modelCapabilityCache.get(model);
  return caps?.tools === true;
}

export function clearModelCapabilityCache(): void {
  modelCapabilityCache.clear();
}

export function formatCtxLen(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
  return String(n);
}

/** 获取当前选中模型自身支持的上下文长度 */
export function getModelContextLength(): number {
  const model = modelSelectEl?.value;
  if (!model) return 0;
  const caps = modelCapabilityCache.get(model);
  return caps?.contextLength || 0;
}

/** 获取当前选中模型的名称 */
export function getCurrentModelName(): string {
  return modelSelectEl?.value || '';
}

/** 获取有效的上下文长度：min(模型支持值, 用户设置值) */
export function getEffectiveNumCtx(): number {
  const userCtx = state.get<number>(KEYS.NUM_CTX, 131072);
  const modelCtx = getModelContextLength();
  if (modelCtx > 0 && modelCtx < userCtx) {
    return modelCtx;
  }
  return userCtx;
}
