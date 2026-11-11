/**
 * 设置面板数据功能：备份导出/导入、模型下拉填充。
 */

import { state, KEYS } from '../../state/state.js';
import type { ChatDB } from '../../db/chat-db.js';
import type { OllamaAPI } from '../../api/ollama.js';
import type { ChatSession } from '../../types.js';
import { showToast } from '../../components/toast.js';
import { showConfirm, showPrompt } from '../../components/prompt-modal.js';
import { encryptData, decryptData } from '../../services/crypto.js';
import { logError, logInfo, logSuccess, logWarn } from '../../services/log-service.js';
import { getSessionSummariesBackup, restoreSessionSummariesBackup } from '../../services/context-manager.js';
import { getMetricsBackup, restoreMetricsBackup } from '../../services/agent-metrics.js';
import { getTraceFallbackBackup, restoreTraceFallbackBackup } from '../../services/agent-engine.js';

export async function exportAllSessions(): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;
  const sessions = await db.getAllSessions();
  if (sessions.length === 0) {
    showToast('没有可导出的会话', 'warning');
    return;
  }

  const backup = {
    app: 'Metona Ollama Client',
    version: 3,
    exportedAt: new Date().toISOString(),
    count: sessions.length,
    sessions,
    sessionSummaries: getSessionSummariesBackup(),
    metricsHistory: getMetricsBackup(),
    traceFallback: getTraceFallbackBackup(),
    theme: localStorage.getItem('metona-theme') || 'auto',
  };

  try {
    const password = await showPrompt({
      title: '设置备份密码（可选）',
      message:
        '设置密码后将使用 PBKDF2 + AES-256-GCM 加密；留空则仅防误读，不是安全边界。旧版 v1/v2 备份不再支持导入。',
      type: 'password',
      placeholder: '留空 = 无密码',
    });
    if (password === null) return;
    if (!password) {
      const ok = await showConfirm('不设置密码时，任何拿到备份文件的人都能读取内容。继续导出？', '无密码导出');
      if (!ok) return;
    }
    const blob = await encryptData(backup, password || '');
    const ts = new Date().toISOString().slice(0, 10);

    const bridge = window.metonaDesktop;
    if (bridge) {
      const filePath = await bridge.dialog.saveFile({
        defaultPath: `metona-backup-${ts}.metona`,
        filters: [{ name: 'Metona 备份', extensions: ['metona'] }],
      });
      if (!filePath) return;
      const b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('读取备份数据失败'));
        reader.readAsDataURL(blob);
      });
      const result = await bridge.fs.writeFile(filePath, b64, 'base64');
      if (!result.success) {
        showToast(`导出失败: ${result.error}`, 'error');
        logError('导出失败', result.error);
        return;
      }
    } else {
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

export async function importSessions(filePath: string): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  if (!fileName.endsWith('.metona')) {
    showToast('仅支持导入 .metona 格式文件', 'error');
    return;
  }

  try {
    const bridge = window.metonaDesktop;
    if (!bridge) {
      showToast('仅桌面端支持导入', 'warning');
      return;
    }
    const result = await bridge.fs.readFileBase64(filePath);
    if (!result.success) {
      showToast(`读取文件失败: ${result.error}`, 'error');
      return;
    }
    const binary = atob(result.content as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    let data: unknown;
    try {
      data = await decryptData(bytes.buffer);
    } catch (err) {
      if ((err as Error).message.includes('密码')) {
        const password = await showPrompt({
          title: '输入备份密码',
          message: (err as Error).message,
          type: 'password',
          placeholder: '备份密码',
        });
        if (password === null) return;
        data = await decryptData(bytes.buffer, password);
      } else {
        throw err;
      }
    }
    logInfo('导入会话', `文件: ${fileName}`);

    let sessions: ChatSession[];
    if (Array.isArray(data)) {
      sessions = data as ChatSession[];
    } else if (
      typeof data === 'object' &&
      data !== null &&
      'sessions' in data &&
      Array.isArray((data as Record<string, unknown>)['sessions'])
    ) {
      sessions = (data as Record<string, unknown>)['sessions'] as ChatSession[];
    } else {
      showToast('文件内容格式错误：未找到会话数据', 'error');
      return;
    }

    const importResult = await db.importSessions(sessions);
    const dataObj = (data as Record<string, unknown>) || {};
    if (Array.isArray(dataObj.sessionSummaries)) {
      restoreSessionSummariesBackup(dataObj.sessionSummaries as Parameters<typeof restoreSessionSummariesBackup>[0]);
    }
    if (Array.isArray(dataObj.metricsHistory)) {
      restoreMetricsBackup(dataObj.metricsHistory as Parameters<typeof restoreMetricsBackup>[0]);
    }
    if (Array.isArray(dataObj.traceFallback)) {
      restoreTraceFallbackBackup(dataObj.traceFallback as Parameters<typeof restoreTraceFallbackBackup>[0]);
    }
    if (typeof dataObj.theme === 'string' && dataObj.theme) {
      localStorage.setItem('metona-theme', dataObj.theme);
      document.documentElement.setAttribute('data-theme', dataObj.theme === 'dark' ? 'dark' : 'light');
    }

    showToast(
      `导入完成：${importResult.imported} 个会话${importResult.skipped > 0 ? `，跳过 ${importResult.skipped} 个` : ''}`,
      'success',
      4000,
    );
    logSuccess(`导入完成: ${importResult.imported} 个, 跳过 ${importResult.skipped} 个`);
  } catch (err) {
    showToast(`导入失败: ${(err as Error).message}`, 'error');
    logError('导入失败', (err as Error).message);
  }
}

export async function populateSubAgentModels(): Promise<void> {
  const select = document.querySelector('#selectSubAgentModel') as HTMLSelectElement;
  if (!select) return;
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  try {
    const data = await api.listModels();
    if (!data.models?.length) return;
    while (select.options.length > 1) select.remove(1);
    data.models
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name;
        select.appendChild(opt);
      });
    const db = state.get<ChatDB | null>(KEYS.DB);
    if (db) {
      const saved = await db.getSetting('subAgentModel', '');
      if (saved) select.value = saved;
    }
  } catch (err) {
    logWarn('加载子代理模型列表失败', (err as Error).message);
  }
}

export async function populateEmbeddingModels(): Promise<void> {
  const select = document.querySelector('#selectMemoryEmbeddingModel') as HTMLSelectElement | null;
  if (!select) return;
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;
  try {
    const data = await api.listModels();
    const current =
      state.get<string>('memoryEmbeddingModel', '') ||
      String((await state.get<ChatDB | null>(KEYS.DB)?.getSetting('memoryEmbeddingModel', '')) || '');
    while (select.options.length > 1) select.remove(1);
    (data.models || [])
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name;
        select.appendChild(opt);
      });
    if (current) select.value = current;
  } catch (err) {
    logWarn('加载 embedding 模型列表失败', (err as Error).message);
  }
}
