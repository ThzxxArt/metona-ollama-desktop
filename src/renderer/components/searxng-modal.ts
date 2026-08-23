/**
 * SearXNG 配置模态框
 * 配置 SearXNG 元搜索引擎的 API 地址和参数，支持启用/禁用切换
 */

import { state, KEYS } from '../state/state.js';
import type { ChatDB } from '../db/chat-db.js';
import { logInfo, logSuccess } from '../services/log-service.js';

/** 默认 SearXNG 配置 */
const DEFAULTS = {
  enabled: false,
  url: '',
  engines: '',
  language: 'zh-CN',
  safesearch: 1,
  time_range: '',
  max_results: 0,
  auth_key: '',
  auth_type: 'bearer',
  format: 'json',
  fetch_count: 0,
  fetch_mode: 'sequential',
};

let modalEl: HTMLElement;
let initialized = false;

/** SearXNG 运行时配置缓存（主进程搜索时通过 IPC 读取，渲染进程通过此变量快速访问） */
export let searxngConfig = { ...DEFAULTS };

/** 写入配置到 SQLite + 更新运行时缓存（单事务批量写，避免 13 次全库写盘） */
async function saveConfig(db: ChatDB): Promise<void> {
  await db.saveSettingsBatch([
    { key: 'searxng_enabled', value: searxngConfig.enabled },
    { key: 'searxng_url', value: searxngConfig.url },
    { key: 'searxng_engines', value: searxngConfig.engines },
    { key: 'searxng_language', value: searxngConfig.language },
    { key: 'searxng_safesearch', value: searxngConfig.safesearch },
    { key: 'searxng_time_range', value: searxngConfig.time_range },
    { key: 'searxng_max_results', value: searxngConfig.max_results },
    { key: 'searxng_auth_key', value: searxngConfig.auth_key },
    { key: 'searxng_auth_type', value: searxngConfig.auth_type },
    { key: 'searxng_format', value: searxngConfig.format },
    // 通用搜索设置（非 SearXNG 专属，主进程搜索时读取）
    { key: 'fetch_count', value: searxngConfig.fetch_count },
    { key: 'fetch_mode', value: searxngConfig.fetch_mode },
  ]);
  logSuccess('SearXNG 配置已保存');
}

/** 从 SQLite 加载配置到运行时缓存 */
export async function loadSearxngConfig(db: ChatDB): Promise<void> {
  searxngConfig.enabled = await db.getSetting('searxng_enabled', DEFAULTS.enabled);
  searxngConfig.url = await db.getSetting('searxng_url', DEFAULTS.url);
  searxngConfig.engines = await db.getSetting('searxng_engines', DEFAULTS.engines);
  searxngConfig.language = await db.getSetting('searxng_language', DEFAULTS.language);
  searxngConfig.safesearch = await db.getSetting('searxng_safesearch', DEFAULTS.safesearch);
  searxngConfig.time_range = await db.getSetting('searxng_time_range', DEFAULTS.time_range);
  searxngConfig.max_results = await db.getSetting('searxng_max_results', DEFAULTS.max_results);
  searxngConfig.auth_key = await db.getSetting('searxng_auth_key', DEFAULTS.auth_key);
  searxngConfig.auth_type = await db.getSetting('searxng_auth_type', DEFAULTS.auth_type);
  searxngConfig.format = await db.getSetting('searxng_format', DEFAULTS.format);
  // 通用搜索设置
  searxngConfig.fetch_count = await db.getSetting<number>('fetch_count', DEFAULTS.fetch_count);
  searxngConfig.fetch_mode = await db.getSetting<string>('fetch_mode', DEFAULTS.fetch_mode);
  logInfo('SearXNG 配置已加载', searxngConfig.enabled ? `已启用: ${searxngConfig.url}` : '未启用');
  updateEnabledUI(searxngConfig.enabled);
}

/** 根据返回格式动态启用/禁用「单次结果数」输入框 */
function updateMaxResultsVisibility(): void {
  const format = (document.querySelector('#searxngFormat') as HTMLSelectElement).value;
  const isHtml = format === 'html';
  const input = document.querySelector('#searxngMaxResults') as HTMLInputElement;
  const hint = document.querySelector('#searxngMaxResultsHint') as HTMLElement;
  input.disabled = isHtml;
  input.style.opacity = isHtml ? '0.4' : '';
  hint.style.display = isHtml ? '' : 'none';
}

