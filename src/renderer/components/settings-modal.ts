/**
 * SettingsModal - 设置面板组件
 */

import { state, KEYS } from '../state/state.js';
import { debounce } from '../utils/utils.js';
import { encryptData, decryptData, isMetonaFile } from '../services/crypto.js';
import { setMemoryEnabled } from '../services/memory-manager.js';
import { setToolEnabled } from '../services/tool-registry.js';
import { updateConnectionInfo, updateRunningModels } from './header.js';
import { loadModels } from './model-bar.js';
import { showToast } from './toast.js';
import { OllamaAPI } from '../api/ollama.js';
import { ChatDB } from '../db/chat-db.js';
import type { ChatSession } from '../types.js';

let settingsModalEl: HTMLElement;

export function initSettingsModal(): void {
  settingsModalEl = document.querySelector('#settingsModal')!;

  document.querySelector('#btnSettings')!.addEventListener('click', openSettingsModal);
  document.querySelector('#btnCloseSettings')!.addEventListener('click', closeSettingsModal);
  settingsModalEl.addEventListener('click', (e) => {
    if (e.target === settingsModalEl) closeSettingsModal();
  });

  const saveServerUrl = debounce(async () => {
    const url = (document.querySelector('#inputServerUrl') as HTMLInputElement).value.trim();
    if (!url) return;
    const db = state.get<ChatDB | null>(KEYS.DB);
    const api = new OllamaAPI(url);
    state.set(KEYS.API, api);
    if (db) await db.saveSetting('serverUrl', url);
    updateConnectionInfo();
    loadModels();
  }, 500);
  document.querySelector('#inputServerUrl')!.addEventListener('input', saveServerUrl);

  document.querySelector('#toggleSystemPrompt')!.addEventListener('change', async (e) => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    state.set(KEYS.SYSTEM_PROMPT_ENABLED, (e.target as HTMLInputElement).checked);
    (document.querySelector('#inputSystemPrompt') as HTMLTextAreaElement).disabled = !(e.target as HTMLInputElement).checked;
    if (db) await db.saveSetting('systemPromptEnabled', (e.target as HTMLInputElement).checked);
  });

  const saveSystemPrompt = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const val = (document.querySelector('#inputSystemPrompt') as HTMLTextAreaElement).value.trim();
    state.set(KEYS.SYSTEM_PROMPT, val);
    if (db) await db.saveSetting('systemPrompt', val);
  }, 500);
  document.querySelector('#inputSystemPrompt')!.addEventListener('input', saveSystemPrompt);

  const saveNumCtx = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const val = (document.querySelector('#inputNumCtx') as HTMLInputElement).value.trim();
    const numCtx = val ? parseInt(val) : 24576;
    state.set(KEYS.NUM_CTX, numCtx);
    if (db) await db.saveSetting('numCtx', numCtx);
  }, 500);
  document.querySelector('#inputNumCtx')!.addEventListener('input', saveNumCtx);

  const tempSlider = document.querySelector('#inputTemperature') as HTMLInputElement;
  const tempDisplay = document.querySelector('#tempValue')!;
  tempSlider.addEventListener('input', () => {
    tempDisplay.textContent = parseFloat(tempSlider.value).toFixed(1);
  });
  const saveTemperature = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const val = parseFloat(tempSlider.value);
    state.set('temperature', val);
    if (db) await db.saveSetting('temperature', val);
  }, 300);
  tempSlider.addEventListener('change', saveTemperature);

  document.querySelector('#btnReleaseVRAM')!.addEventListener('click', async () => {
    const api = state.get<OllamaAPI>(KEYS.API);
    const model = (document.querySelector('#modelSelect') as HTMLSelectElement).value;
    try {
      await api!.chat({ model: model || 'any', messages: [], keep_alive: 0 } as any);
      showToast('显存已释放', 'success');
      updateRunningModels();
    } catch (err) {
      showToast(`释放失败: ${(err as Error).message}`, 'error');
    }
  });

  document.querySelector('#btnClearAllHistory')!.addEventListener('click', async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (confirm('确定清空所有历史记录？此操作不可恢复！')) {
      await db!.clearAll();
      (document.querySelector('#btnNewChat') as HTMLElement).click();
      showToast('已清空所有历史记录', 'success');
    }
  });

  document.querySelector('#btnExportAll')!.addEventListener('click', exportAllSessions);

  const importFileInput = document.querySelector('#importFileInput') as HTMLInputElement;
  document.querySelector('#btnImportSessions')!.addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).files!.length > 0) {
      importSessions((e.target as HTMLInputElement).files![0]);
      (e.target as HTMLInputElement).value = '';
    }
  });

  // ── Tool Calling 设置 ──
  const toggleToolCalling = document.querySelector('#toggleToolCalling') as HTMLInputElement;
  if (toggleToolCalling) {
    toggleToolCalling.addEventListener('change', async () => {
      const db = state.get<ChatDB | null>(KEYS.DB);
      state.set('toolCallingEnabled', toggleToolCalling.checked);
      if (db) await db.saveSetting('toolCallingEnabled', toggleToolCalling.checked);
      showToast(toggleToolCalling.checked ? '工具调用已开启' : '工具调用已关闭', 'info');
    });
  }

  const toggleRunCommand = document.querySelector('#toggleRunCommand') as HTMLInputElement;
  if (toggleRunCommand) {
    toggleRunCommand.addEventListener('change', async () => {
      const db = state.get<ChatDB | null>(KEYS.DB);
      state.set('runCommandEnabled', toggleRunCommand.checked);
      if (db) await db.saveSetting('runCommandEnabled', toggleRunCommand.checked);
      setToolEnabled('run_command', toggleRunCommand.checked);
      if (toggleRunCommand.checked) {
        showToast('⚠️ 命令执行已开启，请谨慎使用', 'warning');
      }
    });
  }

  // ── Agent 记忆设置 ──
  const toggleMemory = document.querySelector('#toggleMemoryEnabled') as HTMLInputElement;
  if (toggleMemory) {
    toggleMemory.addEventListener('change', () => {
      setMemoryEnabled(toggleMemory.checked);
      showToast(toggleMemory.checked ? 'Agent 记忆已开启' : 'Agent 记忆已关闭', 'info');
    });
  }
}

