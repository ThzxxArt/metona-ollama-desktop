/**
 * Anthropic Messages API 兼容适配器。
 * 把 Ollama 归一化请求转换为 /v1/messages，并解析 Anthropic SSE 事件。
 */

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
  toAnthropicMessages,
  toAnthropicTools,
  type NormalizedToolCall,
} from './shared.js';

const SERVICE = 'Anthropic 兼容接口';

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  model?: string;
  content?: unknown[];
  stop_reason?: string;
  usage?: AnthropicUsage;
  error?: { message?: string };
}

function authHeaders(): Record<string, string> {
  return providerHeaders('anthropic', getOllamaSecretStore().get('anthropic'));
}

function serviceOptions(signal?: AbortSignal) {
  return { service: SERVICE, signal };
}

function mapStopReason(reason: string | undefined): string {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return reason || 'stop';
}

function usageFields(usage: AnthropicUsage | undefined): Partial<OllamaStreamChunk> {
  if (!usage) return {};
  return {
    ...(typeof usage.output_tokens === 'number' && { eval_count: usage.output_tokens }),
    ...(typeof usage.input_tokens === 'number' && { prompt_eval_count: usage.input_tokens }),
    ...(typeof usage.cache_read_input_tokens === 'number' && {
      prompt_eval_cached_count: usage.cache_read_input_tokens,
    }),
  };
}

function buildPayload(body: OllamaChatRequestBody, stream: boolean): Record<string, unknown> {
  const settings = loadOllamaSettings();
  const converted = toAnthropicMessages(normalizeMessages(body.messages));
  const system = [body.system, converted.system].filter((part): part is string => Boolean(part)).join('\n\n');
  const tools = toAnthropicTools(body.tools);
  const maxTokens = settings.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS;
  const thinkLevel = body.think === true ? 'medium' : typeof body.think === 'string' ? body.think : '';
  const thinkingBudgets: Record<string, number> = { low: 1024, medium: 2048, high: 4096, max: 8192 };
  const levelBudget = thinkingBudgets[thinkLevel] ?? 0;
  const thinkingModel = /claude-(3-7|4|.*-4)|thinking/i.test(body.model);
  // Anthropic 要求 budget_tokens < max_tokens；max 档位受最大输出 Token 上限约束。
  const thinkingBudget = Math.min(levelBudget, maxTokens - 1024);
  return {
    model: body.model,
    max_tokens: maxTokens,
    messages: converted.messages,
    stream,
    ...(system && { system }),
    ...(tools?.length && { tools }),
    ...(thinkingModel && thinkingBudget >= 1024
      ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } }
      : {}),
  };
}

function parseToolCalls(content: unknown[] | undefined): NormalizedToolCall[] {
  if (!content?.length) return [];
  const out: NormalizedToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    if (typeof block.name !== 'string' || !block.name) continue;
    out.push({
      type: 'function',
      function: {
        name: block.name,
        arguments: isRecord(block.input) ? block.input : {},
      },
    });
  }
  return out;
}

function toOllamaResponse(body: OllamaChatRequestBody, data: AnthropicResponse): OllamaStreamChunk {
  let content = '';
  let thinking = '';
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') content += block.text;
      if (block.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking;
    }
  }
  const toolCalls = parseToolCalls(data.content);
  return {
    model: data.model || body.model,
    message: {
      role: 'assistant',
      content,
      ...(thinking && { thinking }),
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    },
    done: true,
    done_reason: mapStopReason(data.stop_reason),
    ...usageFields(data.usage),
  };
}

export async function listModels(): Promise<OllamaModelsResponse> {
  const settings = loadOllamaSettings();
  const url = buildProviderApiUrl(settings.anthropicUrl, '/models');
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
      provider: 'anthropic',
      version: 'compatible',
      modelCount: models.models.length,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof OllamaRequestError) {
      return { ok: false, provider: 'anthropic', error: err.message, errorKind: err.kind };
    }
    return { ok: false, provider: 'anthropic', error: (err as Error).message, errorKind: 'unknown' };
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
  const url = buildProviderApiUrl(settings.anthropicUrl, '/messages');
  const data = await providerJson<AnthropicResponse>(
    url,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(buildPayload(body, false)),
      signal,
    },
    serviceOptions(signal),
  );
  if (data.error?.message) throw new OllamaRequestError(data.error.message, 'server');
  return toOllamaResponse(body, data);
}

