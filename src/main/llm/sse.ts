/**
 * Server-Sent Events 解析（OpenAI / Anthropic 流式接口共用）。
 */

export interface SseEvent {
  event: string;
  data: string;
}

export async function readSse(
  response: Response,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('LLM 响应没有可读流');

  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return;
    }
    const data = dataLines.join('\n');
    dataLines = [];
    const name = eventName;
    eventName = 'message';
    onEvent({ event: name, data });
  };

  const onAbort = (): void => {
    reader.cancel().catch(() => {});
  };
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim() || 'message';
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }

    if (buffer.trim()) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    dispatch();
  } catch (err) {
    if (signal?.aborted) return;
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