export function openSettingsModal(): void {
  settingsModalEl.style.display = '';
  (document.querySelector('#inputServerUrl') as HTMLInputElement).value = state.get<OllamaAPI>(KEYS.API)?.baseUrl || '';
  updateConnectionInfo();
  updateRunningModels();
}

export function closeSettingsModal(): void {
  settingsModalEl.style.display = 'none';
}

async function exportAllSessions(): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;
  const sessions = await db.getAllSessions();
  if (sessions.length === 0) {
    showToast('没有可导出的会话', 'warning');
    return;
  }

  const backup = {
    app: 'Metona Ollama Client',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: sessions.length,
    sessions
  };

  try {
    const blob = await encryptData(backup);
    const ts = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `metona-backup-${ts}.metona`;
    a.click();
    showToast(`已导出 ${sessions.length} 个会话（已加密）`, 'success');
  } catch (err) {
    console.error('[Settings] 导出失败:', err);
    showToast(`导出失败: ${(err as Error).message}`, 'error');
  }
}

async function importSessions(file: File): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;

  if (!isMetonaFile(file)) {
    showToast('仅支持导入 .metona 格式文件', 'error');
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const data = await decryptData(buffer);

    let sessions: ChatSession[];
    if (Array.isArray(data)) {
      sessions = data as ChatSession[];
    } else if ((data as any).sessions && Array.isArray((data as any).sessions)) {
      sessions = (data as any).sessions;
    } else {
      showToast('文件内容格式错误：未找到会话数据', 'error');
      return;
    }

    const result = await db.importSessions(sessions);
    showToast(`导入完成：${result.imported} 个会话${result.skipped > 0 ? `，跳过 ${result.skipped} 个` : ''}`, 'success', 4000);
  } catch (err) {
    console.error('[Settings] 导入失败:', err);
    showToast(`导入失败: ${(err as Error).message}`, 'error');
  }
}
