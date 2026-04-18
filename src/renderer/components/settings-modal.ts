/**
 * SettingsModal - 设置面板组件
 */

import { state, KEYS } from '../state/state.js';
import { debounce } from '../utils/utils.js';
import { encryptData, decryptData } from '../services/crypto.js';
import { setMemoryEnabled, setEmbeddingModel, getEmbeddingModel, isVectorMemoryEnabled, getMemoryCache } from '../services/memory-manager.js';
import { logSetting, logInfo, logWarn, logError, logSuccess } from '../services/log-service.js';
import { checkConnection, updateConnectionInfo, updateRunningModels } from './header.js';
import { loadModels } from './model-bar.js';
import { showToast } from './toast.js';
import { showConfirm } from './prompt-modal.js';
import { OllamaAPI } from '../api/ollama.js';
import { ChatDB } from '../db/chat-db.js';
import type { ChatSession } from '../types.js';

/** v4.2 人格模式 system prompt 映射 */
export const PERSONALITY_SYSTEM_PROMPTS: Record<string, string> = {
  default: '',
  coder: '你是一个专业的编程助手。你注重代码质量、可读性和最佳实践。回答时优先给出可运行的代码，其次才是解释。遇到问题先分析根因再给方案。使用 type hints、合理的命名和注释。代码风格偏向简洁紧凑。',
  writer: '你是一个专业的写作助手。你的文字流畅、有文采，注重结构和节奏。擅长技术文档、文章、文案、邮件等各种文体。回答时先理解写作目的和受众，再给出合适的风格和内容。',
  analyst: '你是一个精确的数据分析助手。你注重数据的准确性和逻辑的严密性。回答时先明确数据来源和假设，再给出分析过程和结论。偏好用数字和事实说话，避免模糊表述。',
  translator: '你是一个专业的翻译助手。你精通多语言互译，注重信达雅。翻译时保留原文的语气和风格，专业术语保持一致。遇到歧义时给出多种翻译并标注区别。',
  reviewer: '你是一个严格的代码审查助手。你关注：正确性（逻辑错误、边界情况）、安全性（注入、泄露）、性能（时间/空间复杂度）、可维护性（命名、结构、注释）。审查时先给出总体评价，再逐项列出问题并给出修复建议。',
};

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

  // ── v4.2 人格模式切换 ──
  const PERSONALITY_TEMPERATURES: Record<string, number> = {
    default: -1, // 使用用户设置
    coder: 0.3,
    writer: 0.8,
    analyst: 0.2,
    translator: 0.4,
    reviewer: 0.3,
  };

  document.querySelectorAll('.personality-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const personality = (btn as HTMLElement).dataset.personality || 'default';
      state.set('personality', personality);
      const db = state.get<ChatDB | null>(KEYS.DB);
      if (db) await db.saveSetting('personality', personality);

      // 更新按钮样式
      document.querySelectorAll('.personality-btn').forEach(b => {
        (b as HTMLElement).style.border = '2px solid var(--border-subtle)';
        b.classList.remove('active');
      });
      (btn as HTMLElement).style.border = '2px solid var(--primary)';
      btn.classList.add('active');

      // 如果人格有推荐温度，自动调整
      const recommendedTemp = PERSONALITY_TEMPERATURES[personality];
      if (recommendedTemp >= 0) {
        const tempSlider = document.querySelector('#inputTemperature') as HTMLInputElement;
        tempSlider.value = String(recommendedTemp);
        document.querySelector('#tempValue')!.textContent = recommendedTemp.toFixed(1);
        state.set('temperature', recommendedTemp);
        if (db) await db.saveSetting('temperature', recommendedTemp);
      }

      const names: Record<string, string> = {
        default: '通用助手', coder: '编程助手', writer: '写作助手',
        analyst: '数据分析', translator: '翻译助手', reviewer: '代码审查'
      };
      showToast(`已切换到 ${names[personality] || personality}`, 'success');
      logSetting('人格模式', names[personality] || personality);
    });
  });

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


  // ── Agent 记忆设置 ──
  const toggleMemory = document.querySelector('#toggleMemoryEnabled') as HTMLInputElement;
  if (toggleMemory) {
    toggleMemory.addEventListener('change', () => {
      setMemoryEnabled(toggleMemory.checked);
      showToast(toggleMemory.checked ? 'Agent 记忆已开启' : 'Agent 记忆已关闭', 'info');
      logSetting('Agent 记忆', toggleMemory.checked ? '开启' : '关闭');
    });
  }

  // ── 向量记忆引擎设置 ──
  const selectEmbedModel = document.querySelector('#selectMemoryEmbedModel') as HTMLSelectElement;
  if (selectEmbedModel) {
    selectEmbedModel.addEventListener('change', async () => {
      const model = selectEmbedModel.value;
      await setEmbeddingModel(model);
      if (model) {
        showToast(`向量记忆已启用（${model}）`, 'success');
        logSetting('向量记忆引擎', `启用: ${model}`);
      } else {
        showToast('向量记忆已关闭，仅使用关键词匹配', 'info');
        logSetting('向量记忆引擎', '关闭');
      }
      updateMemoryVectorStatus();
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
  populateMemoryEmbedModels();
  updateMemoryVectorStatus();
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

async function populateMemoryEmbedModels(): Promise<void> {
  const select = document.querySelector('#selectMemoryEmbedModel') as HTMLSelectElement;
  if (!select) return;
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  try {
    const data = await api.listModels();
    select.innerHTML = '<option value="">未选择（仅关键词模式）</option>';
    if (!data.models || data.models.length === 0) return;

    // 获取每个模型的能力信息，筛选嵌入模型
    const checks = await Promise.allSettled(
      data.models.map(async (m) => {
        const info = await api.showModel(m.name);
        const caps = info.capabilities || [];
        return { name: m.name, size: m.size, isEmbed: caps.includes('embedding') };
      })
    );

    const embedModels = checks
      .filter(r => r.status === 'fulfilled' && r.value.isEmbed)
      .map(r => (r as PromiseFulfilledResult<{ name: string; size?: number; isEmbed: boolean }>).value);

    embedModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      select.appendChild(opt);
    });

    if (embedModels.length === 0) {
      select.innerHTML = '<option value="">未检测到嵌入模型，请先 ollama pull</option>';
      return;
    }

    // 恢复已保存的选择
    const saved = getEmbeddingModel();
    if (saved) select.value = saved;
  } catch (err) {
    logWarn('加载嵌入模型列表失败', (err as Error).message);
  }
}

function updateMemoryVectorStatus(): void {
  const statusEl = document.querySelector('#memoryVectorStatus');
  if (!statusEl) return;
  const model = getEmbeddingModel();
  if (model) {
    const memCount = getMemoryCache().length;
    statusEl.textContent = `✅ 向量搜索已启用（${model}）· ${memCount} 条记忆`;
    (statusEl as HTMLElement).style.color = 'var(--success)';
  } else {
    statusEl.textContent = 'ℹ️ 未选择嵌入模型，仅使用关键词匹配';
    (statusEl as HTMLElement).style.color = '';
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
