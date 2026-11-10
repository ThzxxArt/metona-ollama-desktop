/**
 * ToolsModal - 工具面板模态框
 * 从 TOOL_DEFINITIONS 动态生成，避免面板与实际工具数量不一致。
 */

import { state, KEYS } from '../state/state.js';
import {
  TOOL_DEFINITIONS,
  MODE_TOOLS as MANAGED_TOOLS,
  setToolMode,
  getToolIcon,
  type ToolMode,
} from '../services/tool-registry.js';
import { showToast } from './toast.js';
import { logInfo } from '../services/log-service.js';
import type { ChatDB } from '../db/chat-db.js';

let modalEl: HTMLElement;

const MODE_NAMES: Record<string, string> = {
  auto: '自动执行',
  confirm: '需确认',
};

/** 面向用户的简洁说明（与 schema description 分开，避免照搬长提示词） */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  read_file: '读取文本/二进制文件；支持 paths 批量读取与分页续读',
  write_file: '写入或追加文件，自动创建父目录',
  list_directory: '列出目录内容；format=tree 时输出目录树',
  search_files: '按文件名或内容搜索，支持正则',
  edit_file: '精确替换或正则替换文件内容',
  delete_file: '删除文件/目录，支持批量删除',
  file_transfer: '复制或移动文件/目录（operation: copy | move）',
  download_file: '从 URL 下载文件到本地',
  compress: '创建或解压 zip / tar.gz 归档',
  diff: '三种 unified diff 比对模式',
  run_command: '执行 shell 命令，实时流式输出',
  web_search: 'SearXNG 或内置多引擎联网搜索',
  web_fetch: '抓取网页正文，必要时回退浏览器渲染',
  browser: '浏览器控制（open/extract/screenshot/click/type/scroll/wait/evaluate/close）',
  git: 'Git 操作（status/log/diff/add/commit/push 等）',
  memory: '读写工作空间 MEMORY.md（search/add/replace/remove/read_all）',
  session: '读取历史会话（action: list | read）',
  spawn_task: '委派子代理独立执行任务',
};

function renderToolCards(): void {
  const grid = modalEl.querySelector('#toolsGrid');
  if (!grid) return;
  const globalMode = state.get<string>('globalToolMode', 'confirm');
  grid.innerHTML = TOOL_DEFINITIONS.map((def) => {
    const name = def.function.name;
    const managed = MANAGED_TOOLS.includes(name);
    const badgeText = managed ? (globalMode === 'auto' ? '自动' : '需确认') : '自动';
    const badgeCls = managed ? (globalMode === 'auto' ? 'auto' : 'confirm') : 'auto';
    return `<div class="tool-card" data-tool="${name}">
      <div class="tool-card-header"><span class="tool-card-icon">${getToolIcon(name)}</span><span class="tool-card-name">${name}</span><span class="tool-card-badge ${badgeCls}">${badgeText}</span></div>
      <div class="tool-card-desc">${TOOL_DESCRIPTIONS[name] || def.function.description.slice(0, 120)}</div>
    </div>`;
  }).join('');
}

function updateAllBadges(mode: string): void {
  const badgeText = mode === 'auto' ? '自动' : '需确认';
  const badgeCls = mode === 'auto' ? 'auto' : 'confirm';
  const badges = modalEl.querySelectorAll<HTMLElement>('.tool-card-badge');
  badges.forEach((badge) => {
    const nameEl = badge.closest('.tool-card')?.querySelector('.tool-card-name');
    if (nameEl && MANAGED_TOOLS.includes(nameEl.textContent || '')) {
      badge.textContent = badgeText;
      badge.className = `tool-card-badge ${badgeCls}`;
    }
  });
}

export function initToolsModal(): void {
  modalEl = document.querySelector('#toolsModal')!;
  renderToolCards();

  document.querySelector('#btnTools')!.addEventListener('click', openToolsModal);
  document.querySelector('#btnCloseTools')!.addEventListener('click', closeToolsModal);
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeToolsModal();
  });

  const globalSelect = modalEl.querySelector<HTMLSelectElement>('#select_global_tool_mode');
  if (globalSelect) {
    globalSelect.addEventListener('change', async () => {
      const mode = globalSelect.value as ToolMode;
      const db = state.get<ChatDB | null>(KEYS.DB);
      for (const toolName of MANAGED_TOOLS) {
        setToolMode(toolName, mode);
      }
      state.set('globalToolMode', mode);
      if (db) await db.saveSetting('globalToolMode', mode);
      updateAllBadges(mode);
      showToast(`工具执行模式：${MODE_NAMES[mode]}`, 'info');
      logInfo(`全局工具模式切换: → ${mode}`);
    });
  }
}

export function openToolsModal(): void {
  renderToolCards();
  const globalMode = state.get<string>('globalToolMode', 'confirm');
  const globalSelect = modalEl.querySelector<HTMLSelectElement>('#select_global_tool_mode');
  if (globalSelect) {
    globalSelect.value = globalMode;
    updateAllBadges(globalMode);
  }
  modalEl.style.display = '';
}

export function closeToolsModal(): void {
  modalEl.style.display = 'none';
}
