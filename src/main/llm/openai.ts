/**
 * OpenAI Chat Completions 兼容适配器。
 * 负责把 Ollama 归一化请求转换为 /v1/chat/completions，并把响应/SSE
 * 转回渲染层现有的 OllamaStreamChunk 结构。
 */

import { randomUUID } from 'node:crypto';
import { buildProviderApiUrl } from '../../shared/ollama-url.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type OllamaChatRequestBody,
  type OllamaEmbedResponse,
  type OllamaModelsResponse,
  type OllamaShowResponse,
  type OllamaStreamChunk,
  type OllamaTestResult,
} from '../../shared/contracts/ollama.js';
import { loadOllamaSettings } from '../ollama/config.js';
import { getOllamaSecretStore } from '../ollama/secret-store.js';
import { OllamaRequestError } from '../ollama/errors.js';
import { providerFetch, providerJson } from './transport.js';
import { readSse } from './sse.js';
import {
  inferProviderCapabilities,
  isRecord,
  normalizeMessages,
  parseToolArguments,
  providerHeaders,
  toOpenAIMessages,
  type NormalizedToolCall,
} from './shared.js';

const SERVICE = 'OpenAI 兼容接口';

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIRawToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessageResponse {
  content?: string | null;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: OpenAIRawToolCall[];
}

interface OpenAIChoice {
  message?: OpenAIMessageResponse;
  delta?: OpenAIMessageResponse;
  finish_reason?: string | null;
}

interface OpenAIChatResponse {
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
}

const DEFAULT_SESSION_ID: string = randomUUID();

function authHeaders(sessionId: string = DEFAULT_SESSION_ID): Record<string, string> {
  const headers = providerHeaders('openai', getOllamaSecretStore().get('openai'));
  headers['User-Agent'] = 'Metona-Ollama-Desktop';
  // OpenCode Go 要求每个会话携带稳定 ID；其他 OpenAI 兼容服务会忽略此头。
  headers['x-opencode-session'] = sessionId;
  return headers;
}

function serviceOptions(signal?: AbortSignal) {
  return { service: SERVICE, signal };
}

function mapFinishReason(reason: string | null | undefined): string {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_calls';
  return reason || 'stop';
}

function usageFields(usage: OpenAIUsage | undefined): Partial<OllamaStreamChunk> {
  if (!usage) return {};
  return {
    ...(typeof usage.completion_tokens === 'number' && { eval_count: usage.completion_tokens }),
    ...(typeof usage.prompt_tokens === 'number' && { prompt_eval_count: usage.prompt_tokens }),
    ...(typeof usage.prompt_tokens_details?.cached_tokens === 'number' && {
      prompt_eval_cached_count: usage.prompt_tokens_details.cached_tokens,
    }),
  };
}

function parseToolCalls(raw: OpenAIRawToolCall[] | undefined): NormalizedToolCall[] {
  if (!raw?.length) return [];
  const out: NormalizedToolCall[] = [];
  for (const call of raw) {
    const name = call.function?.name;
    if (!name) continue;
    out.push({
      type: 'function',
      function: { name, arguments: parseToolArguments(call.function?.arguments) },
    });
  }
  return out;
}

function buildPayload(body: OllamaChatRequestBody, stream: boolean): Record<string, unknown> {
  const settings = loadOllamaSettings();
  const messages = toOpenAIMessages(normalizeMessages(body.messages));
  if (body.system) messages.unshift({ role: 'system', content: body.system });
  const maxOutputTokens = settings.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS;
  // OpenAI 推理模型要求 max_completion_tokens；其余兼容接口仍普遍使用 max_tokens。
  const reasoningModel = /^(o1|o3|o4|gpt-5)/i.test(body.model) || /reasoning/i.test(body.model);
  const thinkLevel = body.think === true ? 'medium' : typeof body.think === 'string' ? body.think : '';
  // OpenAI 没有 max 档位，映射到最高的 high。
  const reasoningEffort = thinkLevel === 'max' ? 'high' : thinkLevel;
  return {
    model: body.model,
    messages,
    stream,
    [reasoningModel ? 'max_completion_tokens' : 'max_tokens']: maxOutputTokens,
    ...(reasoningModel && reasoningEffort && { reasoning_effort: reasoningEffort }),
    ...(body.tools?.length && { tools: body.tools, tool_choice: 'auto' }),
  };
}

function toOllamaResponse(body: OllamaChatRequestBody, data: OpenAIChatResponse): OllamaStreamChunk {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const content = typeof message?.content === 'string' ? message.content : '';
  const thinking = message?.reasoning_content || message?.reasoning || '';
  const toolCalls = parseToolCalls(message?.tool_calls);
  return {
    model: data.model || body.model,
    message: {
      role: 'assistant',
      content,
      ...(thinking && { thinking }),
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    },
    done: true,
    done_reason: mapFinishReason(choice?.finish_reason),
    ...usageFields(data.usage),
  };
}

