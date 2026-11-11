/**
 * SettingsModal - 设置面板组件
 */

import { state, KEYS } from '../state/state.js';
import { debounce } from '../utils/utils.js';
import { logSetting, logInfo, logWarn, logError, logSuccess } from '../services/log-service.js';
import { checkConnection, updateConnectionInfo, updateRunningModels } from './header.js';
import { initConnectionSettings, refreshConnectionSettingsUI } from '../features/settings/connection.js';
import {
  exportAllSessions,
  importSessions,
  populateSubAgentModels,
  populateEmbeddingModels,
} from '../features/settings/data.js';
import { showToast } from './toast.js';
import { showConfirm } from './prompt-modal.js';
import { OllamaAPI } from '../api/ollama.js';
import { ChatDB } from '../db/chat-db.js';

let settingsModalEl: HTMLElement;

export function initSettingsModal(): void {
  settingsModalEl = document.querySelector('#settingsModal')!;

  document.querySelector('#btnSettings')!.addEventListener('click', openSettingsModal);
  document.querySelector('#btnCloseSettings')!.addEventListener('click', closeSettingsModal);
  settingsModalEl.addEventListener('click', (e) => {
    if (e.target === settingsModalEl) closeSettingsModal();
  });

  // ── 主题选择 ──
  document.querySelector('#selectTheme')?.addEventListener('change', async () => {
    const mode = (document.querySelector('#selectTheme') as HTMLSelectElement).value as 'light' | 'dark' | 'auto';
    // 直接内联实现主题切换，避免动态导入 main.ts（入口模块不可安全导出函数）
    localStorage.setItem('metona-theme', mode);
    let effective: 'light' | 'dark';
    if (mode === 'auto') {
      effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } else {
      effective = mode;
    }
    document.documentElement.setAttribute('data-theme', effective);
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', effective === 'dark' ? '#1A1B26' : '#FAF7F2');
    }
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) await db.saveSetting('themeMode', mode);
    logInfo(`主题已切换: ${mode === 'auto' ? '跟随系统' : mode === 'dark' ? '暗色' : '亮色'}`);
  });

  initConnectionSettings();

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

  // 辅助：解析输入值，空→-1(默认)，数字→该值(含0=禁用)
  const parseSec = (val: string): number => (val !== '' ? parseInt(val) : -1);

  const saveHttpTimeout = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const sec = parseSec(inputHttpTimeout.value.trim());
    const ms = sec >= 0 ? sec * 1000 : 900_000;
    if (db) await db.saveSetting('httpTimeout', sec);
    const bridge = window.metonaDesktop;
    if (bridge?.tool?.setTimeouts) {
      await bridge.tool.setTimeouts({ http: ms });
    }
    logSetting('HTTP 超时', sec >= 0 ? (sec === 0 ? '已禁用' : `${sec}s`) : '默认(900s)');
  }, 500);

  const saveStreamTimeout = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const sec = parseSec(inputStreamTimeout.value.trim());
    const ms = sec >= 0 ? sec * 1000 : -1;
    state.set('streamTimeout', ms);
    if (db) await db.saveSetting('streamTimeout', sec);
    logSetting('流式超时', sec >= 0 ? (sec === 0 ? '已禁用' : `${sec}s`) : '默认(动态)');
  }, 500);

  const saveMCPTimeout = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const sec = parseSec(inputMCPTimeout.value.trim());
    const ms = sec >= 0 ? sec * 1000 : 60_000;
    if (db) await db.saveSetting('mcpTimeout', sec);
    const bridge = window.metonaDesktop;
    if (bridge?.tool?.setTimeouts) {
      await bridge.tool.setTimeouts({ mcp: ms });
    }
    logSetting('MCP 超时', sec >= 0 ? (sec === 0 ? '已禁用' : `${sec}s`) : '默认(60s)');
  }, 500);

  inputHttpTimeout.addEventListener('input', saveHttpTimeout);
  inputStreamTimeout.addEventListener('input', saveStreamTimeout);
  inputMCPTimeout.addEventListener('input', saveMCPTimeout);

  // ── v5.0 MCP 服务器管理 ──
  async function renderMCPServerList(): Promise<void> {
    const { getMCPServers, getMCPServerStatuses, toggleMCPServer, removeMCPServer } =
      await import('../services/mcp-client.js');
    const { refreshMCPTools } = await import('../services/tool-registry.js');
    const container = document.querySelector('#mcpServerList')!;
    const servers = await getMCPServers();
    const statuses = await getMCPServerStatuses();

    if (servers.length === 0) {
      container.innerHTML =
        '<p class="text-muted" style="margin:4px 0;font-size:11px;">未配置 MCP 服务器。MCP 允许连接外部工具服务。</p>';
      return;
    }

    container.innerHTML = servers
      .map((s) => {
        const status = statuses.find((st) => st.name === s.name);
        const running = status?.running || false;
        const toolCount = status?.toolCount || 0;
        return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-subtle);">
        <span style="width:8px;height:8px;border-radius:50%;background:${running ? 'var(--success)' : 'var(--text-muted)'};" title="${running ? '已连接' : '未连接'}"></span>
        <span style="flex:1;font-weight:500;">${s.name}</span>
        <span class="text-muted" style="font-size:11px;">${s.command} ${s.args.join(' ')}${running ? ` (${toolCount} 工具)` : ''}</span>
        <button class="btn btn-sm btn-outline mcp-toggle" data-name="${s.name}" style="padding:2px 8px;font-size:11px;">${s.enabled ? '禁用' : '启用'}</button>
        <button class="btn btn-sm btn-outline mcp-delete" data-name="${s.name}" style="padding:2px 8px;font-size:11px;color:var(--critical);">删除</button>
      </div>`;
      })
      .join('');

    container.querySelectorAll('.mcp-toggle').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = (btn as HTMLElement).dataset.name!;
        await toggleMCPServer(name);
        await refreshMCPTools();
        await renderMCPServerList();
      });
    });

    container.querySelectorAll('.mcp-delete').forEach((btn) => {
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
    const api = state.get<OllamaAPI | null>(KEYS.API, null);
    if (!api) {
      showToast('Ollama API 未连接', 'warning');
      return;
    }
    const connection =
      state.get<{ mode: 'local' | 'remote'; remoteKind: 'cloud' | 'self-hosted' } | null>('connection', null) ??
      (await window.metonaDesktop?.ollama?.getConfig());
    if (connection?.mode === 'remote' && connection.remoteKind === 'cloud') {
      showToast('Ollama Cloud 模型由服务端管理，不支持本地卸载', 'warning');
      return;
    }
    if (
      connection?.mode === 'remote' &&
      !(await showConfirm('远程服务器可能被多人共享，释放模型可能影响其他用户。继续？', '释放远程显存'))
    ) {
      return;
    }
    logInfo('释放显存');
    try {
      const result = await api.unloadModels(true);
      if (result.success) {
        showToast(result.unloaded > 0 ? `已释放 ${result.unloaded} 个模型` : '没有运行中的模型', 'success');
        logSuccess('显存已释放');
      } else {
        showToast(`释放失败: ${result.error || '未知错误'}`, 'error');
      }
      updateRunningModels();
    } catch (err) {
      showToast(`释放失败: ${(err as Error).message}`, 'error');
      logError('释放显存失败', (err as Error).message);
    }
  });

  document.querySelector('#btnClearAllHistory')!.addEventListener('click', async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (!db) {
      showToast('数据库未就绪', 'warning');
      return;
    }
    if (await showConfirm('确定清空所有历史记录？此操作不可恢复！', '清空历史')) {
      logWarn('清空所有历史记录');
      await db.clearAll();
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
      filters: [{ name: 'Metona 备份', extensions: ['metona'] }],
    });
    if (!paths || paths.length === 0) return;
    await importSessions(paths[0]);
  });

  // ── 工作空间目录设置 ──
  const inputWorkspaceDir = document.querySelector('#inputWorkspaceDir') as HTMLInputElement;
  const btnBrowseWorkspace = document.querySelector('#btnBrowseWorkspace') as HTMLButtonElement;
  if (inputWorkspaceDir) {
    // 加载当前工作空间目录
    const bridge = window.metonaDesktop;
    if (bridge?.isDesktop) {
      bridge.workspace
        .getDir()
        .then((info: { dir: string }) => {
          inputWorkspaceDir.value = info.dir;
        })
        .catch(() => {});
    }
  }
  if (btnBrowseWorkspace) {
    btnBrowseWorkspace.addEventListener('click', async () => {
      const bridge = window.metonaDesktop;
      if (!bridge?.isDesktop) return;
      const paths = await bridge.dialog.openDirectory();
      if (paths && paths.length > 0) {
        inputWorkspaceDir.value = paths[0];
        inputWorkspaceDir.dispatchEvent(new Event('blur'));
      }
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
        // ── 通知工作空间面板刷新目录 ──
        window.dispatchEvent(new CustomEvent('workspaceDirChanged', { detail: { dir: result.dir } }));
        // ── 初始化新工作空间的 MEMORY.md ──
        import('../services/memory-service.js').then(({ initMemoryFile }) => {
          initMemoryFile().catch(() => {});
        });
      } else {
        showToast(`设置失败: ${result.error!}`, 'error');
        // 恢复原值
        const info = await bridge.workspace.getDir();
        inputWorkspaceDir.value = info.dir;
      }
    });
  }

  // ── 子代理权限上限（AI 请求的权限只降不升）──
  const selectSubAgentPermission = document.querySelector('#selectSubAgentPermission') as HTMLSelectElement | null;
  if (selectSubAgentPermission) {
    selectSubAgentPermission.addEventListener('change', async () => {
      const db = state.get<ChatDB | null>(KEYS.DB);
      const val = selectSubAgentPermission.value as 'readonly' | 'limited_write' | 'full_write';
      state.set('subAgentMaxPermission', val);
      if (db) await db.saveSetting('subAgentMaxPermission', val);
      const permNames: Record<string, string> = { readonly: '只读', limited_write: '有限写入', full_write: '完整写入' };
      logSetting('子代理权限上限', permNames[val] || val);
    });
  }

  // ── 子代理相关设置（原顶层事件监听器移入此处，确保 DOM 已就绪）──
  // 子代理模型设置保存
  document.querySelector('#selectSubAgentModel')?.addEventListener('change', async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (!db) return;
    const val = (document.querySelector('#selectSubAgentModel') as HTMLSelectElement).value;
    await db.saveSetting('subAgentModel', val);
    logSetting('子代理默认模型', val || '跟随当前模型');
  });

  // 子代理最大轮次
  const saveSubAgentMaxLoops = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const val = (document.querySelector('#inputSubAgentMaxLoops') as HTMLInputElement).value.trim();
    const maxLoops = val ? parseInt(val) : 10;
    state.set('subAgentMaxLoops', maxLoops);
    if (db) await db.saveSetting('subAgentMaxLoops', maxLoops);
    logSetting('子代理最大轮次', `${maxLoops} 轮`);
  }, 500);
  document.querySelector('#inputSubAgentMaxLoops')!.addEventListener('input', saveSubAgentMaxLoops);

  // 子代理超时（秒）
  const saveSubAgentTimeout = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const val = (document.querySelector('#inputSubAgentTimeout') as HTMLInputElement).value.trim();
    const sec = val ? parseInt(val) : -1; // -1=默认
    const ms = sec >= 0 ? sec * 1000 : 300_000;
    state.set('subAgentTimeout', ms);
    if (db) await db.saveSetting('subAgentTimeout', sec);
    logSetting('子代理超时', sec >= 0 ? (sec === 0 ? '已禁用' : `${sec}s`) : '默认(300s)');
  }, 500);
  document.querySelector('#inputSubAgentTimeout')!.addEventListener('input', saveSubAgentTimeout);

  // ── 看门狗超时（分钟，0=禁用）──
  const saveLoopWatchdog = debounce(async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const val = (document.querySelector('#inputLoopWatchdog') as HTMLInputElement).value.trim();
    const minutes = val ? parseInt(val) : -1;
    const ms = minutes > 0 ? minutes * 60_000 : minutes === 0 ? 0 : 1_800_000; // 默认30分钟
    state.set('loopWatchdogMs', ms);
    if (db) await db.saveSetting('loopWatchdogMs', ms);
    logSetting('看门狗超时', minutes >= 0 ? (minutes === 0 ? '已禁用' : `${minutes}分钟`) : '默认(30分钟)');
  }, 500);
  document.querySelector('#inputLoopWatchdog')!.addEventListener('input', saveLoopWatchdog);

  // ── 混合记忆检索（关键词 + embedding）──
  const toggleMemoryEmbedding = document.querySelector('#toggleMemoryEmbedding') as HTMLInputElement | null;
  const selectMemoryEmbeddingModel = document.querySelector('#selectMemoryEmbeddingModel') as HTMLSelectElement | null;
  toggleMemoryEmbedding?.addEventListener('change', async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const enabled = toggleMemoryEmbedding.checked;
    state.set('memoryEmbeddingEnabled', enabled);
    if (db) await db.saveSetting('memoryEmbeddingEnabled', enabled);
    logSetting('语义记忆检索', enabled ? '启用' : '关闭');
  });
  selectMemoryEmbeddingModel?.addEventListener('change', async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const model = selectMemoryEmbeddingModel.value;
    state.set('memoryEmbeddingModel', model);
    if (db) await db.saveSetting('memoryEmbeddingModel', model);
    logSetting('Embedding 模型', model || '未选择');
  });

  // ── 更新检查开关 ──
  const toggleCheckUpdates = document.querySelector('#toggleCheckUpdates') as HTMLInputElement | null;
  toggleCheckUpdates?.addEventListener('change', async () => {
    const db = state.get<ChatDB | null>(KEYS.DB);
    const enabled = toggleCheckUpdates.checked;
    if (db) await db.saveSetting('checkUpdates', enabled);
    logSetting('启动检查更新', enabled ? '开启' : '关闭');
  });
}

export function openSettingsModal(): void {
  settingsModalEl.style.display = '';
  const bridge = window.metonaDesktop;
  void refreshConnectionSettingsUI();
  updateConnectionInfo();
  updateRunningModels();
  loadTimeoutSettings();
  loadWatchdogSetting();
  loadThemeSetting();
  // 刷新子代理模型下拉列表
  populateSubAgentModels().catch(() => {});
  populateEmbeddingModels().catch(() => {});
  // 刷新工作空间目录显示
  if (bridge?.isDesktop) {
    const wsInput = document.querySelector('#inputWorkspaceDir') as HTMLInputElement;
    if (wsInput) {
      bridge.workspace
        .getDir()
        .then((info: { dir: string }) => {
          wsInput.value = info.dir;
        })
        .catch(() => {});
    }
  }
  // 更新检查开关
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (db) {
    db.getSetting<boolean>('checkUpdates', true)
      .then((enabled) => {
        const toggle = document.querySelector('#toggleCheckUpdates') as HTMLInputElement | null;
        if (toggle) toggle.checked = enabled;
      })
      .catch(() => {});
  }
}

/** 加载看门狗设置到输入框 */
async function loadWatchdogSetting(): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;
  const ms = await db.getSetting<number>('loopWatchdogMs', 1_800_000);
  const el = document.querySelector('#inputLoopWatchdog') as HTMLInputElement;
  if (!el) return;
  if (ms === 0) el.value = '0';
  else if (ms > 0) el.value = String(Math.round(ms / 60_000));
  else el.value = '';
}

export function closeSettingsModal(): void {
  settingsModalEl.style.display = 'none';
}

/** 加载主题设置到下拉框 */
async function loadThemeSetting(): Promise<void> {
  const saved = (localStorage.getItem('metona-theme') || 'auto') as 'light' | 'dark' | 'auto';
  const select = document.querySelector('#selectTheme') as HTMLSelectElement | null;
  if (select) select.value = saved;
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
