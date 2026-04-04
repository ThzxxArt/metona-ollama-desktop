/**
 * ModelBar - 模型选择栏组件
 * 包含模型下拉选择、Think 能力检测、模型信息展示
 */

import { state, KEYS } from '../state.js';
import { formatSize } from '../utils.js';

let modelSelectEl, badgeThinkEl, badgeVisionEl, thinkCheckbox, thinkWrap, btnAttachImg;

/** 缓存模型能力 { modelName: { think: bool, vision: bool } } */
const modelCapabilityCache = new Map();

export function initModelBar() {
    modelSelectEl = document.querySelector('#modelSelect');
    badgeThinkEl = document.querySelector('#badgeThink');
    badgeVisionEl = document.querySelector('#badgeVision');
    thinkCheckbox = document.querySelector('#toggleThink');
    thinkWrap = document.querySelector('#thinkToggleWrap');
    btnAttachImg = document.querySelector('#btnAttachImg');

    // 模型切换 → 检测能力 + 保存设置
    modelSelectEl.addEventListener('change', async () => {
        const model = modelSelectEl.value;
        if (db()) await db().saveSetting('selectedModel', model);
        state.set('_defaultModel', model);
        const session = state.get(KEYS.CURRENT_SESSION);
        if (session) session.model = model;
        if (model) {
            await checkModelCapability(model);
        } else {
            setThinkAvailable(false);
            setVisionAvailable(false);
            badgeThinkEl.style.display = 'none';
            badgeVisionEl.style.display = 'none';
        }
    });
}

function db() { return state.get(KEYS.DB); }
function api() { return state.get(KEYS.API); }

/**
 * 加载模型列表
 */
export async function loadModels() {
    if (!api()) return;

    try {
        const data = await api().listModels();
        modelSelectEl.innerHTML = '';

        if (!data.models || data.models.length === 0) {
            modelSelectEl.innerHTML = '<option value="">未安装任何模型</option>';
            badgeThinkEl.style.display = 'none'; badgeVisionEl.style.display = 'none';
            setThinkAvailable(false); setVisionAvailable(false);
            return;
        }

        data.models
            .sort((a, b) => {
                const nameA = a.name.toLowerCase(), nameB = b.name.toLowerCase();
                if (nameA !== nameB) return nameA.localeCompare(nameB);
                return (a.size || 0) - (b.size || 0);
            })
            .forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.name;
                const diskSize = formatSize(m.size);
                const label = diskSize ? `${m.name} · ${diskSize}` : m.name;
                opt.textContent = label;
                modelSelectEl.appendChild(opt);
            });

        // 恢复默认选中模型
        const defaultModel = state.get('_defaultModel', '');
        if (defaultModel) {
            modelSelectEl.value = defaultModel;
        }

        // 检测当前选中模型的能力
        if (modelSelectEl.value) {
            await checkModelCapability(modelSelectEl.value);
        }
    } catch (err) {
        console.error('[ModelBar] 加载模型失败:', err);
        modelSelectEl.innerHTML = '<option value="">加载失败 - 检查连接</option>';
        badgeThinkEl.style.display = 'none'; badgeVisionEl.style.display = 'none';
        setThinkAvailable(false); setVisionAvailable(false);
    }
}

/**
 * 调用 /api/show 检测模型能力
 * @param {string} modelName
 */
async function checkModelCapability(modelName) {
    // 命中缓存
    if (modelCapabilityCache.has(modelName)) {
        applyCapability(modelName, modelCapabilityCache.get(modelName));
        return;
    }

    if (!api()) return;

    try {
        const info = await api().showModel(modelName);
        const capabilities = info.capabilities || [];
        const caps = {
            think: capabilities.includes('thinking'),
            vision: capabilities.includes('vision'),
            completion: capabilities.includes('completion'),
        };
        modelCapabilityCache.set(modelName, caps);
        applyCapability(modelName, caps);
    } catch (err) {
        console.warn('[ModelBar] 获取模型能力失败:', err);
        // 降级：不支持 think
        const fallback = { think: false, vision: false, completion: true };
        modelCapabilityCache.set(modelName, fallback);
        applyCapability(modelName, fallback);
    }
}

/**
 * 根据能力设置 UI 状态
 */
function applyCapability(modelName, caps) {
    setThinkAvailable(caps.think);
    setVisionAvailable(caps.vision);

    // 更新能力标签
    badgeThinkEl.style.display = caps.think ? '' : 'none';
    badgeVisionEl.style.display = caps.vision ? '' : 'none';
}

/**
 * 设置 Think 开关是否可用
 */
function setThinkAvailable(available) {
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

/**
 * 设置图片上传按钮是否可用
 */
function setVisionAvailable(available) {
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

/**
 * 当前选择的模型是否支持视觉分析
 */
export function isVisionAvailable() {
    return btnAttachImg && !btnAttachImg.disabled;
}

/**
 * 获取当前选择的模型
 */
export function getSelectedModel() {
    return modelSelectEl.value;
}

/**
 * 设置选中的模型
 */
export function setSelectedModel(modelName) {
    modelSelectEl.value = modelName;
}

/**
 * Think 模式是否开启
 */
export function isThinkEnabled() {
    return thinkCheckbox.checked && !thinkCheckbox.disabled;
}
