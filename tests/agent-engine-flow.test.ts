// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const definitions = [
    'read_file',
    'write_file',
    'list_directory',
    'search_files',
    'edit_file',
    'delete_file',
    'run_command',
    'web_search',
    'web_fetch',
    'memory',
    'git',
    'file_transfer',
    'download_file',
    'compress',
    'diff',
    'session',
    'spawn_task',
    'browser',
  ].map((name) => ({
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
  }));
  return {
    definitions,
    showToast: vi.fn(),
    executeTool: vi.fn(),
    needsConfirmation: vi.fn(() => false),
    setSubAgentConfirmHandler: vi.fn(),
    getRelevantToolDefinitions: vi.fn(() => definitions),
    getEnabledToolDefinitions: vi.fn(() => definitions),
    saveSessionSummary: vi.fn(),
    generateSessionSummary: vi.fn(() => ({ id: 'sum1', summary: 'summary' })),
    estimateTokens: vi.fn((text: string) => Math.ceil((text || '').length / 4)),
    compressWithLLM: vi.fn(async (messages: unknown[]) => messages),
    recordActualTokens: vi.fn(),
    recordBudgetUsage: vi.fn(),
    recordTokenUsage: vi.fn(),
    createCheckpoint: vi.fn(),
    resetTokenBudget: vi.fn(),
    setTokenBudgetNumCtx: vi.fn(),
    clearCheckpoints: vi.fn(),
    loadSessionSummaries: vi.fn(() => []),
    formatSessionSummariesForContext: vi.fn(() => ''),
    calculateContextStats: vi.fn(() => ({
      contentTokens: 10,
      usageRatio: 0.1,
      pressureInfo: { level: 'low' },
      compressDecision: { shouldCompress: false, urgency: 'low', reason: '' },
    })),
    getContextPressureLevel: vi.fn(() => ({ level: 'low' })),
    chooseCompressionStrategy: vi.fn(() => ({ strategy: 'skip', reason: '' })),
    mergeConsecutiveMessages: vi.fn((messages: unknown[]) => messages),
    generateTokenReport: vi.fn(() => ({})),
    formatTokenReport: vi.fn(() => ''),
    buildContext: vi.fn((messages: unknown[]) => [...messages]),
    shouldAutoCompress: vi.fn(() => false),
    search: vi.fn(async () => []),
    formatMemoryContext: vi.fn(() => ''),
    extractAndSaveMemories: vi.fn(async () => {}),
  };
});

vi.mock('../src/renderer/components/toast.js', () => ({ showToast: hoisted.showToast }));
vi.mock('../src/renderer/components/model-bar.js', () => ({ getEffectiveNumCtx: () => 8192 }));
vi.mock('../src/renderer/services/log-service.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  logDebug: vi.fn(),
  logToolStart: vi.fn(),
  logToolResult: vi.fn(),
  logAgentLoop: vi.fn(),
  logModelResponse: vi.fn(),
  logStreamProgress: vi.fn(),
  resetStreamProgress: vi.fn(),
}));
vi.mock('../src/renderer/services/tool-registry.js', () => ({
  TOOL_DEFINITIONS: hoisted.definitions,
  needsConfirmation: hoisted.needsConfirmation,
  setSubAgentConfirmHandler: hoisted.setSubAgentConfirmHandler,
  executeTool: hoisted.executeTool,
  getRelevantToolDefinitions: hoisted.getRelevantToolDefinitions,
  getEnabledToolDefinitions: hoisted.getEnabledToolDefinitions,
}));
vi.mock('../src/renderer/services/context-manager.js', () => ({
  estimateTokens: hoisted.estimateTokens,
  generateSessionSummary: hoisted.generateSessionSummary,
  saveSessionSummary: hoisted.saveSessionSummary,
  compressWithLLM: hoisted.compressWithLLM,
  recordActualTokens: hoisted.recordActualTokens,
  recordBudgetUsage: hoisted.recordBudgetUsage,
  recordTokenUsage: hoisted.recordTokenUsage,
  createCheckpoint: hoisted.createCheckpoint,
  resetTokenBudget: hoisted.resetTokenBudget,
  setTokenBudgetNumCtx: hoisted.setTokenBudgetNumCtx,
  clearCheckpoints: hoisted.clearCheckpoints,
  loadSessionSummaries: hoisted.loadSessionSummaries,
  formatSessionSummariesForContext: hoisted.formatSessionSummariesForContext,
  calculateContextStats: hoisted.calculateContextStats,
  getContextPressureLevel: hoisted.getContextPressureLevel,
  chooseCompressionStrategy: hoisted.chooseCompressionStrategy,
  mergeConsecutiveMessages: hoisted.mergeConsecutiveMessages,
  generateTokenReport: hoisted.generateTokenReport,
  formatTokenReport: hoisted.formatTokenReport,
  buildContext: hoisted.buildContext,
  shouldAutoCompress: hoisted.shouldAutoCompress,
  AUTO_COMPRESS_THRESHOLD: 0.8,
}));
vi.mock('../src/renderer/services/memory-service.js', () => ({
  search: hoisted.search,
  formatMemoryContext: hoisted.formatMemoryContext,
  extractAndSaveMemories: hoisted.extractAndSaveMemories,
}));
vi.mock('../src/renderer/services/agent/trace.js', () => ({
  getTraceFallbackBackup: () => [],
  restoreTraceFallbackBackup: vi.fn(),
  saveTrace: vi.fn(async () => {}),
  flushAllTraces: vi.fn(async () => {}),
}));

