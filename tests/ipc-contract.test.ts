import { describe, it, expect } from 'vitest';
import {
  chatBodySchema,
  connectionPatchSchema,
  embedInputSchema,
  apiKeySchema,
} from '../src/shared/schemas/ollama.schema.js';

describe('IPC zod 契约', () => {
  it('连接 patch 接受合法字段', () => {
    const result = connectionPatchSchema.safeParse({
      provider: 'openai',
      mode: 'remote',
      remoteUrl: 'https://ollama.com',
      openaiUrl: 'https://api.openai.com',
      anthropicUrl: 'https://api.anthropic.com',
      contextLength: 131072,
      maxOutputTokens: 4096,
      remoteAutoUnload: true,
    });
    expect(result.success).toBe(true);
  });

  it('连接 patch 拒绝未知 provider、未知字段与越界上下文', () => {
    expect(connectionPatchSchema.safeParse({ provider: 'gemini' }).success).toBe(false);
    expect(connectionPatchSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(connectionPatchSchema.safeParse({ contextLength: 1 }).success).toBe(false);
    expect(connectionPatchSchema.safeParse({ contextLength: 99_999_999 }).success).toBe(false);
    expect(connectionPatchSchema.safeParse({ maxOutputTokens: 1 }).success).toBe(false);
    expect(connectionPatchSchema.safeParse({ maxOutputTokens: 999_999 }).success).toBe(false);
    expect(connectionPatchSchema.safeParse({ maxOutputTokens: 4096 }).success).toBe(true);
  });

  it('chat body 校验 model 与非流式字段', () => {
    expect(chatBodySchema.safeParse({ model: 'qwen3', messages: [] }).success).toBe(true);
    expect(chatBodySchema.safeParse({ model: '', messages: [] }).success).toBe(false);
    expect(chatBodySchema.safeParse({ model: 'qwen3', messages: [], think: 'high' }).success).toBe(true);
    expect(chatBodySchema.safeParse({ model: 'qwen3', messages: [], think: 'max' }).success).toBe(true);
    expect(chatBodySchema.safeParse({ model: 'qwen3', messages: [], session_id: 'session-1' }).success).toBe(true);
  });

  it('embed 入参校验', () => {
    expect(embedInputSchema.safeParse({ model: 'nomic-embed-text', input: 'hello' }).success).toBe(true);
    expect(embedInputSchema.safeParse({ model: '', input: 'hello' }).success).toBe(false);
  });

  it('API Key 长度限制', () => {
    expect(apiKeySchema.safeParse('sk-123').success).toBe(true);
    expect(apiKeySchema.safeParse('x'.repeat(9000)).success).toBe(false);
  });
});