export async function chatStream(
  body: OllamaChatRequestBody,
  onChunk: (chunk: OllamaStreamChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const settings = loadOllamaSettings();
  const url = buildProviderApiUrl(settings.anthropicUrl, '/messages');
  const response = await providerFetch(
    url,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(buildPayload(body, true)),
      signal,
    },
    serviceOptions(signal),
  );

  interface ToolAccumulator {
    id: string;
    name: string;
    initialInput: Record<string, unknown>;
    partialJson: string;
  }

  const tools = new Map<number, ToolAccumulator>();
  let finishReason = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedTokens: number | undefined;
  let emitted = false;

  const emitDone = (): void => {
    if (emitted) return;
    emitted = true;
    const parsedCalls: NormalizedToolCall[] = [...tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => ({
        type: 'function' as const,
        function: {
          name: entry.name,
          arguments: entry.partialJson ? parseToolArguments(entry.partialJson) : entry.initialInput,
        },
      }))
      .filter((call) => call.function.name);
    onChunk({
      model: body.model,
      message: {
        role: 'assistant',
        ...(parsedCalls.length > 0 && { tool_calls: parsedCalls }),
      },
      done: true,
      done_reason: mapStopReason(finishReason),
      ...usageFields({
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedTokens,
      }),
    });
  };

  await readSse(
    response,
    ({ event, data }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;
      const type = typeof parsed.type === 'string' ? parsed.type : event;
      if (type === 'error') {
        const error = isRecord(parsed.error) ? parsed.error : null;
        throw new OllamaRequestError(
          typeof error?.message === 'string' ? error.message : 'Anthropic 流式请求失败',
          'server',
        );
      }
      if (type === 'message_start') {
        const message = isRecord(parsed.message) ? parsed.message : null;
        const usage = message && isRecord(message.usage) ? message.usage : null;
        if (usage && typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
        if (usage && typeof usage.cache_read_input_tokens === 'number') cachedTokens = usage.cache_read_input_tokens;
        return;
      }
      if (type === 'content_block_start') {
        const index = typeof parsed.index === 'number' ? parsed.index : 0;
        const block = isRecord(parsed.content_block) ? parsed.content_block : null;
        if (block?.type === 'tool_use') {
          tools.set(index, {
            id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : '',
            initialInput: isRecord(block.input) ? block.input : {},
            partialJson: '',
          });
        }
        return;
      }
      if (type === 'content_block_delta') {
        const delta = isRecord(parsed.delta) ? parsed.delta : null;
        if (!delta) return;
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          onChunk({ message: { role: 'assistant', content: delta.text } });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          onChunk({ message: { role: 'assistant', thinking: delta.thinking } });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const index = typeof parsed.index === 'number' ? parsed.index : 0;
          const entry = tools.get(index);
          if (entry) entry.partialJson += delta.partial_json;
        }
        return;
      }
      if (type === 'message_delta') {
        const delta = isRecord(parsed.delta) ? parsed.delta : null;
        if (delta && typeof delta.stop_reason === 'string') finishReason = delta.stop_reason;
        const usage = isRecord(parsed.usage) ? parsed.usage : null;
        if (usage && typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
        return;
      }
      if (type === 'message_stop') emitDone();
    },
    signal,
  );

  if (!signal?.aborted) emitDone();
}

export async function embed(_model: string, _input: string): Promise<OllamaEmbedResponse> {
  throw new OllamaRequestError('Anthropic 兼容接口不提供 embeddings 接口，将回退关键词记忆检索', 'not-found');
}
