/**
 * PresetManager - Agent 预设管理
 *
 * 预设数据结构:
 * {
 *   id: string,
 *   name: string,          // 预设名称，如 "翻译官"
 *   icon: string,          // emoji 图标
 *   systemPrompt: string,  // 系统提示词
 *   temperature: number,   // 温度 (0~2)
 *   numCtx: number,        // 上下文长度
 *   think: boolean,        // Think 开关
 *   createdAt: number,
 *   updatedAt: number,
 * }
 */

import { state, KEYS } from './state.js';
import { generateId } from './utils.js';

const PRESETS_KEY = 'agentPresets';
const ACTIVE_PRESET_KEY = 'activePresetId';

// ── 内置预设 ──
const BUILT_IN_PRESETS = [
    {
        id: '_default',
        name: '默认',
        icon: '💬',
        systemPrompt: '',
        temperature: 0.7,
        numCtx: 24576,
        think: false,
        builtIn: true,
        createdAt: 0,
        updatedAt: 0
    },
    {
        id: '_translator',
        name: '翻译官',
        icon: '🌐',
        systemPrompt: '你是一位专业翻译官。你的任务是将用户输入的内容准确翻译为目标语言。\n\n规则：\n1. 自动识别源语言，翻译为用户指定的目标语言（如未指定则翻译为中文）\n2. 保持原文的格式、语气和风格\n3. 专有名词保留原文并给出通用译名\n4. 对于有多种含义的词语，结合上下文选择最合适的翻译\n5. 直接输出翻译结果，不需要额外解释（除非用户要求）',
        temperature: 0.3,
        numCtx: 16384,
        think: false,
        builtIn: true,
        createdAt: 0,
        updatedAt: 0
    },
    {
        id: '_code_review',
        name: '代码审查',
        icon: '🔍',
        systemPrompt: '你是一位资深代码审查专家。对用户提交的代码进行全面审查。\n\n审查维度：\n1. **Bug 与逻辑错误** — 潜在的运行时错误、边界条件、空指针等\n2. **安全性** — SQL注入、XSS、敏感信息泄露等安全隐患\n3. **性能** — 时间/空间复杂度、不必要的计算、内存泄漏\n4. **可读性** — 命名规范、代码结构、注释质量\n5. **最佳实践** — 设计模式、语言惯用法、框架约定\n\n输出格式：\n- 按严重程度排列问题（严重 → 轻微）\n- 每个问题给出：位置、问题描述、修复建议、改进后的代码\n- 最后给出整体评价和改进建议',
        temperature: 0.2,
        numCtx: 32768,
        think: true,
        builtIn: true,
        createdAt: 0,
        updatedAt: 0
    },
    {
        id: '_writer',
        name: '写作助手',
        icon: '✍️',
        systemPrompt: '你是一位才华横溢的写作助手。擅长多种文体和写作风格。\n\n能力范围：\n1. 文章撰写 — 议论文、说明文、散文、故事\n2. 文案创作 — 广告文案、产品描述、社交媒体文案\n3. 内容润色 — 修改语法、优化措辞、提升表达力\n4. 风格调整 — 正式/口语/文艺/简洁等多种风格\n5. 创意写作 — 小说、诗歌、剧本、对话\n\n工作方式：\n- 仔细理解用户的写作需求（读者、用途、风格偏好）\n- 如需信息不全，主动询问确认\n- 提供多种版本供选择\n- 解释重要的写作决策',
        temperature: 0.9,
        numCtx: 24576,
        think: false,
        builtIn: true,
        createdAt: 0,
        updatedAt: 0
    },
    {
        id: '_analyst',
        name: '数据分析师',
        icon: '📊',
        systemPrompt: '你是一位专业的数据分析师。擅长从数据中提取洞察并给出可执行的建议。\n\n分析方法：\n1. 数据概览 — 数据量、字段类型、缺失值、异常值\n2. 统计分析 — 描述性统计、相关性分析、趋势分析\n3. 可视化建议 — 推荐合适的图表类型和展示方式\n4. 洞察提取 — 关键发现、模式识别、因果推断\n5. 行动建议 — 基于数据的具体可执行建议\n\n输出格式：\n- 先给出核心结论（Executive Summary）\n- 再展开详细分析过程\n- 使用表格和列表组织数据\n- 给出代码（Python/SQL）时附带注释',
        temperature: 0.4,
        numCtx: 32768,
        think: true,
        builtIn: true,
        createdAt: 0,
        updatedAt: 0
    },
    {
        id: '_tutor',
        name: '学习导师',
        icon: '🎓',
        systemPrompt: '你是一位耐心且善于启发的学习导师。用苏格拉底式教学法帮助用户深入理解知识。\n\n教学原则：\n1. **先问后答** — 通过引导性问题帮助用户自己找到答案\n2. **由浅入深** — 从基础概念开始，逐步构建知识体系\n3. **类比教学** — 用生活中的类比解释抽象概念\n4. **实践导向** — 每个知识点配一个动手练习\n5. **鼓励探索** — 提供延伸阅读方向和思考题\n\n当用户提问时：\n- 先评估用户当前理解水平\n- 用引导性问题帮助思考\n- 如果用户确实卡住，再给出答案并解释思路\n- 每个概念学完后给出一个小练习',
        temperature: 0.6,
        numCtx: 24576,
        think: true,
        builtIn: true,
        createdAt: 0,
        updatedAt: 0
    }
];

