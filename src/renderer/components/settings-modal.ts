/**
 * SettingsModal - 设置面板组件
 */

import { state, KEYS } from '../state/state.js';
import { debounce } from '../utils/utils.js';
import { encryptData, decryptData } from '../services/crypto.js';
import { setMemoryEnabled } from '../services/memory-manager.js';
import { setToolEnabled } from '../services/tool-registry.js';
import { logSetting, logInfo, logWarn, logError, logSuccess } from '../services/log-service.js';
import { checkConnection, updateConnectionInfo, updateRunningModels } from './header.js';
import { loadModels } from './model-bar.js';
import { showToast } from './toast.js';
import { showConfirm } from './prompt-modal.js';
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
    checkConnection();
    loadModels();
  }, 500);
  document.querySelector('#inputServerUrl')!.addEventListener('input', saveServerUrl);

  const saveNumCtx = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const val = (document.querySelector('#inputNumCtx') as HTMLInputElement).value.trim();
    const numCtx = val ? parseInt(val) : 24576;
    state.set(KEYS.NUM_CTX, numCtx);
    if (db) await db.saveSetting('numCtx', numCtx);
    logSetting('上下文长度', `${numCtx} tokens`);
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
    logSetting('温度', val.toFixed(1));
  }, 300);
  tempSlider.addEventListener('change', saveTemperature);

  document.querySelector('#btnReleaseVRAM')!.addEventListener('click', async () => {
    const api = state.get<OllamaAPI>(KEYS.API);
    const model = (document.querySelector('#modelSelect') as HTMLSelectElement).value;
    logInfo('释放显存', model || '所有模型');
    try {
      await api!.chat({ model: model || 'any', messages: [], keep_alive: 0 } as any);
      showToast('显存已释放', 'success');
      logSuccess('显存已释放');
      updateRunningModels();
    } catch (err) {
      showToast(`释放失败: ${(err as Error).message}`, 'error');
      logError('释放显存失败', (err as Error).message);
    }
  });

  document.querySelector('#btnClearAllHistory')!.addEventListener('click', async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (await showConfirm('确定清空所有历史记录？此操作不可恢复！', '清空历史')) {
      logWarn('清空所有历史记录');
      await db!.clearAll();
      (document.querySelector('#btnNewChat') as HTMLElement).click();
      showToast('已清空所有历史记录', 'success');
      logSuccess('历史记录已清空');
    }
  });

  document.querySelector('#btnExportAll')!.addEventListener('click', exportAllSessions);

  // ── 导入会话：原生文件对话框 ──
  document.querySelector('#btnImportSessions')!.addEventListener('click', async () => {
    const bridge = (window as any).metonaDesktop;
    if (!bridge) return;
    const paths = await bridge.dialog.openFile({
      filters: [{ name: 'Metona 备份', extensions: ['metona'] }]
    });
    if (!paths || paths.length === 0) return;
    await importSessions(paths[0]);
  });

  // ── Tool Calling 设置 ──
  const toggleToolCalling = document.querySelector('#toggleToolCalling') as HTMLInputElement;
  if (toggleToolCalling) {
    toggleToolCalling.addEventListener('change', async () => {
      const db = state.get<ChatDB | null>(KEYS.DB);
      state.set('toolCallingEnabled', toggleToolCalling.checked);
      if (db) await db.saveSetting('toolCallingEnabled', toggleToolCalling.checked);
      if (toggleToolCalling.checked) {
        const modelSupportsTools = state.get<boolean>('modelSupportsTools', false);
        if (!modelSupportsTools) {
          showToast('⚠️ 当前模型可能不支持 Tool Calling，建议使用 Qwen3、Llama 3.1+ 等模型', 'warning', 5000);
          logWarn('Tool Calling 已开启（模型不支持）');
        } else {
          showToast('工具调用已开启', 'info');
          logInfo('Tool Calling 已开启');
        }
      } else {
        showToast('工具调用已关闭', 'info');
        logInfo('Tool Calling 已关闭');
      }
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
        showToast('命令执行已开启（每次执行需确认）', 'info');
        logInfo('命令执行已开启');
      } else {
        showToast('命令执行已关闭', 'info');
        logInfo('命令执行已关闭');
      }
    });
  }

  // ── Agent 记忆设置 ──
  const toggleMemory = document.querySelector('#toggleMemoryEnabled') as HTMLInputElement;
  if (toggleMemory) {
    toggleMemory.addEventListener('change', () => {
      setMemoryEnabled(toggleMemory.checked);
      showToast(toggleMemory.checked ? 'Agent 记忆已开启' : 'Agent 记忆已关闭', 'info');
      logSetting('Agent 记忆', toggleMemory.checked ? '开启' : '关闭');
    });
  }

  // ── 工作空间目录设置 ──
  const inputWorkspaceDir = document.querySelector('#inputWorkspaceDir') as HTMLInputElement;
  const btnBrowseWorkspace = document.querySelector('#btnBrowseWorkspace') as HTMLButtonElement;
  if (inputWorkspaceDir) {
    // 加载当前工作空间目录
    const bridge = (window as any).metonaDesktop;
    if (bridge?.isDesktop) {
      bridge.workspace.getDir().then((info: { dir: string }) => {
        inputWorkspaceDir.value = info.dir;
      }).catch(() => {});
    }
  }
  if (btnBrowseWorkspace) {
    btnBrowseWorkspace.addEventListener('click', async () => {
      const bridge = (window as any).metonaDesktop;
      if (!bridge?.isDesktop) return;
      const paths = await bridge.dialog.openFile({
        filters: [{ name: '文件夹', extensions: ['*'] }]
      });
      // Electron openFile 对话框不能直接选文件夹，这里用 saveFile 代替
      // 或者让用户手动输入路径
      showToast('请在输入框中直接修改路径', 'info');
    });
    // 双击输入框解锁编辑
    inputWorkspaceDir.addEventListener('dblclick', () => {
      inputWorkspaceDir.removeAttribute('readonly');
      inputWorkspaceDir.focus();
    });
    inputWorkspaceDir.addEventListener('blur', async () => {
      inputWorkspaceDir.setAttribute('readonly', '');
      const newDir = inputWorkspaceDir.value.trim();
      if (!newDir) return;
      const bridge = (window as any).metonaDesktop;
      if (!bridge?.isDesktop) return;
      const result = await bridge.workspace.setDir(newDir);
      if (result.success) {
        showToast('工作空间目录已更新', 'success');
        logSetting('工作空间目录', result.dir);
      } else {
        showToast(`设置失败: ${result.error}`, 'error');
        // 恢复原值
        const info = await bridge.workspace.getDir();
        inputWorkspaceDir.value = info.dir;
      }
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

    // ── 原生保存对话框 ──
    const bridge = (window as any).metonaDesktop;
    if (bridge) {
      const filePath = await bridge.dialog.saveFile({
        defaultPath: `metona-backup-${ts}.metona`,
        filters: [{ name: 'Metona 备份', extensions: ['metona'] }]
      });
      if (!filePath) return;
      // blob → ArrayBuffer → base64 字符串，通过 base64 编码写入二进制文件
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      const result = await bridge.fs.writeFile(filePath, b64, 'base64');
      if (!result.success) {
        showToast(`导出失败: ${result.error}`, 'error');
        logError('导出失败', result.error);
        return;
      }
    } else {
      // 回退：浏览器下载
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `metona-backup-${ts}.metona`;
      a.click();
    }

    showToast(`已导出 ${sessions.length} 个会话（已加密）`, 'success');
    logSuccess(`导出完成: ${sessions.length} 个会话`);
  } catch (err) {
    showToast(`导出失败: ${(err as Error).message}`, 'error');
    logError('导出失败', (err as Error).message);
  }
}

async function importSessions(filePath: string): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  if (!fileName.endsWith('.metona')) {
    showToast('仅支持导入 .metona 格式文件', 'error');
    return;
  }

  try {
    const bridge = (window as any).metonaDesktop;
    const result = await bridge.fs.readFileBase64(filePath);
    if (!result.success) {
      showToast(`读取文件失败: ${result.error}`, 'error');
      return;
    }
    // 主进程返回 base64，直接解码为二进制
    const binary = atob(result.content as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const data = await decryptData(bytes.buffer);
    logInfo('导入会话', `文件: ${fileName}`);

    let sessions: ChatSession[];
    if (Array.isArray(data)) {
      sessions = data as ChatSession[];
    } else if ((data as any).sessions && Array.isArray((data as any).sessions)) {
      sessions = (data as any).sessions;
    } else {
      showToast('文件内容格式错误：未找到会话数据', 'error');
      return;
    }

    const importResult = await db.importSessions(sessions);
    showToast(`导入完成：${importResult.imported} 个会话${importResult.skipped > 0 ? `，跳过 ${importResult.skipped} 个` : ''}`, 'success', 4000);
    logSuccess(`导入完成: ${importResult.imported} 个, 跳过 ${importResult.skipped} 个`);
  } catch (err) {
    showToast(`导入失败: ${(err as Error).message}`, 'error');
    logError('导入失败', (err as Error).message);
  }
}
