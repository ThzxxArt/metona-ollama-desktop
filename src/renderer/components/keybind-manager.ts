/**
 * KeybindManager — 全局快捷键管理
 * 集中注册所有快捷键，避免分散在各组件中
 */

import { state, KEYS } from '../state/state.js';
import { logInfo, logDebug } from '../services/log-service.js';
import { showToast } from './toast.js';
import { showConfirm } from './prompt-modal.js';

/** 快捷键定义 */
export interface Keybind {
  keys: string;          // 显示用的按键组合（如 "Ctrl+Enter"）
  description: string;    // 功能描述
  category: 'chat' | 'navigation' | 'agent' | 'system';
}

/** 所有快捷键定义（用于设置面板/帮助页面展示） */
export const KEYBINDS: Keybind[] = [
  { keys: 'Ctrl+N', description: '新建会话', category: 'chat' },
  { keys: 'Ctrl+Enter', description: '发送消息', category: 'chat' },
  { keys: 'Ctrl+K', description: '聚焦输入框', category: 'chat' },
  { keys: 'Ctrl+/', description: '聚焦输入框（备用）', category: 'chat' },
  { keys: 'Ctrl+L', description: '清空当前对话', category: 'chat' },
  { keys: 'Ctrl+F', description: '对话内搜索', category: 'chat' },
  { keys: 'Ctrl+Shift+C', description: '复制最后一条 AI 回复', category: 'chat' },
  { keys: 'Ctrl+,', description: '打开设置', category: 'system' },
  { keys: 'Ctrl+Shift+Backspace', description: '中止 Agent', category: 'agent' },
  { keys: 'Ctrl+M', description: '打开记忆面板', category: 'navigation' },
  { keys: 'Ctrl+H', description: '打开历史记录', category: 'navigation' },
  { keys: 'Ctrl+,', description: '打开设置', category: 'navigation' },
  { keys: 'Ctrl+Shift+L', description: '切换日志面板', category: 'system' },
  { keys: 'Esc', description: '关闭弹窗', category: 'system' },
];

/** 检查是否有模态框打开 */
function isModalOpen(): boolean {
  const modals = ['#settingsModal', '#historyModal', '#helpModal', '#toolsModal',
    '#tokenDashboardModal', '#toolConfirmModal', '#searxngModal', '#memoryModal'];
  for (const sel of modals) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el && el.style.display !== 'none') return true;
  }
  return false;
}

/** 关闭所有打开的模态框 */
function closeAllModals(): void {
  const closeIds: Array<{ closeId: string }> = [
    { closeId: 'btnCloseSettings' },
    { closeId: 'btnCloseHistory' },
    { closeId: 'btnCloseHelp' },
    { closeId: 'btnCloseTools' },
    { closeId: 'btnCloseTokenDashboard' },
    { closeId: 'btnCloseSearxng' },
  ];
  for (const { closeId } of closeIds) {
    const btn = document.getElementById(closeId);
    if (btn) btn.click();
  }
  // 关闭记忆面板
  const memModal = document.getElementById('memoryModal');
  if (memModal && memModal.style.display !== 'none') {
    memModal.style.display = 'none';
  }
  // 关闭工具确认
  const toolConfirm = document.getElementById('toolConfirmModal');
  if (toolConfirm && toolConfirm.style.display !== 'none') {
    const cancelBtn = document.getElementById('toolCancelBtn');
    if (cancelBtn) cancelBtn.click();
  }
}

/** 中止当前 Agent */
function abortAgent(): void {
  const ac = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER);
  if (ac) {
    ac.abort();
    logInfo('快捷键中止 Agent');
  } else {
    showToast('当前没有正在运行的 Agent', 'info');
  }
}

/** 切换日志面板 */
function toggleLogPanel(): void {
  const logPanel = document.getElementById('logPanel');
  if (logPanel) {
    const isVisible = logPanel.style.display !== 'none';
    logPanel.style.display = isVisible ? 'none' : '';
    logDebug(`日志面板 ${isVisible ? '已隐藏' : '已显示'}`);
  }
}

/** 清空当前对话 */
async function clearChat(): Promise<void> {
  if (isModalOpen()) return;
  if (await showConfirm('确定清空当前对话？此操作不可恢复！', '清空对话')) {
    document.getElementById('btnNewChat')?.click();
    showToast('对话已清空', 'success');
  }
}

/** 初始化快捷键系统 */
export function initKeybindManager(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // ── Esc：关闭弹窗（最高优先级）──
    if (e.key === 'Escape') {
      if (isModalOpen()) {
        closeAllModals();
        e.preventDefault();
        return;
      }
      // 关闭搜索栏
      const searchBar = document.getElementById('searchBar');
      if (searchBar && searchBar.style.display !== 'none') {
        document.getElementById('searchClose')?.click();
        e.preventDefault();
        return;
      }
    }

    // 以下快捷键需要 Ctrl 修饰键
    if (!e.ctrlKey && !e.metaKey) return;

    const key = e.key.toLowerCase();

    // ── Ctrl+Shift 组合键 ──
    if (e.shiftKey) {
      // Ctrl+Shift+Backspace — 中止 Agent
      if (e.code === 'Backspace') {
        e.preventDefault();
        abortAgent();
        return;
      }
      // Ctrl+Shift+L — 切换日志面板
      if (key === 'l') {
        e.preventDefault();
        toggleLogPanel();
        return;
      }
      return;
    }

    // ── 模态框打开时，只允许 Esc 和 Ctrl+, ──
    if (isModalOpen()) {
      if (key === ',') {
        e.preventDefault();
        // 如果设置面板已打开，关闭它；否则打开
        const settings = document.getElementById('settingsModal');
        if (settings && settings.style.display !== 'none') {
          document.getElementById('btnCloseSettings')?.click();
        } else {
          document.getElementById('btnSettings')?.click();
        }
        return;
      }
      return; // 其他快捷键在模态框打开时不响应
    }

    // ── 普通快捷键 ──
    switch (key) {
      case 'n':
        e.preventDefault();
        document.getElementById('btnNewChat')?.click();
        break;

      case 'enter': {
        e.preventDefault();
        const btnSend = document.getElementById('btnSend') as HTMLButtonElement | null;
        if (btnSend && !btnSend.classList.contains('disabled')) {
          btnSend.click();
        }
        break;
      }

      case 'k':
        e.preventDefault();
        document.getElementById('chatInput')?.focus();
        break;

      case '/':
        e.preventDefault();
        document.getElementById('chatInput')?.focus();
        break;

      case 'f':
        e.preventDefault();
        document.getElementById('btnSearch')?.click();
        break;

      case 'm':
        e.preventDefault();
        document.getElementById('btnMemory')?.click();
        break;

      case 'h':
        e.preventDefault();
        document.getElementById('btnHistory')?.click();
        break;

      case ',':
        e.preventDefault();
        document.getElementById('btnSettings')?.click();
        break;

      case 'l':
        e.preventDefault();
        clearChat();
        break;
    }
  });

  logInfo('快捷键系统已初始化', `${KEYBINDS.length} 个快捷键已注册`);
}

/** 获取快捷键列表（按分类分组） */
export function getKeybindsByCategory(): Record<string, Keybind[]> {
  const grouped: Record<string, Keybind[]> = {};
  for (const kb of KEYBINDS) {
    if (!grouped[kb.category]) grouped[kb.category] = [];
    grouped[kb.category].push(kb);
  }
  return grouped;
}