let presets = [];
let activePresetId = null;

/**
 * 初始化预设管理器
 */
export async function initPresetManager() {
    const db = state.get(KEYS.DB);

    // 从 DB 加载用户自定义预设
    let userPresets = [];
    if (db) {
        userPresets = await db.getSetting(PRESETS_KEY, []);
    }

    // 合并：内置 + 用户自定义
    presets = [...BUILT_IN_PRESETS, ...userPresets];

    // 加载上次激活的预设
    if (db) {
        activePresetId = await db.getSetting(ACTIVE_PRESET_KEY, '_default');
    } else {
        activePresetId = '_default';
    }

    // 写入 state
    state.set('presets', presets);
    state.set('activePresetId', activePresetId);

    // 应用当前预设（恢复设置）
    const activePreset = presets.find(p => p.id === activePresetId);
    if (activePreset && activePreset.id !== '_default') {
        applyPresetToState(activePreset, false); // 不再 DB，已在 init 阶段加载
    }
}

/**
 * 获取所有预设
 */
export function getPresets() {
    return presets;
}

/**
 * 获取当前激活预设
 */
export function getActivePreset() {
    return presets.find(p => p.id === activePresetId) || presets[0];
}

/**
 * 获取当前激活预设 ID
 */
export function getActivePresetId() {
    return activePresetId;
}

/**
 * 激活预设
 */
export async function activatePreset(presetId) {
    const preset = presets.find(p => p.id === presetId);
    if (!preset) return;

    activePresetId = presetId;
    state.set('activePresetId', presetId);

    applyPresetToState(preset, true);

    const db = state.get(KEYS.DB);
    if (db) {
        await db.saveSetting(ACTIVE_PRESET_KEY, presetId);
    }
}

/**
 * 将预设配置应用到全局 state
 */
