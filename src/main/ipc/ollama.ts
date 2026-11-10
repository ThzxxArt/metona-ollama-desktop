/**
 * Ollama IPC：所有 Ollama 请求的唯一入口。
 * 流式响应通过 webContents.send 推送给渲染进程，主进程持有 AbortController。
 */

import { ipcMain, type WebContents } from 'electron';
import { randomUUID } from 'crypto';
import { getOllamaConnectionView, loadOllamaSettings, saveOllamaSettings } from '../ollama/config.js';
import { getOllamaSecretStore } from '../ollama/secret-store.js';
import * as client from '../ollama/client.js';
import { toProxyError } from '../ollama/errors.js';
import type { OllamaChatRequestBody, OllamaStreamChunk } from '../../shared/contracts/ollama.js';
import {
  apiKeySchema,
  chatBodySchema,
  connectionPatchSchema,
  embedInputSchema,
  modelNameSchema,
  streamIdSchema,
} from '../../shared/schemas/ollama.schema.js';
import { handleTrusted, parseArgs, redactLog } from './register.js';

interface ActiveStream {
  controller: AbortController;
  sender: WebContents;
}

const activeStreams = new Map<string, ActiveStream>();

function sendChunk(sender: WebContents, streamId: string, chunk: OllamaStreamChunk): void {
  if (sender.isDestroyed()) return;
  sender.send('ollama:chat:chunk', { streamId, chunk });
}

function sendDone(sender: WebContents, streamId: string, error?: ReturnType<typeof toProxyError>): void {
  if (sender.isDestroyed()) return;
  sender.send('ollama:chat:done', { streamId, error });
}

export function registerOllamaIPC(): void {
  handleTrusted('ollama:config:get', () => getOllamaConnectionView());

  handleTrusted('ollama:config:set', (_event, patch: unknown) => {
    const parsed = parseArgs(connectionPatchSchema, patch ?? {});
    saveOllamaSettings(parsed);
    return getOllamaConnectionView();
  });

  handleTrusted('ollama:key:set', async (_event, key: unknown) => {
    const parsed = parseArgs(apiKeySchema, key);
    const result = await getOllamaSecretStore().set(parsed);
    // 不允许明文进入日志
    console.log(`[ollama] API Key 已${result.persisted ? '加密保存' : '载入内存'}`);
    return { success: result.success, hasApiKey: getOllamaSecretStore().has(), error: result.error };
  });

  handleTrusted('ollama:key:clear', () => {
    getOllamaSecretStore().clear();
    return { success: true, hasApiKey: false };
  });

  handleTrusted('ollama:test', () => client.testConnection());
  handleTrusted('ollama:models', () => client.listModels());
  handleTrusted('ollama:ps', () => client.psModels());

  handleTrusted('ollama:show', (_event, model: unknown) => client.showModel(parseArgs(modelNameSchema, model)));

  handleTrusted('ollama:embed', async (_event, payload: unknown) => {
    const { model, input } = parseArgs(embedInputSchema, payload);
    const response = await client.embed(model, input);
    const vector = response.embedding ?? response.embeddings?.[0] ?? [];
    return { embedding: vector };
  });

  handleTrusted('ollama:chat', async (_event, body: unknown) => {
    const parsed = parseArgs(chatBodySchema, body) as OllamaChatRequestBody;
    return client.chat(parsed);
  });

  handleTrusted('ollama:chat:start', (event, body: unknown, requestedId?: unknown) => {
    const parsed = parseArgs(chatBodySchema, body) as OllamaChatRequestBody;
    const streamId = requestedId === undefined ? randomUUID() : parseArgs(streamIdSchema, requestedId);
    if (activeStreams.has(streamId)) {
      throw new Error('streamId 已存在');
    }
    const controller = new AbortController();
    const sender = event.sender;
    activeStreams.set(streamId, { controller, sender });

    void (async () => {
      const queue: OllamaStreamChunk[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flush = (): void => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (queue.length === 0) return;
        const batch = queue.splice(0, queue.length);
        for (const chunk of batch) sendChunk(sender, streamId, chunk);
      };

      const onChunk = (chunk: OllamaStreamChunk): void => {
        queue.push(chunk);
        // 16ms 合并，降低 IPC 频率
        if (!flushTimer) flushTimer = setTimeout(flush, 16);
      };

      try {
        await client.chatStream(parsed, onChunk, controller.signal);
        flush();
        sendDone(sender, streamId);
      } catch (err) {
        flush();
        const proxyError = toProxyError(err);
        console.warn(`[ollama] 流式请求失败: ${redactLog(proxyError.message)}`);
        sendDone(sender, streamId, proxyError);
      } finally {
        activeStreams.delete(streamId);
      }
    })();

    return { streamId };
  });

  handleTrusted('ollama:chat:abort', (_event, streamId: unknown) => {
    const id = parseArgs(streamIdSchema, streamId);
    const active = activeStreams.get(id);
    if (!active) return { success: false };
    active.controller.abort();
    activeStreams.delete(id);
    sendDone(active.sender, id, { kind: 'aborted', message: '请求已取消' });
    return { success: true };
  });

  handleTrusted('ollama:unload', async (_event, options: unknown) => {
    const manual = Boolean((options as { manual?: boolean } | undefined)?.manual);
    return client.unloadModels({ manual });
  });

  // 退出时取消所有流
  ipcMain.on('ollama:abort-all', () => {
    for (const [id, active] of activeStreams) {
      active.controller.abort();
      sendDone(active.sender, id, { kind: 'aborted', message: '应用正在退出' });
    }
    activeStreams.clear();
  });

  // 启动时打印连接摘要（不包含 Key）
  const view = getOllamaConnectionView();
  const settings = loadOllamaSettings();
  console.log(
    `[ollama] 模式=${settings.mode} 地址=${settings.mode === 'local' ? settings.localUrl : settings.remoteUrl} 类型=${settings.remoteKind} Key=${view.hasApiKey ? '已配置' : '未配置'}`,
  );
}

export function abortAllOllamaStreams(): void {
  for (const [id, active] of activeStreams) {
    active.controller.abort();
    sendDone(active.sender, id, { kind: 'aborted', message: '应用正在退出' });
  }
  activeStreams.clear();
}
