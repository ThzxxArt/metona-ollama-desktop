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
  format: 'json',
};

let modalEl: HTMLElement;
let initialized = false;

/** SearXNG 运行时配置缓存（主进程搜索时通过 IPC 读取，渲染进程通过此变量快速访问） */
export let searxngConfig = { ...DEFAULTS };

/** 写入配置到 SQLite + 更新运行时缓存 */
async function saveConfig(db: ChatDB): Promise<void> {
  await db.saveSetting('searxng_enabled', searxngConfig.enabled);
  await db.saveSetting('searxng_url', searxngConfig.url);
  await db.saveSetting('searxng_engines', searxngConfig.engines);
  await db.saveSetting('searxng_language', searxngConfig.language);
  await db.saveSetting('searxng_safesearch', searxngConfig.safesearch);
  await db.saveSetting('searxng_time_range', searxngConfig.time_range);
  await db.saveSetting('searxng_max_results', searxngConfig.max_results);
  await db.saveSetting('searxng_auth_key', searxngConfig.auth_key);
  await db.saveSetting('searxng_format', searxngConfig.format);
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
  searxngConfig.format = await db.getSetting('searxng_format', DEFAULTS.format);
  logInfo('SearXNG 配置已加载', searxngConfig.enabled ? `已启用: ${searxngConfig.url}` : '未启用');
  updateEnabledUI(searxngConfig.enabled);
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
  (document.querySelector('#searxngFormat') as HTMLSelectElement).value = searxngConfig.format;
  const toggle = document.querySelector('#toggleSearxngEnabled') as HTMLInputElement;
  toggle.checked = searxngConfig.enabled;
  updateEnabledUI(searxngConfig.enabled);
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
    searxngConfig.format = (document.querySelector('#searxngFormat') as HTMLSelectElement).value;
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