function applyPresetToState(preset, saveToDb) {
    const db = state.get(KEYS.DB);

    // 系统提示词
    if (preset.systemPrompt) {
        state.set(KEYS.SYSTEM_PROMPT_ENABLED, true);
        state.set(KEYS.SYSTEM_PROMPT, preset.systemPrompt);
    } else {
        state.set(KEYS.SYSTEM_PROMPT_ENABLED, false);
        state.set(KEYS.SYSTEM_PROMPT, '');
    }

    // 上下文长度
    if (preset.numCtx) {
        state.set(KEYS.NUM_CTX, preset.numCtx);
    }

    // 温度（存储到 state，聊天时使用）
    state.set('temperature', preset.temperature ?? 0.7);

    // Think 开关
    state.set('thinkEnabled', preset.think ?? false);

    // 同步到 UI
    syncPresetToUI(preset);

    // 持久化
    if (saveToDb && db) {
        db.saveSetting('systemPromptEnabled', preset.systemPrompt ? true : false);
        db.saveSetting('systemPrompt', preset.systemPrompt || '');
        db.saveSetting('numCtx', preset.numCtx || 24576);
        db.saveSetting('temperature', preset.temperature ?? 0.7);
    }
}

/**
 * 将预设配置同步到设置面板 UI
 */
function syncPresetToUI(preset) {
    // 系统提示词
    const toggleSP = document.querySelector('#toggleSystemPrompt');
    const inputSP = document.querySelector('#inputSystemPrompt');
    if (toggleSP) toggleSP.checked = !!preset.systemPrompt;
    if (inputSP) {
        inputSP.disabled = !preset.systemPrompt;
        inputSP.value = preset.systemPrompt || '';
    }

    // numCtx
    const inputCtx = document.querySelector('#inputNumCtx');
    if (inputCtx) inputCtx.value = preset.numCtx || 24576;

    // Temperature
    const tempSlider = document.querySelector('#inputTemperature');
    const tempDisplay = document.querySelector('#tempValue');
    if (tempSlider) tempSlider.value = preset.temperature ?? 0.7;
    if (tempDisplay) tempDisplay.textContent = (preset.temperature ?? 0.7).toFixed(1);

    // Think toggle
    const thinkCheckbox = document.querySelector('#toggleThink');
    if (thinkCheckbox) {
        thinkCheckbox.checked = preset.think ?? false;
        // 触发 change 事件让 model-bar 响应
        thinkCheckbox.dispatchEvent(new Event('change'));
    }
}

/**
 * 创建预设
 */
export async function createPreset({ name, icon, systemPrompt, temperature, numCtx, think }) {
    const preset = {
        id: `preset_${generateId()}`,
        name: name || '新预设',
        icon: icon || '🤖',
        systemPrompt: systemPrompt || '',
        temperature: temperature ?? 0.7,
        numCtx: numCtx ?? 24576,
        think: think ?? false,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    presets.push(preset);
    state.set('presets', [...presets]);

    await saveUserPresets();
    return preset;
}

/**
 * 更新预设
 */
export async function updatePreset(presetId, updates) {
    const idx = presets.findIndex(p => p.id === presetId);
    if (idx === -1) return;

    // 内置预设不允许修改
    if (presets[idx].builtIn) return;

    presets[idx] = { ...presets[idx], ...updates, updatedAt: Date.now() };
    state.set('presets', [...presets]);

    // 如果更新的是当前激活预设，重新应用
    if (activePresetId === presetId) {
        applyPresetToState(presets[idx], true);
    }

    await saveUserPresets();
}

/**
 * 删除预设
 */
export async function deletePreset(presetId) {
    const idx = presets.findIndex(p => p.id === presetId);
    if (idx === -1) return;
    if (presets[idx].builtIn) return; // 内置不可删

    presets.splice(idx, 1);
    state.set('presets', [...presets]);

    // 如果删除的是当前激活预设，切回默认
    if (activePresetId === presetId) {
        await activatePreset('_default');
    }

    await saveUserPresets();
}

/**
 * 保存用户自定义预设到 IndexedDB
 */
async function saveUserPresets() {
    const db = state.get(KEYS.DB);
    if (!db) return;

    const userPresets = presets
        .filter(p => !p.builtIn)
        .map(({ builtIn, ...rest }) => rest); // 去掉 builtIn 标记

    await db.saveSetting(PRESETS_KEY, userPresets);
}