export async function listModels(): Promise<OllamaModelsResponse> {
  const settings = loadOllamaSettings();
  const url = buildProviderApiUrl(settings.openaiUrl, '/models');
  const data = await providerJson<{ data?: unknown[] }>(
    url,
    { method: 'GET', headers: authHeaders() },
    serviceOptions(),
  );
  const models = Array.isArray(data.data)
    ? data.data
        .map((item) => (isRecord(item) && typeof item.id === 'string' ? { name: item.id } : null))
        .filter((item): item is { name: string } => item !== null)
    : [];
  return { models };
}

export async function testConnection(): Promise<OllamaTestResult> {
  const started = Date.now();
  try {
    const models = await listModels();
    return {
      ok: true,
      provider: 'openai',
      version: 'compatible',
      modelCount: models.models.length,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof OllamaRequestError) {
      return { ok: false, provider: 'openai', error: err.message, errorKind: err.kind };
    }
    return { ok: false, provider: 'openai', error: (err as Error).message, errorKind: 'unknown' };
  }
}

export async function showModel(model: string): Promise<OllamaShowResponse> {
  const settings = loadOllamaSettings();
  return {
    capabilities: inferProviderCapabilities(model),
    model_info: { 'provider.context_length': settings.contextLength },
  };
}

export async function chat(body: OllamaChatRequestBody, signal?: AbortSignal): Promise<unknown> {
  const settings = loadOllamaSettings();
  const url = buildProviderApiUrl(settings.openaiUrl, '/chat/completions');
  const data = await providerJson<OpenAIChatResponse>(
    url,
    {
      method: 'POST',
      headers: authHeaders(body.session_id),
      body: JSON.stringify(buildPayload(body, false)),
      signal,
    },
    serviceOptions(signal),
  );
  return toOllamaResponse(body, data);
}

export async function chatStream(
  body: OllamaChatRequestBody,
  onChunk: (chunk: OllamaStreamChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const settings = loadOllamaSettings();
  const url = buildProviderApiUrl(settings.openaiUrl, '/chat/completions');
  const response = await providerFetch(
    url,
    {
      method: 'POST',
      headers: authHeaders(body.session_id),
      body: JSON.stringify(buildPayload(body, true)),
      signal,
    },
    serviceOptions(signal),
  );

  const toolCalls = new Map<number, { name: string; arguments: string }>();
  let finishReason = '';
  let usage: OpenAIUsage | undefined;

  await readSse(
    response,
    ({ data }) => {
      if (data.trim() === '[DONE]') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;
      if (isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        throw new OllamaRequestError(parsed.error.message, 'server');
      }
      if (isRecord(parsed.usage)) usage = parsed.usage as OpenAIUsage;
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (const rawChoice of choices) {
        if (!isRecord(rawChoice)) continue;
        const delta = isRecord(rawChoice.delta) ? rawChoice.delta : null;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content) {
            onChunk({ message: { role: 'assistant', content: delta.content } });
          }
          const reasoning =
            typeof delta.reasoning_content === 'string'
              ? delta.reasoning_content
              : typeof delta.reasoning === 'string'
                ? delta.reasoning
                : '';
          if (reasoning) onChunk({ message: { role: 'assistant', thinking: reasoning } });
          const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          for (const rawCall of rawToolCalls) {
            if (!isRecord(rawCall)) continue;
            const index = typeof rawCall.index === 'number' ? rawCall.index : 0;
            const entry = toolCalls.get(index) ?? { name: '', arguments: '' };
            const fn = isRecord(rawCall.function) ? rawCall.function : null;
            if (fn && typeof fn.name === 'string') entry.name += fn.name;
            if (fn && typeof fn.arguments === 'string') entry.arguments += fn.arguments;
            toolCalls.set(index, entry);
          }
        }
        if (typeof rawChoice.finish_reason === 'string') finishReason = rawChoice.finish_reason;
      }
    },
    signal,
  );

  if (signal?.aborted) return;
  const parsedCalls: NormalizedToolCall[] = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => ({
      type: 'function' as const,
      function: { name: entry.name, arguments: parseToolArguments(entry.arguments) },
    }))
    .filter((call) => call.function.name);
  onChunk({
    model: body.model,
    message: {
      role: 'assistant',
      ...(parsedCalls.length > 0 && { tool_calls: parsedCalls }),
    },
    done: true,
    done_reason: mapFinishReason(finishReason),
    ...usageFields(usage),
  });
}

export async function embed(model: string, input: string): Promise<OllamaEmbedResponse> {
  const settings = loadOllamaSettings();
  const url = buildProviderApiUrl(settings.openaiUrl, '/embeddings');
  const data = await providerJson<{ data?: unknown[] }>(
    url,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model, input }),
    },
    serviceOptions(),
  );
  const first = Array.isArray(data.data) ? data.data[0] : undefined;
  if (isRecord(first) && Array.isArray(first.embedding)) {
    const embedding = first.embedding.filter((value): value is number => typeof value === 'number');
    return { embedding };
  }
  return { embedding: [] };
}
