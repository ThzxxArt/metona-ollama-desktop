import { describe, it, expect, vi, afterEach } from 'vitest';
import { readSse } from '../src/main/llm/sse.js';

const encoder = new TextEncoder();

function responseFrom(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSE 解析', () => {
  it('无响应体时抛错', async () => {
    await expect(readSse(new Response(null), () => {})).rejects.toThrow('没有可读流');
  });

  it('解析 event、注释、CRLF、多行 data 与末尾无换行', async () => {
    const events: Array<{ event: string; data: string }> = [];
    await readSse(
      responseFrom(': comment\r\nevent: custom\r\ndata: {"a":1}\r\ndata: second\r\n\r\ndata: tail'),
      (event) => events.push(event),
    );
    expect(events).toEqual([
      { event: 'custom', data: '{"a":1}\nsecond' },
      { event: 'message', data: 'tail' },
    ]);
  });

  it('已中止的 signal 直接返回', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readSse(responseFrom('data: x\n\n'), () => {}, controller.signal)).resolves.toBeUndefined();
  });

  it('空 data 行不派发事件', async () => {
    const events: Array<{ event: string; data: string }> = [];
    await readSse(responseFrom('event: ping\n\n'), (event) => events.push(event));
    expect(events).toEqual([]);
  });
});
