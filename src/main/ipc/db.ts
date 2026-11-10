/**
 * SQLite / 会话 / 设置 / 轨迹 / 统计 IPC。
 */

import { ipcMain } from 'electron';
import { sendLog } from './shared.js';
import {
  saveSession,
  getSession,
  getAllSessions,
  deleteSession,
  clearAllSessions,
  saveMessage,
  saveMessagesBatch,
  getMessagesBySession,
  getMessageIds,
  deleteMessages,
  saveSetting,
  getSetting,
  saveSettingsBatch,
  saveTrace,
  saveTracesBatch,
  getTracesBySession,
  exportAllSessions,
  importSessions,
  getSessionSummaries,
  searchSessions,
  getAllSessionsData,
  getAllSessionsTokenStats,
  saveToolAudit,
  getToolAuditsBySession,
  getAllToolAudits,
  getAllMemoryEmbeddings,
  saveMemoryEmbedding,
  clearMemoryEmbeddings,
} from '../db/sqlite.js';
import type { ExportData, MessageRow } from '../db/sqlite.js';

export function registerDbIPC(): void {
  ipcMain.handle('db:saveSession', (_, session) => {
    try {
      return { success: true, id: saveSession(session) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:getSession', (_, id) => {
    try {
      return getSession(id);
    } catch {
      return null;
    }
  });
  ipcMain.handle('db:getAllSessions', () => {
    try {
      return getAllSessions();
    } catch {
      return [];
    }
  });
  ipcMain.handle('db:deleteSession', (_, id) => {
    try {
      deleteSession(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:clearAllSessions', () => {
    try {
      clearAllSessions();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('db:saveMessage', (_, msg) => {
    try {
      return { success: true, id: saveMessage(msg) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:saveMessagesBatch', (_, msgs: MessageRow[]) => {
    try {
      return { success: true, count: saveMessagesBatch(msgs) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:getMessages', (_, sessionId) => {
    try {
      return getMessagesBySession(sessionId);
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:getMessageIds', (_, sessionId: string) => {
    try {
      return getMessageIds(String(sessionId || ''));
    } catch {
      return [];
    }
  });
  ipcMain.handle('db:deleteMessages', (_, sessionId: string, ids: string[]) => {
    try {
      return {
        success: true,
        deleted: deleteMessages(String(sessionId || ''), Array.isArray(ids) ? ids.map(String) : []),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('db:getSessionSummaries', () => {
    try {
      return getSessionSummaries();
    } catch (err) {
      sendLog('error', '获取会话摘要失败', (err as Error).message);
      return [];
    }
  });
  ipcMain.handle('db:searchSessions', (_, query: string) => {
    try {
      return searchSessions(String(query || ''));
    } catch (err) {
      sendLog('error', '搜索会话失败', (err as Error).message);
      return [];
    }
  });
  ipcMain.handle('db:getAllSessionsData', () => {
    try {
      return getAllSessionsData();
    } catch (err) {
      sendLog('error', '获取全量会话数据失败', (err as Error).message);
      return { sessions: [], messages: [] };
    }
  });

  ipcMain.handle('db:saveSetting', (_, key: string, value: unknown) => {
    try {
      saveSetting(key, value);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:saveSettingsBatch', (_, entries: Array<{ key: string; value: unknown }>) => {
    try {
      saveSettingsBatch(entries);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:getSetting', (_, key: string, defaultValue?: unknown) => {
    try {
      return getSetting(key, defaultValue ?? null);
    } catch {
      return defaultValue ?? null;
    }
  });

  ipcMain.handle('db:saveTrace', (_, trace) => {
    try {
      return { success: true, id: saveTrace(trace) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:saveTracesBatch', (_, traces) => {
    try {
      return { success: true, count: saveTracesBatch(traces) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:getTraces', (_, sessionId) => {
    try {
      return getTracesBySession(sessionId);
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:exportSessions', () => {
    try {
      return exportAllSessions();
    } catch (err) {
      sendLog('error', '导出失败', (err as Error).message);
      return null;
    }
  });
  ipcMain.handle('db:importSessions', (_, data: ExportData) => {
    try {
      return importSessions(data);
    } catch (err) {
      sendLog('error', '导入失败', (err as Error).message);
      return { imported: 0, skipped: 0 };
    }
  });

  ipcMain.handle('db:getMemoryEmbeddings', (_: unknown, model: string) => {
    try {
      return getAllMemoryEmbeddings(String(model || ''));
    } catch {
      return [];
    }
  });
  ipcMain.handle('db:saveMemoryEmbedding', (_: unknown, entryId: string, model: string, vector: number[]) => {
    try {
      saveMemoryEmbedding(String(entryId || ''), String(model || ''), Array.isArray(vector) ? vector : []);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:clearMemoryEmbeddings', () => {
    try {
      clearMemoryEmbeddings();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('db:getAllTokenStats', () => {
    try {
      return getAllSessionsTokenStats();
    } catch (err) {
      sendLog('error', '获取全局 Token 统计失败', (err as Error).message);
      return null;
    }
  });

  ipcMain.handle('db:saveToolAudit', (_: unknown, audit: unknown) => {
    try {
      return { success: true, id: saveToolAudit(audit as Parameters<typeof saveToolAudit>[0]) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:getToolAudits', (_: unknown, sessionId: string) => {
    try {
      return { success: true, audits: getToolAuditsBySession(sessionId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('db:getAllToolAudits', (_: unknown, limit?: number) => {
    try {
      return { success: true, audits: getAllToolAudits(limit || 200) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}