import { state, KEYS } from '../src/renderer/state/state.js';
import { runAgentLoop, type AgentCallbacks } from '../src/renderer/services/agent-engine.js';
import { setWorkspaceDirPath } from '../src/renderer/services/workspace-state.js';
import { setToolCache, getToolCacheKey } from '../src/renderer/services/agent/tool-planning.js';
import { registerHook, unregisterHook } from '../src/renderer/services/hooks.js';
import type { OllamaMessage, ToolCall } from '../src/renderer/types.js';

function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onThinking: vi.fn(),
    onContent: vi.fn(),
    onToolCallPrepare: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallResult: vi.fn(),
    onToolCallError: vi.fn(),
    onDone: vi.fn(),
    onConfirmTool: vi.fn(async () => true),
    onNewIteration: vi.fn(),
    onThinkingStart: vi.fn(),
    ...overrides,
  };
}

function makeApi(chatStream: (...args: any[]) => Promise<void>) {
  return { chatStream };
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { type: 'function', function: { name, arguments: args } };
}

function toolChunk(name: string, args: Record<string, unknown>) {
  return { message: { content: '', tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } };
}

function finalChunk(content: string, extra: Record<string, unknown> = {}) {
  return {
    message: { content },
    eval_count: 5,
    prompt_eval_count: 10,
    done_reason: 'stop',
    total_duration: 100,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.needsConfirmation.mockReturnValue(false);
  hoisted.executeTool.mockResolvedValue({ success: true, content: 'tool result' });
  hoisted.calculateContextStats.mockReturnValue({
    contentTokens: 10,
    usageRatio: 0.1,
    pressureInfo: { level: 'low' },
    compressDecision: { shouldCompress: false, urgency: 'low', reason: '' },
  });
  hoisted.getContextPressureLevel.mockReturnValue({ level: 'low' });
  hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'skip', reason: '' });
  hoisted.mergeConsecutiveMessages.mockImplementation((messages: unknown[]) => messages);
  hoisted.estimateTokens.mockImplementation((text: string) => Math.ceil((text || '').length / 4));

  state.set(
    KEYS.API,
    makeApi(async () => {}),
  );
  state.set('_defaultModel', 'test-model');
  state.set(KEYS.CURRENT_SESSION, { id: 'session-1', messages: [] });
  state.set('maxTurns', 10);
  state.set('loopWatchdogMs', 0);
  state.set('streamTimeout', 0);
  state.set(KEYS.NUM_CTX, 8192);
  state.set('thinkLevel', 'off');
  state.set('modelSupportsTools', true);
  state.set('httpTimeout', 900_000);
  state.set('_lastUserMessage', '');
  state.set(KEYS.ABORT_CONTROLLER, null);
  setWorkspaceDirPath('');
  delete (window as unknown as { metonaDesktop?: unknown }).metonaDesktop;
});

afterEach(() => {
  vi.useRealTimers();
  setWorkspaceDirPath('');
});

// ═══════════════════════════════════════════════════════════════
// 前置条件与无工具完成
// ═══════════════════════════════════════════════════════════════

