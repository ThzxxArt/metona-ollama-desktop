/**
 * SettingsModal - 设置面板组件
 */

import { state, KEYS } from '../state/state.js';
import { debounce } from '../utils/utils.js';
import { encryptData, decryptData } from '../services/crypto.js';
import { setMemoryEnabled, setEmbeddingModel, getEmbeddingModel, getMemoryCache } from '../services/memory-manager.js';
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

  // ── v5.1.1 Agent 最大轮数 ──
  const saveMaxTurns = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const val = (document.querySelector('#inputMaxTurns') as HTMLInputElement).value.trim();
    const maxTurns = val ? parseInt(val) : 85;
    state.set('maxTurns', maxTurns);
    if (db) await db.saveSetting('maxTurns', maxTurns);
    logSetting('Agent 最大轮数', `${maxTurns} 轮`);
  }, 500);
  document.querySelector('#inputMaxTurns')!.addEventListener('input', saveMaxTurns);

  // ── v5.2 超时设置 ──
  const inputHttpTimeout = document.querySelector('#inputHttpTimeout') as HTMLInputElement;
  const inputStreamTimeout = document.querySelector('#inputStreamTimeout') as HTMLInputElement;
  const inputMCPTimeout = document.querySelector('#inputMCPTimeout') as HTMLInputElement;

  const applyTimeouts = async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const bridge = window.metonaDesktop;

    // 辅助：解析输入值，空→-1(默认)，数字→该值(含0=禁用)
    const parseSec = (val: string): number => (val !== '' ? parseInt(val) : -1);

    // HTTP 超时（秒→毫秒）
    const httpSec = parseSec(inputHttpTimeout.value.trim());
    const httpMs = httpSec >= 0 ? httpSec * 1000 : 30_000;
    if (db) await db.saveSetting('httpTimeout', httpSec);
    if (bridge?.tool?.setTimeouts) {
      await bridge.tool.setTimeouts({ http: httpMs });
    }
    logInfo('HTTP 超时', httpSec >= 0 ? (httpSec === 0 ? '已禁用' : `${httpSec}s`) : '默认(30s)');

    // 流式超时（秒→毫秒）
    const streamSec = parseSec(inputStreamTimeout.value.trim());
    const streamMs = streamSec >= 0 ? streamSec * 1000 : 300_000;
    state.set('streamTimeout', streamMs);
    if (db) await db.saveSetting('streamTimeout', streamSec);
    logInfo('流式超时', streamSec >= 0 ? (streamSec === 0 ? '已禁用' : `${streamSec}s`) : '默认(300s)');

    // MCP 超时（秒→毫秒）
    const mcpSec = parseSec(inputMCPTimeout.value.trim());
    const mcpMs = mcpSec >= 0 ? mcpSec * 1000 : 60_000;
    if (db) await db.saveSetting('mcpTimeout', mcpSec);
    if (bridge?.tool?.setTimeouts) {
      await bridge.tool.setTimeouts({ mcp: mcpMs });
    }
    logInfo('MCP 超时', mcpSec >= 0 ? (mcpSec === 0 ? '已禁用' : `${mcpSec}s`) : '默认(60s)');
  };

  const saveHttpTimeout = debounce(applyTimeouts, 500);
  const saveStreamTimeout = debounce(applyTimeouts, 500);
  const saveMCPTimeout = debounce(applyTimeouts, 500);

  inputHttpTimeout.addEventListener('input', saveHttpTimeout);
  inputStreamTimeout.addEventListener('input', saveStreamTimeout);
  inputMCPTimeout.addEventListener('input', saveMCPTimeout);

  // ── v5.0 MCP 服务器管理 ──
  async function renderMCPServerList(): Promise<void> {
    const { getMCPServers, getMCPServerStatuses, toggleMCPServer, removeMCPServer } = await import('../services/mcp-client.js');
    const { refreshMCPTools } = await import('../services/tool-registry.js');
    const container = document.querySelector('#mcpServerList')!;
    const servers = await getMCPServers();
    const statuses = await getMCPServerStatuses();

    if (servers.length === 0) {
      container.innerHTML = '<p class="text-muted" style="margin:4px 0;font-size:11px;">未配置 MCP 服务器。MCP 允许连接外部工具服务。</p>';
      return;
    }

    container.innerHTML = servers.map(s => {
      const status = statuses.find(st => st.name === s.name);
      const running = status?.running || false;
      const toolCount = status?.toolCount || 0;
      return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-subtle);">
        <span style="width:8px;height:8px;border-radius:50%;background:${running ? 'var(--success)' : 'var(--text-muted)'};" title="${running ? '已连接' : '未连接'}"></span>
        <span style="flex:1;font-weight:500;">${s.name}</span>
        <span class="text-muted" style="font-size:11px;">${s.command} ${s.args.join(' ')}${running ? ` (${toolCount} 工具)` : ''}</span>
        <button class="btn btn-sm btn-outline mcp-toggle" data-name="${s.name}" style="padding:2px 8px;font-size:11px;">${s.enabled ? '禁用' : '启用'}</button>
        <button class="btn btn-sm btn-outline mcp-delete" data-name="${s.name}" style="padding:2px 8px;font-size:11px;color:var(--critical);">删除</button>
      </div>`;
    }).join('');

    container.querySelectorAll('.mcp-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = (btn as HTMLElement).dataset.name!;
        await toggleMCPServer(name);
        await refreshMCPTools();
        await renderMCPServerList();
      });
    });

    container.querySelectorAll('.mcp-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = (btn as HTMLElement).dataset.name!;
        await removeMCPServer(name);
        await refreshMCPTools();
        await renderMCPServerList();
      });
    });
  }

  document.querySelector('#btnAddMCPServer')!.addEventListener('click', async () => {
    const { addMCPServer } = await import('../services/mcp-client.js');
    const { refreshMCPTools } = await import('../services/tool-registry.js');
    const name = (document.querySelector('#inputMCPName') as HTMLInputElement).value.trim();
    const command = (document.querySelector('#inputMCPCommand') as HTMLInputElement).value.trim();
    const argsStr = (document.querySelector('#inputMCPArgs') as HTMLInputElement).value.trim();

    if (!name || !command) {
      showToast('请填写名称和命令', 'warning');
      return;
    }

    const args = argsStr ? argsStr.split(/\s+/) : [];
    await addMCPServer({ name, command, args, enabled: true });
    await refreshMCPTools();
    (document.querySelector('#inputMCPName') as HTMLInputElement).value = '';
    (document.querySelector('#inputMCPCommand') as HTMLInputElement).value = '';
    (document.querySelector('#inputMCPArgs') as HTMLInputElement).value = '';
    showToast(`MCP 服务器已添加: ${name}`, 'success');
    await renderMCPServerList();
  });

  // 设置面板打开时刷新 MCP 列表
  document.querySelector('#btnSettings')!.addEventListener('click', () => {
    setTimeout(renderMCPServerList, 100);
  });

  document.querySelector('#btnReleaseVRAM')!.addEventListener('click', async () => {
    const api = state.get<OllamaAPI>(KEYS.API);
    const model = (document.querySelector('#modelSelect') as HTMLSelectElement).value;
    logInfo('释放显存', model || '所有模型');
    try {
      await api!.chat({ model: model || 'any', messages: [], keep_alive: 0 });
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
    const bridge = window.metonaDesktop;
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
    const bridge = window.metonaDesktop;
    if (bridge?.isDesktop) {
      bridge.workspace.getDir().then((info: { dir: string }) => {
        inputWorkspaceDir.value = info.dir;
      }).catch(() => {});
    }
  }
  if (btnBrowseWorkspace) {
    btnBrowseWorkspace.addEventListener('click', async () => {
      const bridge = window.metonaDesktop;
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
      const bridge = window.metonaDesktop;
      if (!bridge?.isDesktop) return;
      const result = await bridge.workspace.setDir(newDir);
      if (result.success) {
        showToast('工作空间目录已更新', 'success');
        logSetting('工作空间目录', result.dir!);
      } else {
        showToast(`设置失败: ${result.error!}`, 'error');
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
  populateSubAgentModels();
  updateMemoryVectorStatus();
  loadTimeoutSettings();
}

export function closeSettingsModal(): void {
  settingsModalEl.style.display = 'none';
}

/** 加载已保存的超时设置到输入框：-1=默认(显示空), 0=禁用, 正数=自定义 */
async function loadTimeoutSettings(): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;

  const httpTimeout = await db.getSetting<number>('httpTimeout', -1);
  const streamTimeout = await db.getSetting<number>('streamTimeout', -1);
  const mcpTimeout = await db.getSetting<number>('mcpTimeout', -1);

  const inputHttp = document.querySelector('#inputHttpTimeout') as HTMLInputElement;
  const inputStream = document.querySelector('#inputStreamTimeout') as HTMLInputElement;
  const inputMCP = document.querySelector('#inputMCPTimeout') as HTMLInputElement;

  if (inputHttp) inputHttp.value = httpTimeout >= 0 ? String(httpTimeout) : '';
  if (inputStream) inputStream.value = streamTimeout >= 0 ? String(streamTimeout) : '';
  if (inputMCP) inputMCP.value = mcpTimeout >= 0 ? String(mcpTimeout) : '';
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
    const bridge = window.metonaDesktop;
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

async function populateSubAgentModels(): Promise<void> {
  const select = document.querySelector('#selectSubAgentModel') as HTMLSelectElement;
  if (!select) return;
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  try {
    const data = await api.listModels();
    if (!data.models?.length) return;

    // 保留第一个 "跟随当前模型" 选项，追加所有模型
    while (select.options.length > 1) select.remove(1);
    data.models
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name;
        select.appendChild(opt);
      });

    // 恢复已保存的选择
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) {
      const saved = await db.getSetting('subAgentModel', '');
      if (saved) select.value = saved;
    }
  } catch (err) {
    logWarn('加载子代理模型列表失败', (err as Error).message);
  }
}

// 子代理模型设置保存
document.querySelector('#selectSubAgentModel')?.addEventListener('change', async () => {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;
  const val = (document.querySelector('#selectSubAgentModel') as HTMLSelectElement).value;
  await db.saveSetting('subAgentModel', val);
  logSetting('子代理默认模型', val || '跟随当前模型');
});

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
    const bridge = window.metonaDesktop;
    const result = await bridge!.fs.readFileBase64(filePath);
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
    } else if (typeof data === 'object' && data !== null && 'sessions' in data && Array.isArray((data as Record<string, unknown>)['sessions'])) {
      sessions = (data as Record<string, unknown>)['sessions'] as ChatSession[];
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

