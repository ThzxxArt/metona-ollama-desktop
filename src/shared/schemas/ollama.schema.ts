/**
 * Ollama IPC 入参校验（zod）
 * 仅主进程导入；渲染进程只使用 contracts 中的类型。
 */

import { z } from 'zod';
import { MAX_CONTEXT_LENGTH, MIN_CONTEXT_LENGTH } from '../contracts/ollama.js';

export const ollamaModeSchema = z.enum(['local', 'remote']);
export const remoteKindSchema = z.enum(['cloud', 'self-hosted']);

export const connectionPatchSchema = z
  .object({
    mode: ollamaModeSchema.optional(),
    localUrl: z.string().max(2048).optional(),
    remoteUrl: z.string().max(2048).optional(),
    remoteKind: remoteKindSchema.optional(),
    contextLength: z.number().int().min(MIN_CONTEXT_LENGTH).max(MAX_CONTEXT_LENGTH).optional(),
    remoteAutoUnload: z.boolean().optional(),
    requestTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
  })
  .strict();

export const apiKeySchema = z.string().max(8192);

export const chatBodySchema = z
  .object({
    model: z.string().min(1).max(512),
    messages: z.array(z.unknown()).max(100_000),
    stream: z.boolean().optional(),
    think: z.union([z.boolean(), z.enum(['low', 'medium', 'high'])]).optional(),
    system: z.string().max(2_000_000).optional(),
    tools: z.array(z.unknown()).max(1024).optional(),
    keep_alive: z.union([z.number(), z.string().max(64)]).optional(),
    format: z.unknown().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const modelNameSchema = z.string().min(1).max(512);
export const embedInputSchema = z.object({
  model: modelNameSchema,
  input: z.string().max(2_000_000),
});
export const streamIdSchema = z.string().min(1).max(128);