describe('runAgentLoop 基础流程', () => {
  it('缺少模型时提示并不启动循环', async () => {
    state.set('_defaultModel', '');
    const callbacks = makeCallbacks();
    await runAgentLoop('hi', [], [], callbacks);
    expect(hoisted.showToast).toHaveBeenCalledWith('请先选择模型', 'error');
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });

  it('无工具调用时流式完成并生成会话摘要', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      onChunk({ message: { thinking: '思考中' } });
      onChunk(finalChunk('你好'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('问候', [], [], callbacks);

    expect(callbacks.onThinkingStart).toHaveBeenCalled();
    expect(callbacks.onThinking).toHaveBeenCalledWith('思考中');
    expect(callbacks.onContent).toHaveBeenCalledWith('你好');
    expect(callbacks.onDone).toHaveBeenCalledTimes(1);
    const [content, records, stats] = vi.mocked(callbacks.onDone).mock.calls[0];
    expect(content).toBe('你好');
    expect(records).toBeUndefined();
    expect(stats).toMatchObject({ eval_count: 5, prompt_eval_count: 10, done_reason: 'stop', total_duration: 100 });
    expect(stats!.ctx_tokens).toBeGreaterThan(0);
    expect(hoisted.generateSessionSummary).toHaveBeenCalled();
    expect(hoisted.saveSessionSummary).toHaveBeenCalled();
    expect(state.get('_loopState')).toBe('TERMINATED');
    expect(state.get(KEYS.ABORT_CONTROLLER)).toBeNull();
  });

  it('只有 thinking 无正文时以异常提示完成', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      onChunk({ message: { thinking: '只思考' }, eval_count: 1, prompt_eval_count: 2 });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('问', [], [], callbacks);
    expect(callbacks.onDone).toHaveBeenCalledWith('（模型未返回内容）', undefined, expect.anything());
  });

  it('onNewIteration 在多轮时收到上一轮工具与统计', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({
          ...toolChunk('read_file', { path: 'a.txt' }),
          eval_count: 7,
          prompt_eval_count: 11,
          total_duration: 50,
        });
      else onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('读文件', [], [], callbacks);
    expect(callbacks.onNewIteration).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'read_file' }) })]),
      expect.objectContaining({ prompt_eval_count: 11 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 工具执行
// ═══════════════════════════════════════════════════════════════

describe('runAgentLoop 工具执行', () => {
  it('执行工具后把结果写回上下文并继续完成', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('read_file', { path: 'a.txt' }));
      else onChunk(finalChunk('文件内容已读取'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('读文件', [], [], callbacks);

    expect(hoisted.executeTool).toHaveBeenCalledWith('read_file', { path: 'a.txt' });
    expect(callbacks.onToolCallPrepare).toHaveBeenCalled();
    expect(callbacks.onToolCallStart).toHaveBeenCalled();
    expect(callbacks.onToolCallResult).toHaveBeenCalledWith(
      'read_file',
      expect.objectContaining({ success: true }),
      expect.anything(),
    );
    expect(callbacks.onDone).toHaveBeenCalledWith(
      '文件内容已读取',
      expect.arrayContaining([expect.objectContaining({ name: 'read_file', status: 'success' })]),
      expect.anything(),
    );

    const secondMessages = (chatStream.mock.calls[1][0] as Record<string, any>).messages as Array<Record<string, any>>;
    const toolMsg = secondMessages.find((m) => m.role === 'tool');
    expect(toolMsg!.content).toContain('<<<TOOL_RESULT_START name="read_file">>>');
    expect(toolMsg!.content).toContain('[工具:read_file 状态:success');
    expect(toolMsg!.content).toContain('<<<TOOL_RESULT_END>>>');
  });

  it('写工具确认通过后执行并写入审计日志', async () => {
    hoisted.needsConfirmation.mockImplementation((name: string) => name === 'write_file');
    const saveToolAudit = vi.fn(async () => ({ success: true }));
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { db: { saveToolAudit } };
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('write_file', { path: 'out.txt', content: 'hello' }));
      else onChunk(finalChunk('已写入'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('写文件', [], [], callbacks);

    expect(callbacks.onConfirmTool).toHaveBeenCalledWith(
      expect.objectContaining({ function: expect.objectContaining({ name: 'write_file' }) }),
    );
    expect(hoisted.executeTool).toHaveBeenCalledWith('write_file', { path: 'out.txt', content: 'hello' });
    expect(saveToolAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        tool_name: 'write_file',
        result_status: 'success',
      }),
    );
  });

  it('用户拒绝确认时不执行工具并上报取消', async () => {
    hoisted.needsConfirmation.mockReturnValue(true);
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('write_file', { path: 'out.txt', content: 'x' }));
      else onChunk(finalChunk('已取消'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks({ onConfirmTool: vi.fn(async () => false) });
    await runAgentLoop('写文件', [], [], callbacks);

    expect(hoisted.executeTool).not.toHaveBeenCalled();
    expect(callbacks.onToolCallError).toHaveBeenCalledWith('write_file', '用户取消', expect.anything());
    expect(callbacks.onDone).toHaveBeenCalledWith('已取消', expect.anything(), expect.anything());
  });

  it('确认期间用户中止时取消工具并终止循环', async () => {
    hoisted.needsConfirmation.mockReturnValue(true);
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      onChunk({ message: { content: '准备写入' } });
      onChunk(toolChunk('write_file', { path: 'out.txt', content: 'x' }));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks({
      onConfirmTool: vi.fn(async () => {
        state.get<AbortController>(KEYS.ABORT_CONTROLLER).abort();
        return true;
      }),
    });
    await runAgentLoop('写文件', [], [], callbacks);

    expect(hoisted.executeTool).not.toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledWith('准备写入', expect.anything(), expect.anything());
    expect(state.get<Record<string, unknown>>('_abortToolRecords')).toBeDefined();
  });

  it('路径沙箱拦截工作空间外文件操作', async () => {
    setWorkspaceDirPath('/ws');
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('read_file', { path: '/etc/passwd' }));
      else onChunk(finalChunk('blocked'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('读密码', [], [], callbacks);
    expect(hoisted.executeTool).not.toHaveBeenCalled();
    expect(callbacks.onToolCallError).toHaveBeenCalledWith(
      'read_file',
      expect.stringContaining('不在工作空间'),
      expect.anything(),
    );
  });

  it('禁止命令在确认前被安全规则拦截', async () => {
    hoisted.needsConfirmation.mockReturnValue(true);
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('run_command', { command: 'rm -rf /' }));
      else onChunk(finalChunk('blocked'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('删库', [], [], callbacks);
    expect(hoisted.executeTool).not.toHaveBeenCalled();
    expect(callbacks.onConfirmTool).not.toHaveBeenCalled();
    expect(callbacks.onToolCallError).toHaveBeenCalledWith(
      'run_command',
      expect.stringContaining('禁止执行'),
      expect.anything(),
    );
  });

  it('参数前置校验失败时不执行工具', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('read_file', {}));
      else onChunk(finalChunk('fixed'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('读文件', [], [], callbacks);
    expect(hoisted.executeTool).not.toHaveBeenCalled();
    expect(callbacks.onToolCallError).toHaveBeenCalledWith(
      'read_file',
      expect.stringContaining('path'),
      expect.anything(),
    );
  });

  it('只读工具跨轮次命中缓存，不重复执行', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call <= 2) onChunk(toolChunk('read_file', { path: 'same.txt' }));
      else onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('读两次', [], [], callbacks);
    expect(hoisted.executeTool).toHaveBeenCalledTimes(1);
    expect(callbacks.onToolCallResult).toHaveBeenCalledTimes(2);
  });

  it('有副作用的重复工具调用仍实际执行', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) {
        onChunk({
          message: {
            tool_calls: [
              { function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) } },
              { function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) } },
            ],
          },
        });
      } else {
        onChunk(finalChunk('done'));
      }
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('写两次', [], [], callbacks);
    expect(hoisted.executeTool).toHaveBeenCalledTimes(2);
    expect(callbacks.onToolCallResult).toHaveBeenCalledTimes(2);
  });

  it('文本工具调用兜底解析后执行', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk({ message: { content: 'Action: read_file\nAction Input: {"path": "fallback.txt"}' } });
      else onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('兜底', [], [], callbacks);
    expect(hoisted.executeTool).toHaveBeenCalledWith('read_file', { path: 'fallback.txt' });
    expect(callbacks.onToolCallResult).toHaveBeenCalled();
  });

  it('工具结果写入失败审计时不影响主流程', async () => {
    hoisted.needsConfirmation.mockReturnValue(false);
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = {
      db: {
        saveToolAudit: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    };
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('write_file', { path: 'a.txt', content: 'x' }));
      else onChunk(finalChunk('ok'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('写', [], [], callbacks);
    expect(callbacks.onDone).toHaveBeenCalledWith('ok', expect.anything(), expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════
// 中止、错误、超时与最大轮次
// ═══════════════════════════════════════════════════════════════

describe('runAgentLoop 中止与异常', () => {
  it('流式期间用户中止时通知 onDone', async () => {
    let rejectStream: ((err: Error) => void) | null = null;
    const chatStream = vi.fn(
      (_params: any, _onChunk: any, ac: AbortController) =>
        new Promise<void>((_resolve, reject) => {
          rejectStream = reject;
          ac.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    const run = runAgentLoop('hi', [], [], callbacks);
    await vi.waitFor(() => expect(chatStream).toHaveBeenCalled());
    state.get<AbortController>(KEYS.ABORT_CONTROLLER).abort();
    await run;
    expect(callbacks.onDone).toHaveBeenCalledWith('（已中止）', undefined, expect.anything());
    expect(rejectStream).toBeTypeOf('function');
  });

  it('配置 streamTimeout 时用户中止不会被误判为超时重试', async () => {
    state.set('streamTimeout', 60_000);
    const chatStream = vi.fn(
      (_params: any, _onChunk: any, ac: AbortController) =>
        new Promise<void>((_resolve, reject) => {
          ac.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    const run = runAgentLoop('hi', [], [], callbacks);
    await vi.waitFor(() => expect(chatStream).toHaveBeenCalled());
    state.get<AbortController>(KEYS.ABORT_CONTROLLER).abort();
    await run;
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(callbacks.onDone).toHaveBeenCalledWith('（已中止）', undefined, expect.anything());
  });

  it('流式异常重试耗尽后通知异常完成', async () => {
    vi.useFakeTimers();
    const chatStream = vi.fn(async () => {
      throw new Error('network timeout');
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    const run = runAgentLoop('hi', [], [], callbacks);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(chatStream).toHaveBeenCalledTimes(3);
    expect(callbacks.onDone).toHaveBeenCalledWith('（模型响应异常，已自动中断）', undefined, expect.anything());
  });

  it('流式总超时中止本轮并重试', async () => {
    vi.useFakeTimers();
    state.set('streamTimeout', 30);
    const chatStream = vi.fn(
      (_params: any, _onChunk: any, ac: AbortController) =>
        new Promise<void>((_resolve, reject) => {
          ac.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    const run = runAgentLoop('hi', [], [], callbacks);
    await vi.advanceTimersByTimeAsync(20_000);
    await run;
    expect(chatStream).toHaveBeenCalledTimes(3);
    expect(callbacks.onDone).toHaveBeenCalledWith('（模型响应异常，已自动中断）', undefined, expect.anything());
  });

  it('达到最大轮次时带工具记录终止', async () => {
    state.set('maxTurns', 2);
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      onChunk(toolChunk('read_file', { path: `f${call}.txt` }));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('循环', [], [], callbacks);
    expect(hoisted.executeTool).toHaveBeenCalledTimes(2);
    const [content, records] = vi.mocked(callbacks.onDone).mock.calls[0];
    expect(content).toBe('（达到最大工具调用次数限制）');
    expect(records).toHaveLength(2);
  });

  it('上下文消息数超过硬上限时先压缩再继续', async () => {
    hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'fast', reason: 'hard limit' });
    hoisted.mergeConsecutiveMessages.mockImplementation((messages: unknown[]) => messages.slice(-10));
    const history: OllamaMessage[] = Array.from({ length: 301 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk(finalChunk('ok')));
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('hi', [], history, callbacks);
    expect(hoisted.chooseCompressionStrategy).toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledWith('ok', undefined, expect.anything());
  });

  it('上下文使用率超过 85% 时触发压缩状态', async () => {
    hoisted.estimateTokens.mockReturnValue(9000);
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk(finalChunk('ok')));
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('hi', [], [], callbacks);
    expect(hoisted.getContextPressureLevel).toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledWith('ok', undefined, expect.anything());
  });

  it('循环异常被捕获并通知 onDone', async () => {
    vi.useFakeTimers();
    const chatStream = vi.fn(async () => {
      throw new Error('fatal unexpected');
    });
    // 未知错误会重试，最终走流式异常完成；这里验证不会向外抛
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    const run = runAgentLoop('hi', [], [], callbacks);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(run).resolves.toBeUndefined();
    expect(callbacks.onDone).toHaveBeenCalled();
  });

  it('子代理确认回调在循环结束后清空', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk(finalChunk('ok')));
    state.set(KEYS.API, makeApi(chatStream));
    await runAgentLoop('hi', [], [], makeCallbacks());
    expect(hoisted.setSubAgentConfirmHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(hoisted.setSubAgentConfirmHandler).toHaveBeenLastCalledWith(null);
  });
});

// ═══════════════════════════════════════════════════════════════
// 补充分支：看门狗、Hook、缓存、沙箱、流式进度
// ═══════════════════════════════════════════════════════════════

describe('runAgentLoop 补充分支', () => {
  it('看门狗超时强制终止', async () => {
    const realNow = Date.now;
    let now = realNow();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 10;
      return now;
    });
    state.set('loopWatchdogMs', 1);
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk(finalChunk('never')));
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('hi', [], [], callbacks);
    nowSpy.mockRestore();
    expect(chatStream).not.toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledWith('（看门狗超时终止）', undefined, expect.anything());
  });

  it('pre_tool Hook 阻断工具执行', async () => {
    registerHook({
      name: 'block-read',
      phase: 'pre_tool',
      priority: 999,
      enabled: true,
      handler: async (_ctx, data) =>
        data.toolName === 'read_file' ? { passed: false, message: 'read blocked' } : { passed: true, message: '' },
    });
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('read_file', { path: 'a.txt' }));
      else onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    try {
      await runAgentLoop('read', [], [], callbacks);
    } finally {
      unregisterHook('block-read');
    }
    expect(hoisted.executeTool).not.toHaveBeenCalled();
    expect(callbacks.onToolCallError).toHaveBeenCalledWith('read_file', '用户取消', expect.anything());
  });

  it('同轮重复只读调用在无缓存时仍执行两次', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      onChunk({
        message: {
          tool_calls: [
            { function: { name: 'read_file', arguments: JSON.stringify({ path: 'dup.txt' }) } },
            { function: { name: 'read_file', arguments: JSON.stringify({ path: 'dup.txt' }) } },
          ],
        },
      });
      onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    await runAgentLoop('dup', [], [], makeCallbacks());
    expect(hoisted.executeTool).toHaveBeenCalledTimes(2);
  });

  it('过期缓存被删除后重新执行工具', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      setToolCache(getToolCacheKey('read_file', { path: 'expired.txt' }), {
        result: { success: true, content: 'stale' },
        timestamp: Date.now() - 31 * 60_000,
      });
      onChunk(toolChunk('read_file', { path: 'expired.txt' }));
      onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    await runAgentLoop('expired', [], [], makeCallbacks());
    expect(hoisted.executeTool).toHaveBeenCalledWith('read_file', { path: 'expired.txt' });
  });

  it('沙箱标准化路径后替换工具参数', async () => {
    setWorkspaceDirPath('/ws');
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('read_file', { path: '/ws//a.txt' }));
      else onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    await runAgentLoop('read', [], [], makeCallbacks());
    expect(hoisted.executeTool).toHaveBeenCalledWith('read_file', { path: '/ws/a.txt' });
  });

  it('沙箱标准化 source 参数', async () => {
    setWorkspaceDirPath('/ws');
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk(toolChunk('file_transfer', { operation: 'copy', source: '/ws//a.txt', destination: '/ws/b.txt' }));
      else onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    await runAgentLoop('copy', [], [], makeCallbacks());
    expect(hoisted.executeTool).toHaveBeenCalledWith('file_transfer', expect.objectContaining({ source: '/ws/a.txt' }));
  });

  it('批次之间检测到中止时抛出 AbortError 并保留记录', async () => {
    hoisted.executeTool.mockImplementation(async () => {
      state.get<AbortController>(KEYS.ABORT_CONTROLLER).abort();
      return { success: true };
    });
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      onChunk({
        message: {
          tool_calls: [
            { function: { name: 'write_file', arguments: JSON.stringify({ path: '/ws/a.txt', content: 'x' }) } },
            { function: { name: 'read_file', arguments: JSON.stringify({ path: '/ws/a.txt' }) } },
          ],
        },
      });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('abort', [], [], callbacks);
    expect(hoisted.executeTool).toHaveBeenCalledTimes(1);
    expect(state.get<Record<string, unknown>>('_abortToolRecords')).toBeDefined();
    expect(callbacks.onDone).toHaveBeenCalledWith('（已中止）', expect.anything(), expect.anything());
  });

  it('写工具成功但无桌面审计桥时不崩溃', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) onChunk(toolChunk('write_file', { path: 'a.txt', content: 'x' }));
      else onChunk(finalChunk('ok'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    await runAgentLoop('write', [], [], makeCallbacks());
    expect(hoisted.executeTool).toHaveBeenCalled();
  });

  it('流式部分内容在重试失败后作为回退', async () => {
    vi.useFakeTimers();
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) {
        onChunk({ message: { content: 'partial answer' } });
        throw new Error('network timeout');
      }
      throw new Error('network timeout');
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    const run = runAgentLoop('hi', [], [], callbacks);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(callbacks.onDone).toHaveBeenCalledWith('partial answer', undefined, expect.anything());
  });

  it('上下文溢出触发紧急压缩后重试成功', async () => {
    hoisted.compressWithLLM.mockResolvedValue([{ role: 'system', content: 's' }]);
    const history: OllamaMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) throw new Error('context length exceeded');
      onChunk(finalChunk('recovered'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('hi', [], history, callbacks);
    expect(hoisted.compressWithLLM).toHaveBeenCalled();
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(callbacks.onDone).toHaveBeenCalledWith('recovered', undefined, expect.anything());
  });

  it('紧急压缩失败后继续重试并最终异常完成', async () => {
    vi.useFakeTimers();
    hoisted.compressWithLLM.mockRejectedValue(new Error('compress down'));
    const history: OllamaMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    const chatStream = vi.fn(async () => {
      throw new Error('context length exceeded');
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    const run = runAgentLoop('hi', [], history, callbacks);
    await vi.advanceTimersByTimeAsync(20_000);
    await run;
    expect(hoisted.compressWithLLM).toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledWith('（模型响应异常，已自动中断）', undefined, expect.anything());
  });

  it('流式进度定时器覆盖等待/增长/空闲分支', async () => {
    vi.useFakeTimers();
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      await new Promise((r) => setTimeout(r, 15_000));
      onChunk({ message: { content: 'x' } });
      await new Promise((r) => setTimeout(r, 30_000));
      onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    const run = runAgentLoop('hi', [], [], callbacks);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(callbacks.onDone).toHaveBeenCalledWith('xdone', undefined, expect.anything());
  });

  it('流式工具调用参数分片合并', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) {
        onChunk({ message: { tool_calls: [{ function: { name: 'read_file', arguments: '{"path":' } }] } });
        onChunk({ message: { tool_calls: [{ function: { arguments: '{"path":"chunk.txt"}' } }] } });
      } else {
        onChunk(finalChunk('done'));
      }
    });
    state.set(KEYS.API, makeApi(chatStream));
    await runAgentLoop('chunk', [], [], makeCallbacks());
    expect(hoisted.executeTool).toHaveBeenCalledWith('read_file', { path: 'chunk.txt' });
  });

  it('流式工具调用参数为对象时直接使用', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({ message: { tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] } });
      else onChunk(finalChunk('done'));
    });
    state.set(KEYS.API, makeApi(chatStream));
    await runAgentLoop('obj', [], [], makeCallbacks());
    expect(hoisted.executeTool).toHaveBeenCalledWith('list_directory', { path: '.' });
  });

  it('token 统计记录异常被忽略', async () => {
    hoisted.recordActualTokens.mockImplementation(() => {
      throw new Error('stats down');
    });
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk(finalChunk('ok')));
    state.set(KEYS.API, makeApi(chatStream));
    const callbacks = makeCallbacks();
    await runAgentLoop('hi', [], [], callbacks);
    expect(callbacks.onDone).toHaveBeenCalledWith('ok', undefined, expect.anything());
  });
});
