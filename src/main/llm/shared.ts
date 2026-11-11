/**
 * 第三方 LLM 协议适配的共享转换：
 * - Ollama 归一化消息 → OpenAI Chat Completions / Anthropic Messages
 * - 工具定义与工具调用 ID 配对
 * - 模型能力推断与认证头
 */

import type { LlmProvider } from '../../shared/contracts/ollama.js';

export interface NormalizedToolCall {
  type?: 'function';
  function: {
    name: string;
    arguments: unknown;
  };
}

export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: string[];
  thinking?: string;
  tool_calls?: NormalizedToolCall[];
  tool_name?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function parseToolCall(value: unknown): NormalizedToolCall | null {
  if (!isRecord(value)) return null;
  const fn = value.function;
  if (!isRecord(fn) || typeof fn.name !== 'string' || !fn.name) return null;
  return {
    type: 'function',
    function: { name: fn.name, arguments: fn.arguments },
  };
}

/** 把 IPC 传入的 unknown[] 收敛为可安全转换的消息结构 */
export function normalizeMessages(raw: unknown[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const role = item.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') continue;
    const images = Array.isArray(item.images)
      ? item.images.filter((image): image is string => typeof image === 'string' && image.length > 0)
      : undefined;
    const toolCalls = Array.isArray(item.tool_calls)
      ? item.tool_calls.map(parseToolCall).filter((call): call is NormalizedToolCall => call !== null)
      : undefined;
    out.push({
      role,
      content: typeof item.content === 'string' ? item.content : '',
      ...(images?.length && { images }),
      ...(typeof item.thinking === 'string' && item.thinking && { thinking: item.thinking }),
      ...(toolCalls?.length && { tool_calls: toolCalls }),
      ...(typeof item.tool_name === 'string' && item.tool_name && { tool_name: item.tool_name }),
    });
  }
  return out;
}

function imageMediaType(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('R0lG')) return 'image/gif';
  if (base64.startsWith('UklG')) return 'image/webp';
  return 'image/jpeg';
}

function imageDataUrl(base64: string): string {
  return `data:${imageMediaType(base64)};base64,${base64}`;
}

export interface OpenAIContentPartText {
  type: 'text';
  text: string;
}

export interface OpenAIContentPartImage {
  type: 'image_url';
  image_url: { url: string };
}

export type OpenAIContentPart = OpenAIContentPartText | OpenAIContentPartImage;

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface PendingToolId {
  id: string;
  name: string;
}

/**
 * 将 Ollama 风格历史转换为 OpenAI Chat Completions 消息。
 * Ollama 的 tool 消息只有 tool_name，没有 tool_call_id；这里按顺序补齐。
 */
export function toOpenAIMessages(messages: NormalizedMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const pending: PendingToolId[] = [];
  let counter = 0;

  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const toolCalls: OpenAIToolCall[] = (message.tool_calls ?? []).map((call) => {
        counter += 1;
        const id = `call_${counter}`;
        pending.push({ id, name: call.function.name });
        return {
          id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: JSON.stringify(parseToolArguments(call.function.arguments)),
          },
        };
      });
      out.push({
        role: 'assistant',
        content: toolCalls.length > 0 ? message.content || null : message.content,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      });
      continue;
    }

    if (message.role === 'tool') {
      let index = pending.findIndex((entry) => entry.name === message.tool_name);
      if (index < 0) index = 0;
      const pendingTool = pending.splice(index, 1)[0];
      out.push({
        role: 'tool',
        tool_call_id: pendingTool?.id ?? `call_${++counter}`,
        content: message.content,
      });
      continue;
    }

    if (message.images?.length) {
      const parts: OpenAIContentPart[] = [];
      if (message.content) parts.push({ type: 'text', text: message.content });
      for (const image of message.images) {
        parts.push({ type: 'image_url', image_url: { url: imageDataUrl(image) } });
      }
      out.push({ role: 'user', content: parts });
    } else {
      out.push({ role: 'user', content: message.content });
    }
  }

  return out;
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicRequestMessages {
  system: string;
  messages: AnthropicMessage[];
}

function pushAnthropicMessage(
  messages: AnthropicMessage[],
  role: 'user' | 'assistant',
  blocks: AnthropicContentBlock[],
): void {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

/** 将 Ollama 风格历史转换为 Anthropic Messages 消息与顶层 system */
export function toAnthropicMessages(messages: NormalizedMessage[]): AnthropicRequestMessages {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  const pending: PendingToolId[] = [];
  let counter = 0;

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) systemParts.push(message.content);
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        counter += 1;
        const id = `call_${counter}`;
        pending.push({ id, name: call.function.name });
        blocks.push({
          type: 'tool_use',
          id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
      pushAnthropicMessage(out, 'assistant', blocks);
      continue;
    }

    if (message.role === 'tool') {
      let index = pending.findIndex((entry) => entry.name === message.tool_name);
      if (index < 0) index = 0;
      const pendingTool = pending.splice(index, 1)[0];
      const toolUseId = pendingTool?.id ?? `call_${++counter}`;
      pushAnthropicMessage(out, 'user', [{ type: 'tool_result', tool_use_id: toolUseId, content: message.content }]);
      continue;
    }

    const blocks: AnthropicContentBlock[] = [];
    if (message.content) blocks.push({ type: 'text', text: message.content });
    for (const image of message.images ?? []) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: imageMediaType(image), data: image },
      });
    }
    pushAnthropicMessage(out, 'user', blocks);
  }

  return { system: systemParts.join('\n\n'), messages: out };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** 把 Agent 的 OpenAI 风格工具定义转换为 Anthropic tools */
export function toAnthropicTools(tools: unknown[] | undefined): AnthropicTool[] | undefined {
  if (!tools?.length) return undefined;
  const out: AnthropicTool[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const fn = tool.function;
    if (!isRecord(fn) || typeof fn.name !== 'string' || !fn.name) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      input_schema: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
    });
  }
  return out.length > 0 ? out : undefined;
}

/** 第三方接口没有统一的模型能力字段，按常见模型名做保守推断 */
export function inferProviderCapabilities(_model: string): string[] {
  // 第三方服务商当前不存在不支持图片/推理的模型，统一开放完整能力，
  // 避免按模型名推断导致上传与 Think 档位被误禁用。
  return ['completion', 'tools', 'vision', 'thinking'];
}

export function providerHeaders(provider: LlmProvider, apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = String(apiKey || '').trim();
  if (!key) return headers;
  if (provider === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    // 兼容部分只接受 Bearer 的 Anthropic 协议网关
    headers.Authorization = `Bearer ${key}`;
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}