/** 刷新 UI 控件以匹配当前配置 */
function syncFormFromConfig(): void {
  (document.querySelector('#searxngUrl') as HTMLInputElement).value = searxngConfig.url;
  (document.querySelector('#searxngEngines') as HTMLInputElement).value = searxngConfig.engines;
  (document.querySelector('#searxngLanguage') as HTMLSelectElement).value = searxngConfig.language;
  (document.querySelector('#searxngSafeSearch') as HTMLSelectElement).value = String(searxngConfig.safesearch);
  (document.querySelector('#searxngTimeRange') as HTMLSelectElement).value = searxngConfig.time_range || '';
  (document.querySelector('#searxngMaxResults') as HTMLInputElement).value = searxngConfig.max_results > 0 ? String(searxngConfig.max_results) : '';
  (document.querySelector('#searxngAuthKey') as HTMLInputElement).value = searxngConfig.auth_key;
  (document.querySelector('#searxngAuthType') as HTMLSelectElement).value = searxngConfig.auth_type;
  (document.querySelector('#searxngFormat') as HTMLSelectElement).value = searxngConfig.format;
  (document.querySelector('#searxngFetchCount') as HTMLInputElement).value = searxngConfig.fetch_count > 0 ? String(searxngConfig.fetch_count) : '';
  (document.querySelector('#searxngFetchMode') as HTMLSelectElement).value = searxngConfig.fetch_mode;
  const toggle = document.querySelector('#toggleSearxngEnabled') as HTMLInputElement;
  toggle.checked = searxngConfig.enabled;
  updateEnabledUI(searxngConfig.enabled);
  updateMaxResultsVisibility();
}

/** 启用/禁用状态切换 UI */
function updateEnabledUI(enabled: boolean): void {
  const badge = document.querySelector('#searxngBadge') as HTMLElement;
  const toggle = document.querySelector('#toggleSearxngEnabled') as HTMLInputElement;
  const iconDot = document.querySelector('#searxngIconDot') as HTMLElement;
  if (badge) {
    badge.textContent = enabled ? '🟢 已启用' : '⚪ 未启用';
    badge.className = enabled ? 'searxng-badge enabled' : 'searxng-badge';
  }
  if (toggle) toggle.checked = enabled;
  if (iconDot) {
    iconDot.className = enabled ? 'searxng-icon-dot enabled' : 'searxng-icon-dot';
  }
}

export function initSearxngModal(): void {
  if (initialized) return;
  modalEl = document.querySelector('#searxngModal') as HTMLElement;

  // ── 打开模态框 ──
  document.querySelector('#btnSearxng')!.addEventListener('click', async () => {
    // 重新加载配置（可能在别处被修改）
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) await loadSearxngConfig(db);
    syncFormFromConfig();
    modalEl.style.display = '';
  });

  // ── 关闭模态框 ──
  document.querySelector('#btnCloseSearxng')!.addEventListener('click', () => {
    modalEl.style.display = 'none';
  });
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) modalEl.style.display = 'none';
  });

  // ── 启用/禁用开关 ──
  document.querySelector('#toggleSearxngEnabled')!.addEventListener('change', async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    searxngConfig.enabled = checked;
    updateEnabledUI(checked);
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) await db.saveSetting('searxng_enabled', checked);
    logInfo('SearXNG', checked ? '已启用' : '已禁用');
  });

  // ── 返回格式切换 → 动态启用/禁用「单次结果数」 ──
  document.querySelector('#searxngFormat')!.addEventListener('change', () => {
    updateMaxResultsVisibility();
  });

  // ── 保存按钮 ──
  document.querySelector('#btnSaveSearxng')!.addEventListener('click', async () => {
    const url = (document.querySelector('#searxngUrl') as HTMLInputElement).value.trim();
    if (!url) {
      const { showToast } = await import('./toast.js');
      showToast('SearXNG API 地址不能为空', 'error');
      return;
    }
    if (!/^https?:\/\/.+/.test(url)) {
      const { showToast } = await import('./toast.js');
      showToast('SearXNG API 地址格式不正确，需以 http:// 或 https:// 开头', 'error');
      return;
    }

    searxngConfig.url = url;
    searxngConfig.engines = (document.querySelector('#searxngEngines') as HTMLInputElement).value.trim();
    searxngConfig.language = (document.querySelector('#searxngLanguage') as HTMLSelectElement).value;
    searxngConfig.safesearch = parseInt((document.querySelector('#searxngSafeSearch') as HTMLSelectElement).value);
    searxngConfig.time_range = (document.querySelector('#searxngTimeRange') as HTMLSelectElement).value;
    searxngConfig.max_results = parseInt((document.querySelector('#searxngMaxResults') as HTMLInputElement).value) || 0;
    searxngConfig.auth_key = (document.querySelector('#searxngAuthKey') as HTMLInputElement).value.trim();
    searxngConfig.auth_type = (document.querySelector('#searxngAuthType') as HTMLSelectElement).value as 'bearer' | 'basic';
    searxngConfig.format = (document.querySelector('#searxngFormat') as HTMLSelectElement).value;
    searxngConfig.fetch_count = parseInt((document.querySelector('#searxngFetchCount') as HTMLInputElement).value) || 0;
    searxngConfig.fetch_mode = (document.querySelector('#searxngFetchMode') as HTMLSelectElement).value as 'sequential' | 'random';
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) await saveConfig(db);
    updateEnabledUI(searxngConfig.enabled);
  });

  initialized = true;
}

/** 外部调用关闭模态框（ESC 键等） */
export function closeSearxngModal(): void {
  if (modalEl) modalEl.style.display = 'none';
}
