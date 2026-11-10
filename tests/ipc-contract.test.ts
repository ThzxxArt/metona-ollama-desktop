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
      mode: 'remote',
      remoteUrl: 'https://ollama.com',
      contextLength: 131072,
      remoteAutoUnload: true,
    });
    expect(result.success).toBe(true);
  });

  it('连接 patch 拒绝未知字段与越界上下文', () => {
    expect(connectionPatchSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(connectionPatchSchema.safeParse({ contextLength: 1 }).success).toBe(false);
    expect(connectionPatchSchema.safeParse({ contextLength: 99_999_999 }).success).toBe(false);
  });

  it('chat body 校验 model 与非流式字段', () => {
    expect(chatBodySchema.safeParse({ model: 'qwen3', messages: [] }).success).toBe(true);
    expect(chatBodySchema.safeParse({ model: '', messages: [] }).success).toBe(false);
    expect(chatBodySchema.safeParse({ model: 'qwen3', messages: [], think: 'high' }).success).toBe(true);
    expect(chatBodySchema.safeParse({ model: 'qwen3', messages: [], think: 'max' }).success).toBe(false);
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
