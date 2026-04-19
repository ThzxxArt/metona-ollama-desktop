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
let thinkCheckbox: HTMLInputElement;
let thinkWrap: HTMLElement;
let btnAttachImg: HTMLButtonElement;

const modelCapabilityCache = new Map<string, ModelCaps>();

export function initModelBar(): void {
  modelSelectEl = document.querySelector('#modelSelect')!;
  badgeThinkEl = document.querySelector('#badgeThink')!;
  badgeVisionEl = document.querySelector('#badgeVision')!;
  badgeToolsEl = document.querySelector('#badgeTools')!;
  thinkCheckbox = document.querySelector('#toggleThink')!;
  thinkWrap = document.querySelector('#thinkToggleWrap')!;
  btnAttachImg = document.querySelector('#btnAttachImg')!;

  modelSelectEl.addEventListener('change', async () => {
    const model = modelSelectEl.value;
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) await db.saveSetting('selectedModel', model);
    state.set('_defaultModel', model);
    state.update(KEYS.CURRENT_SESSION, (session: ChatSession | null) => session ? ({ ...session, model }) : session);
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
      modelSelectEl.innerHTML = '<option value="">未安装任何模型</option>';
      badgeThinkEl.style.display = 'none'; badgeVisionEl.style.display = 'none';
      setThinkAvailable(false); setVisionAvailable(false);
      logWarn('未检测到已安装模型');
      return;
    }

    logModel(`${data.models.length} 个模型`, '加载列表');

    data.models
      .sort((a, b) => {
        const nameA = a.name.toLowerCase(), nameB = b.name.toLowerCase();
        if (nameA !== nameB) return nameA.localeCompare(nameB);
        return (a.size || 0) - (b.size || 0);
      })
      .forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.dataset.size = String(m.size || 0);
        const diskSize = formatSize(m.size || 0);
        opt.textContent = diskSize ? `${m.name} · ${diskSize}` : m.name;
        modelSelectEl.appendChild(opt);
      });

    const defaultModel = state.get<string>('_defaultModel', '');
    if (defaultModel) modelSelectEl.value = defaultModel;

    if (modelSelectEl.value) {
      await checkModelCapability(modelSelectEl.value);
    }

    filterEmbedModels(data.models);
  } catch (err) {
    logError('加载模型列表失败', (err as Error).message);
    modelSelectEl.innerHTML = '<option value="">加载失败 - 检查连接</option>';
    badgeThinkEl.style.display = 'none'; badgeVisionEl.style.display = 'none';
    setThinkAvailable(false); setVisionAvailable(false);
  }
}

/** 根据能力为下拉框选项添加图标标记 */
function updateOptionIcons(): void {
  for (const opt of Array.from(modelSelectEl.options)) {
    const caps = modelCapabilityCache.get(opt.value);
    if (!caps) continue;
    const diskSize = opt.dataset.size ? formatSize(parseInt(opt.dataset.size)) : '';
    const base = diskSize ? `${opt.value} · ${diskSize}` : opt.value;
    const icons: string[] = [];
    if (caps.think) icons.push('🧠');
    if (caps.vision) icons.push('👁️');
    if (caps.tools) icons.push('🔧');
    opt.textContent = icons.length > 0 ? `${base}  ${icons.join('')}` : base;
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
      modelCapabilityCache.set(m.name, {
        think: caps.includes('thinking'),
        vision: caps.includes('vision'),
        tools: caps.includes('tools'),
        completion: isCompletion,
      });
      if (!isCompletion) {
        const opt = modelSelectEl.querySelector(`option[value="${CSS.escape(m.name)}"]`);
        if (opt) opt.remove();
        logDebug(`模型 ${m.name} 不是 completion 模型，已移除`);
      }
    } catch { /* ignore */ }
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
    applyCapability(modelName, modelCapabilityCache.get(modelName)!);
    return;
  }

  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  try {
    const info = await api.showModel(modelName);
    const capabilities = info.capabilities || [];
    const caps = {
      think: capabilities.includes('thinking'),
      vision: capabilities.includes('vision'),
      tools: capabilities.includes('tools'),
      completion: capabilities.includes('completion'),
    };
    modelCapabilityCache.set(modelName, caps);
    logDebug(`能力检测: ${modelName}`, capabilities.join(', '));
    applyCapability(modelName, caps);
  } catch (err) {
    logWarn(`能力检测失败: ${modelName}`, (err as Error).message);
    const fallback = { think: false, vision: false, tools: false, completion: true };
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
    thinkCheckbox.disabled = false;
    thinkWrap.title = 'Think 模式：启用深度推理';
    thinkWrap.classList.remove('unavailable');
  } else {
    thinkCheckbox.checked = false;
    thinkCheckbox.disabled = true;
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
  } else {
    btnAttachImg.disabled = true;
    btnAttachImg.title = '当前模型不支持图片分析';
    btnAttachImg.classList.add('disabled');
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
  return thinkCheckbox.checked && !thinkCheckbox.disabled;
}

/** 检查当前选中的模型是否支持 Tool Calling */
export function isToolCallingSupported(): boolean {
  const model = modelSelectEl?.value;
  if (!model) return false;
  const caps = modelCapabilityCache.get(model);
  return caps?.tools === true;
}
