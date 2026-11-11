/**
 * SQLite / 会话 / 设置 / 轨迹 / 统计 IPC。
 * 所有通道均经过发送方校验与入参校验。
 */

import { z } from 'zod';
import { sendLog } from './shared.js';
import { handleTrusted, parseArgs } from './register.js';
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
import type { ExportData, MessageRow, SessionRow, TraceRow } from '../db/sqlite.js';

const idSchema = z.string().min(1).max(512);
const keySchema = z.string().min(1).max(256);

const sessionRowSchema: z.ZodType<SessionRow> = z
  .object({
    id: idSchema,
    title: z.string().max(2000),
    model: z.string().max(512),
    system_prompt: z.string().nullable(),
    parent_id: z.string().max(512).nullable(),
    status: z.string().max(64),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();

const messageRowSchema: z.ZodType<MessageRow> = z
  .object({
    id: idSchema,
    session_id: idSchema,
    role: z.string().min(1).max(32),
    content: z.string().nullable(),
    thinking: z.string().nullable(),
    images: z.string().nullable(),
    tool_calls: z.string().nullable(),
    tool_name: z.string().nullable(),
    attachments: z.string().nullable(),
    eval_count: z.number().int().nullable(),
    prompt_eval_count: z.number().int().nullable(),
    total_duration: z.number().int().nullable(),
    created_at: z.number().int(),
  })
  .strict();

const traceRowSchema: z.ZodType<TraceRow> = z
  .object({
    id: idSchema,
    session_id: idSchema,
    step_index: z
      .number()
      .int()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    thought: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    action: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    action_input: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    observation: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    loop_count: z
      .number()
      .int()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    error_pattern: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    created_at: z.number().int(),
  })
  .strict();

const settingEntrySchema = z.object({ key: keySchema, value: z.unknown() }).strict();

const exportDataSchema: z.ZodType<ExportData> = z.object({
  sessions: z.array(sessionRowSchema).max(100_000),
  messages: z.array(messageRowSchema).max(1_000_000),
  settings: z.array(settingEntrySchema).max(10_000),
  exportedAt: z.number().int(),
});

const toolAuditSchema = z
  .object({
    id: idSchema.optional(),
    session_id: idSchema,
    tool_name: z.string().min(1).max(128),
    args_json: z.string().nullable(),
    result_status: z.string().nullable(),
    result_summary: z.string().nullable(),
    duration_ms: z.number().int().nullable(),
    created_at: z.number().int(),
  })
  .strict();

const memoryVectorSchema = z.array(z.number().finite()).min(1).max(16_384);

export function registerDbIPC(): void {
  handleTrusted('db:saveSession', (_, rawSession: unknown) => {
    try {
      return { success: true, id: saveSession(parseArgs(sessionRowSchema, rawSession)) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:getSession', (_, rawId: unknown) => {
    try {
      return getSession(parseArgs(idSchema, rawId));
    } catch {
      return null;
    }
  });
  handleTrusted('db:getAllSessions', () => {
    try {
      return getAllSessions();
    } catch {
      return [];
    }
  });
  handleTrusted('db:deleteSession', (_, rawId: unknown) => {
    try {
      deleteSession(parseArgs(idSchema, rawId));
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:clearAllSessions', () => {
    try {
      clearAllSessions();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  handleTrusted('db:saveMessage', (_, rawMsg: unknown) => {
    try {
      return { success: true, id: saveMessage(parseArgs(messageRowSchema, rawMsg)) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:saveMessagesBatch', (_, rawMsgs: unknown) => {
    try {
      const msgs = parseArgs(z.array(messageRowSchema).max(100_000), rawMsgs);
      return { success: true, count: saveMessagesBatch(msgs) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:getMessages', (_, rawSessionId: unknown) => {
    try {
      return getMessagesBySession(parseArgs(idSchema, rawSessionId));
    } catch {
      return [];
    }
  });

  handleTrusted('db:getMessageIds', (_, rawSessionId: unknown) => {
    try {
      return getMessageIds(parseArgs(idSchema, rawSessionId));
    } catch {
      return [];
    }
  });
  handleTrusted('db:deleteMessages', (_, rawSessionId: unknown, rawIds: unknown) => {
    try {
      const sessionId = parseArgs(idSchema, rawSessionId);
      const ids = parseArgs(z.array(idSchema).max(100_000), rawIds);
      return { success: true, deleted: deleteMessages(sessionId, ids) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  handleTrusted('db:getSessionSummaries', () => {
    try {
      return getSessionSummaries();
    } catch (err) {
      sendLog('error', '获取会话摘要失败', (err as Error).message);
      return [];
    }
  });
  handleTrusted('db:searchSessions', (_, rawQuery: unknown) => {
    try {
      return searchSessions(parseArgs(z.string().max(2000), rawQuery));
    } catch (err) {
      sendLog('error', '搜索会话失败', (err as Error).message);
      return [];
    }
  });
  handleTrusted('db:getAllSessionsData', () => {
    try {
      return getAllSessionsData();
    } catch (err) {
      sendLog('error', '获取全量会话数据失败', (err as Error).message);
      return { sessions: [], messages: [] };
    }
  });

  handleTrusted('db:saveSetting', (_, rawKey: unknown, value: unknown) => {
    try {
      saveSetting(parseArgs(keySchema, rawKey), value);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:saveSettingsBatch', (_, rawEntries: unknown) => {
    try {
      saveSettingsBatch(parseArgs(z.array(settingEntrySchema).max(10_000), rawEntries));
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:getSetting', (_, rawKey: unknown, defaultValue?: unknown) => {
    try {
      return getSetting(parseArgs(keySchema, rawKey), defaultValue ?? null);
    } catch {
      return defaultValue ?? null;
    }
  });

  handleTrusted('db:saveTrace', (_, rawTrace: unknown) => {
    try {
      return { success: true, id: saveTrace(parseArgs(traceRowSchema, rawTrace)) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:saveTracesBatch', (_, rawTraces: unknown) => {
    try {
      const traces = parseArgs(z.array(traceRowSchema).max(100_000), rawTraces);
      return { success: true, count: saveTracesBatch(traces) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:getTraces', (_, rawSessionId: unknown) => {
    try {
      return getTracesBySession(parseArgs(idSchema, rawSessionId));
    } catch {
      return [];
    }
  });

  handleTrusted('db:exportSessions', () => {
    try {
      return exportAllSessions();
    } catch (err) {
      sendLog('error', '导出失败', (err as Error).message);
      return null;
    }
  });
  handleTrusted('db:importSessions', (_, rawData: unknown) => {
    try {
      return importSessions(parseArgs(exportDataSchema, rawData));
    } catch (err) {
      sendLog('error', '导入失败', (err as Error).message);
      // 让渲染进程收到 reject，避免把校验失败当成“导入 0 个会话”的成功
      throw err;
    }
  });

  handleTrusted('db:getMemoryEmbeddings', (_, rawModel: unknown) => {
    try {
      return getAllMemoryEmbeddings(parseArgs(z.string().min(1).max(512), rawModel));
    } catch {
      return [];
    }
  });
  handleTrusted('db:saveMemoryEmbedding', (_, rawEntryId: unknown, rawModel: unknown, rawVector: unknown) => {
    try {
      const entryId = parseArgs(idSchema, rawEntryId);
      const model = parseArgs(z.string().min(1).max(512), rawModel);
      const vector = parseArgs(memoryVectorSchema, rawVector);
      saveMemoryEmbedding(entryId, model, vector);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:clearMemoryEmbeddings', () => {
    try {
      clearMemoryEmbeddings();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  handleTrusted('db:getAllTokenStats', () => {
    try {
      return getAllSessionsTokenStats();
    } catch (err) {
      sendLog('error', '获取全局 Token 统计失败', (err as Error).message);
      return null;
    }
  });

  handleTrusted('db:saveToolAudit', (_, rawAudit: unknown) => {
    try {
      const audit = parseArgs(toolAuditSchema, rawAudit);
      return { success: true, id: saveToolAudit(audit) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:getToolAudits', (_, rawSessionId: unknown) => {
    try {
      return { success: true, audits: getToolAuditsBySession(parseArgs(idSchema, rawSessionId)) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  handleTrusted('db:getAllToolAudits', (_, rawLimit?: unknown) => {
    try {
      const limit = rawLimit === undefined ? 200 : parseArgs(z.number().int().min(1).max(10_000), rawLimit);
      return { success: true, audits: getAllToolAudits(limit) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}
