// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  calculateContextStats: vi.fn(),
  recordTokenUsage: vi.fn(),
  mergeConsecutiveMessages: vi.fn((m: unknown[]) => m),
  generateTokenReport: vi.fn(() => ({ report: true })),
  formatTokenReport: vi.fn(() => 'token report'),
  createCheckpoint: vi.fn(),
  estimateTokens: vi.fn((text: string) => Math.ceil((text || '').length / 4)),
  compressWithLLM: vi.fn(),
  getContextPressureLevel: vi.fn(() => ({ level: 'low' })),
  chooseCompressionStrategy: vi.fn(() => ({ strategy: 'skip', reason: '' })),
  buildContext: vi.fn((messages: unknown[]) => [...messages]),
  shouldAutoCompress: vi.fn(() => false),
  resetTokenBudget: vi.fn(),
  setTokenBudgetNumCtx: vi.fn(),
  loadSessionSummaries: vi.fn(() => []),
  formatSessionSummariesForContext: vi.fn(() => ''),
  clearCheckpoints: vi.fn(),
  executeHooks: vi.fn(async () => ({ results: [], allPassed: true })),
  recordIteration: vi.fn(),
  search: vi.fn(async () => []),
  formatMemoryContext: vi.fn(() => 'memory context'),
  loadCustomFiles: vi.fn(async () => {}),
  buildStandardPrompts: vi.fn(() => ['[环境] test', '[日期] test']),
  getRelevantToolDefinitions: vi.fn(() => []),
}));

vi.mock('../src/renderer/services/context-manager.js', () => ({
  calculateContextStats: hoisted.calculateContextStats,
  recordTokenUsage: hoisted.recordTokenUsage,
  mergeConsecutiveMessages: hoisted.mergeConsecutiveMessages,
  generateTokenReport: hoisted.generateTokenReport,
  formatTokenReport: hoisted.formatTokenReport,
  createCheckpoint: hoisted.createCheckpoint,
  estimateTokens: hoisted.estimateTokens,
  compressWithLLM: hoisted.compressWithLLM,
  getContextPressureLevel: hoisted.getContextPressureLevel,
  chooseCompressionStrategy: hoisted.chooseCompressionStrategy,
  buildContext: hoisted.buildContext,
  shouldAutoCompress: hoisted.shouldAutoCompress,
  resetTokenBudget: hoisted.resetTokenBudget,
  setTokenBudgetNumCtx: hoisted.setTokenBudgetNumCtx,
  loadSessionSummaries: hoisted.loadSessionSummaries,
  formatSessionSummariesForContext: hoisted.formatSessionSummariesForContext,
  clearCheckpoints: hoisted.clearCheckpoints,
  AUTO_COMPRESS_THRESHOLD: 0.8,
}));
vi.mock('../src/renderer/services/hooks.js', () => ({ executeHooks: hoisted.executeHooks }));
vi.mock('../src/renderer/services/agent-metrics.js', () => ({ recordIteration: hoisted.recordIteration }));
vi.mock('../src/renderer/services/memory-service.js', () => ({
  search: hoisted.search,
  formatMemoryContext: hoisted.formatMemoryContext,
}));
vi.mock('../src/renderer/components/model-bar.js', () => ({ getEffectiveNumCtx: () => 8192 }));
vi.mock('../src/renderer/services/tool-registry.js', () => ({
  getRelevantToolDefinitions: hoisted.getRelevantToolDefinitions,
}));
vi.mock('../src/renderer/services/agent/prompt.js', () => ({
  loadCustomFiles: hoisted.loadCustomFiles,
  buildStandardPrompts: hoisted.buildStandardPrompts,
}));
vi.mock('../src/renderer/services/log-service.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
}));

import { state, KEYS } from '../src/renderer/state/state.js';
import { setWorkspaceDirPath } from '../src/renderer/services/workspace-state.js';
import { handleObserving } from '../src/renderer/services/agent/states/observing.js';
import { handleCompressing } from '../src/renderer/services/agent/states/compressing.js';
import { handleInit } from '../src/renderer/services/agent/states/init.js';
import { handleReflecting } from '../src/renderer/services/agent/states/reflecting.js';
import { S } from '../src/renderer/services/agent/state.js';
import { pendingMemoryTimers, clearPendingMemoryTimers } from '../src/renderer/services/agent/runtime.js';
import type { AgentCallbacks } from '../src/renderer/services/agent/types.js';
import type { ChatSession, LoopContext, OllamaMessage, ToolDefinition } from '../src/renderer/types.js';

function makeCtx(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    state: S.OBSERVING,
    sessionId: 's1',
    loopCount: 1,
    maxLoops: 10,
    content: '',
    thinking: '',
    toolCalls: [],
    allToolRecords: [],
    messages: [],
    totalEvalCount: 0,
    totalPromptEvalCount: 0,
    totalInferenceNs: 0,
    loopEvalCount: 0,
    loopPromptEvalCount: 0,
    loopInferenceNs: 0,
    prevLoopSuccessKeys: [],
    prevToolCalls: [],
    startTime: Date.now(),
    emergencyCompressCount: 0,
    compressedThisCycle: false,
    ...overrides,
  };
}

function stats(overrides: Record<string, unknown> = {}) {
  return {
    contentTokens: 100,
    usageRatio: 0.1,
    pressureInfo: { level: 'low' },
    compressDecision: { shouldCompress: false, urgency: 'low', reason: '' },
    ...overrides,
  };
}

function callbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onThinking: vi.fn(),
    onContent: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallResult: vi.fn(),
    onToolCallError: vi.fn(),
    onDone: vi.fn(),
    onConfirmTool: vi.fn(async () => true),
    ...overrides,
  };
}

const api = { chatStream: vi.fn(async () => {}) };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.mergeConsecutiveMessages.mockImplementation((m: unknown[]) => m);
  hoisted.estimateTokens.mockImplementation((text: string) => Math.ceil((text || '').length / 4));
  hoisted.calculateContextStats.mockReturnValue(stats());
  hoisted.getContextPressureLevel.mockReturnValue({ level: 'low' });
  hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'skip', reason: '' });
  hoisted.executeHooks.mockResolvedValue({ results: [], allPassed: true });
  hoisted.compressWithLLM.mockImplementation(async (messages: unknown[]) => messages);
  hoisted.loadCustomFiles.mockImplementation(async () => {});
  hoisted.search.mockResolvedValue([]);
  hoisted.loadSessionSummaries.mockReturnValue([]);
  hoisted.shouldAutoCompress.mockReturnValue(false);
  hoisted.getRelevantToolDefinitions.mockReturnValue([]);
  state.set(KEYS.ABORT_CONTROLLER, null);
  state.set(KEYS.NUM_CTX, 8192);
  setWorkspaceDirPath('');
  clearPendingMemoryTimers();
});

afterEach(() => {
  vi.useRealTimers();
  clearPendingMemoryTimers();
  setWorkspaceDirPath('');
});

// ═══════════════════════════════════════════════════════════════
// OBSERVING
// ═══════════════════════════════════════════════════════════════

describe('handleObserving', () => {
  it('已中止时直接返回且不转换状态', async () => {
    const ac = new AbortController();
    ac.abort();
    state.set(KEYS.ABORT_CONTROLLER, ac);
    const ctx = makeCtx();
    await handleObserving(ctx, null);
    expect(ctx.state).toBe(S.OBSERVING);
    expect(hoisted.recordIteration).not.toHaveBeenCalled();
  });

  it('正常情况记录 token、迭代并转换到 REFLECTING', async () => {
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'hi' }] });
    await handleObserving(ctx, null);
    expect(ctx.state).toBe(S.REFLECTING);
    expect(hoisted.recordTokenUsage).toHaveBeenCalledWith(100, 8192);
    expect(hoisted.recordIteration).toHaveBeenCalledWith(ctx);
    expect(hoisted.executeHooks).toHaveBeenCalledWith('post_iteration', ctx, { iterationIndex: 1 });
  });

  it('工具消息超过上限时裁剪旧结果并清理 assistant tool_calls', async () => {
    const messages: OllamaMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'a', arguments: {} } },
          { type: 'function', function: { name: 'b', arguments: {} } },
        ],
      },
      { role: 'tool', content: 't1' },
      { role: 'tool', content: 't2' },
      {
        role: 'assistant',
        content: 'keep text',
        tool_calls: [
          { type: 'function', function: { name: 'c', arguments: {} } },
          { type: 'function', function: { name: 'd', arguments: {} } },
        ],
      },
      { role: 'tool', content: 't3' },
      { role: 'tool', content: 't4' },
      {
        role: 'assistant',
        content: 'partial',
        tool_calls: [
          { type: 'function', function: { name: 'e', arguments: {} } },
          { type: 'function', function: { name: 'f', arguments: {} } },
          { type: 'function', function: { name: 'g', arguments: {} } },
        ],
      },
      { role: 'tool', content: 't5' },
      { role: 'tool', content: 't6' },
      { role: 'tool', content: 't7' },
    ];
    while (messages.filter((m) => m.role === 'tool').length < 85) {
      messages.push({ role: 'tool', content: 'extra' });
    }
    const ctx = makeCtx({ messages });
    await handleObserving(ctx, null);
    expect(ctx.messages.length).toBe(messages.length - 6);
    expect(ctx.messages[0]).toMatchObject({ role: 'assistant', content: 'keep text' });
    expect(ctx.messages[0].tool_calls).toBeUndefined();
    expect(ctx.messages[1]).toMatchObject({ role: 'assistant', content: 'partial' });
    expect(ctx.messages[1].tool_calls).toBeUndefined();
    expect(ctx.messages.some((m) => m.content === 't1')).toBe(false);
  });

  it('高压力时按类型截断长工具结果', async () => {
    hoisted.calculateContextStats.mockReturnValue(stats({ pressureInfo: { level: 'high' } }));
    const messages: OllamaMessage[] = [{ role: 'tool', content: 'x'.repeat(6000), tool_name: 'run_command' }];
    while (messages.length < 20) messages.push({ role: 'user', content: 'u' });
    const ctx = makeCtx({ loopCount: 20, messages });
    await handleObserving(ctx, null);
    expect(ctx.messages[0].content).toContain('R95截断');
  });

  it('高压力且无压缩决策时合并连续消息', async () => {
    hoisted.calculateContextStats.mockReturnValue(stats({ pressureInfo: { level: 'medium' } }));
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'a' }] });
    await handleObserving(ctx, null);
    expect(hoisted.mergeConsecutiveMessages).toHaveBeenCalled();
    expect(ctx.state).toBe(S.REFLECTING);
  });

  it('高紧急度压缩决策优先转换到 COMPRESSING', async () => {
    hoisted.calculateContextStats.mockReturnValue(
      stats({
        compressDecision: { shouldCompress: true, urgency: 'high', reason: 'critical' },
      }),
    );
    const ctx = makeCtx();
    await handleObserving(ctx, null);
    expect(ctx.state).toBe(S.COMPRESSING);
    expect(hoisted.mergeConsecutiveMessages).not.toHaveBeenCalled();
  });

  it('普通压缩决策在末尾转换到 COMPRESSING', async () => {
    hoisted.calculateContextStats.mockReturnValue(
      stats({
        compressDecision: { shouldCompress: true, urgency: 'medium', reason: 'grow' },
      }),
    );
    const ctx = makeCtx();
    await handleObserving(ctx, null);
    expect(ctx.state).toBe(S.COMPRESSING);
  });

  it('每 3 轮归档超长旧工具结果', async () => {
    const messages: OllamaMessage[] = [{ role: 'tool', content: 'y'.repeat(2000), tool_name: 'read_file' }];
    while (messages.length < 14) messages.push({ role: 'user', content: 'u' });
    const ctx = makeCtx({ loopCount: 6, messages });
    await handleObserving(ctx, null);
    expect(ctx.messages[0].content).toContain('[工具结果已归档');
  });

  it('每 15 轮输出诊断与 token 报告', async () => {
    const ctx = makeCtx({ loopCount: 15 });
    await handleObserving(ctx, null);
    expect(hoisted.generateTokenReport).toHaveBeenCalledWith(8192);
    expect(hoisted.formatTokenReport).toHaveBeenCalled();
  });

  it('每 20 轮创建检查点', async () => {
    state.set('_lastUserMessage', '目标');
    const ctx = makeCtx({ loopCount: 20 });
    await handleObserving(ctx, null);
    expect(hoisted.createCheckpoint).toHaveBeenCalledWith(20, S.OBSERVING, ctx.messages, 0, '目标');
  });

  it('每 10 轮清理 ephemeral，但保留连续工具提示', async () => {
    const ctx = makeCtx({
      loopCount: 10,
      messages: [
        { role: 'user', content: 'normal', ephemeral: true },
        { role: 'user', content: '系统提示：连续 3 轮调用相同的工具', ephemeral: true },
        { role: 'user', content: 'keep' },
      ],
    });
    await handleObserving(ctx, null);
    expect(ctx.messages.map((m) => m.content)).toEqual(['系统提示：连续 3 轮调用相同的工具', 'keep']);
  });

  it('使用率高时跳过 ephemeral 清理', async () => {
    hoisted.calculateContextStats.mockReturnValue(stats({ usageRatio: 0.8 }));
    const ctx = makeCtx({ loopCount: 10, messages: [{ role: 'user', content: 'e', ephemeral: true }] });
    await handleObserving(ctx, null);
    expect(ctx.messages).toHaveLength(1);
  });

  it('post_iteration Hook 异常被吞掉', async () => {
    hoisted.executeHooks.mockRejectedValue(new Error('hook failed'));
    const ctx = makeCtx();
    await expect(handleObserving(ctx, null)).resolves.toBeUndefined();
    expect(ctx.state).toBe(S.REFLECTING);
  });
});

// ═══════════════════════════════════════════════════════════════
// COMPRESSING
// ═══════════════════════════════════════════════════════════════

describe('handleCompressing', () => {
  it('已中止时转换到 REFLECTING', async () => {
    const ac = new AbortController();
    ac.abort();
    state.set(KEYS.ABORT_CONTROLLER, ac);
    const ctx = makeCtx({ state: S.COMPRESSING });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.state).toBe(S.REFLECTING);
  });

  it('skip 策略：空内容且无工具时回到 THINKING', async () => {
    const ctx = makeCtx({ state: S.COMPRESSING });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.state).toBe(S.THINKING);
  });

  it('skip 策略：有内容时回到 REFLECTING', async () => {
    const ctx = makeCtx({ state: S.COMPRESSING, content: 'answer' });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.state).toBe(S.REFLECTING);
  });

  it('fast 策略归档旧工具结果并合并消息', async () => {
    hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'fast', reason: 'fast' });
    hoisted.mergeConsecutiveMessages.mockImplementation((m: unknown[]) => (m as unknown[]).slice(0, 1));
    const ctx = makeCtx({
      state: S.COMPRESSING,
      content: 'x',
      messages: [
        { role: 'tool', content: 'z'.repeat(2000), tool_name: 'read_file' },
        { role: 'user', content: 'u' },
      ],
    });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('[工具结果已归档');
    expect(ctx.state).toBe(S.REFLECTING);
  });

  it('medium 策略只合并连续消息', async () => {
    hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'medium', reason: 'medium' });
    hoisted.mergeConsecutiveMessages.mockImplementation((m: unknown[]) => (m as unknown[]).slice(0, 1));
    const ctx = makeCtx({
      state: S.COMPRESSING,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.state).toBe(S.THINKING);
  });

  it('LLM 策略成功时替换为压缩消息', async () => {
    hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'llm', reason: 'llm' });
    hoisted.compressWithLLM.mockResolvedValue([{ role: 'system', content: 'summary' }]);
    const ctx = makeCtx({
      state: S.COMPRESSING,
      content: 'x',
      messages: [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'user', content: 'b'.repeat(100) },
      ],
    });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.messages).toEqual([{ role: 'system', content: 'summary' }]);
    expect(ctx.state).toBe(S.REFLECTING);
  });

  it('fast 策略无效果时保留原消息', async () => {
    hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'fast', reason: 'fast' });
    hoisted.mergeConsecutiveMessages.mockImplementation((m: unknown[]) => m);
    const ctx = makeCtx({
      state: S.COMPRESSING,
      content: 'x',
      messages: [{ role: 'user', content: 'a' }],
    });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.state).toBe(S.REFLECTING);
  });

  it('LLM 策略压缩结果不更短时保留原消息', async () => {
    hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'llm', reason: 'llm' });
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    hoisted.compressWithLLM.mockResolvedValue(messages);
    const ctx = makeCtx({ state: S.COMPRESSING, content: 'x', messages });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.messages).toEqual(messages);
  });

  it('LLM 策略消息更少但 token 更多时保留原消息', async () => {
    hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'llm', reason: 'llm' });
    hoisted.compressWithLLM.mockResolvedValue([{ role: 'user', content: 'x'.repeat(500) }]);
    const ctx = makeCtx({
      state: S.COMPRESSING,
      content: 'x',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.messages).toHaveLength(2);
  });

  it('LLM 策略失败时回退合并', async () => {
    hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'llm', reason: 'llm' });
    hoisted.compressWithLLM.mockRejectedValue(new Error('llm down'));
    hoisted.mergeConsecutiveMessages.mockImplementation((m: unknown[]) => (m as unknown[]).slice(0, 1));
    const ctx = makeCtx({
      state: S.COMPRESSING,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    await handleCompressing(ctx, api as never, 'm');
    expect(ctx.messages).toHaveLength(1);
  });

  it('LLM 压缩 AbortError 向上抛出', async () => {
    hoisted.chooseCompressionStrategy.mockReturnValue({ strategy: 'llm', reason: 'llm' });
    hoisted.compressWithLLM.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    const ctx = makeCtx({ state: S.COMPRESSING });
    await expect(handleCompressing(ctx, api as never, 'm')).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

describe('handleInit', () => {
  const session: ChatSession = { id: 's1', messages: [] } as unknown as ChatSession;

  it('构建系统提示、复制历史消息与图片', async () => {
    setWorkspaceDirPath('/ws');
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: { name: 'read_file', description: '', parameters: { type: 'object', properties: {} } },
      },
    ];
    hoisted.getRelevantToolDefinitions.mockReturnValue(tools);
    const history: OllamaMessage[] = [
      {
        role: 'user',
        content: 'old',
        images: ['img'],
        thinking: 'think',
        tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: {} } }],
        tool_name: 'read_file',
        compressed: true,
      },
    ];
    const ctx = makeCtx({ state: S.INIT });
    await handleInit(ctx, api as never, 'm', callbacks(), 'hello', ['pic'], history, session);
    expect(ctx.messages[0].role).toBe('system');
    expect(ctx.messages[0].content).toContain('【工作空间】');
    expect(ctx.messages[0].content).toContain('安全规则');
    expect(ctx.messages[1]).toMatchObject({
      role: 'user',
      content: 'old',
      images: ['img'],
      thinking: 'think',
      tool_name: 'read_file',
      compressed: true,
    });
    expect(ctx.messages[1].tool_calls).toHaveLength(1);
    expect(ctx.messages.at(-1)).toMatchObject({ role: 'user', content: 'hello', images: ['pic'] });
    expect(state.get('_lastSystemPrompt')).toContain('【工作空间】');
  });

  it('空文本带单图/多图时生成默认用户消息', async () => {
    const ctx1 = makeCtx({ state: S.INIT });
    await handleInit(ctx1, api as never, 'm', callbacks(), '', ['a'], [], session);
    expect(ctx1.messages.at(-1)!.content).toBe('请分析这张图片');

    const ctx2 = makeCtx({ state: S.INIT });
    await handleInit(ctx2, api as never, 'm', callbacks(), '', ['a', 'b'], [], session);
    expect(ctx2.messages.at(-1)!.content).toBe('请分析这 2 张图片');
  });

  it('注入相关记忆与历史会话摘要', async () => {
    hoisted.search.mockResolvedValue([{ id: 'm', content: 'fact' }]);
    hoisted.formatMemoryContext.mockReturnValue('MEMORY-CONTEXT');
    hoisted.loadSessionSummaries.mockReturnValue([{ id: 'sum' }]);
    hoisted.formatSessionSummariesForContext.mockReturnValue('SUMMARY-CONTEXT');
    const ctx = makeCtx({ state: S.INIT });
    await handleInit(ctx, api as never, 'm', callbacks(), 'hello', [], [], session);
    const system = ctx.messages[0].content;
    expect(system).toContain('MEMORY-CONTEXT');
    expect(system).toContain('SUMMARY-CONTEXT');
    expect(system).toContain('[历史会话摘要]');
    expect(system).toContain('安全规则');
    expect(system).not.toContain('REFERENCE_DATA');
  });

  it('自动压缩成功时替换消息', async () => {
    hoisted.shouldAutoCompress.mockReturnValue(true);
    hoisted.compressWithLLM.mockResolvedValue([{ role: 'system', content: 's' }]);
    const ctx = makeCtx({ state: S.INIT });
    await handleInit(ctx, api as never, 'm', callbacks(), 'hello', [], [], session);
    expect(ctx.messages).toEqual([{ role: 'system', content: 's' }]);
  });

  it('自动压缩失败时继续使用原上下文', async () => {
    hoisted.shouldAutoCompress.mockReturnValue(true);
    hoisted.compressWithLLM.mockRejectedValue(new Error('compress failed'));
    const ctx = makeCtx({ state: S.INIT });
    await handleInit(ctx, api as never, 'm', callbacks(), 'hello', [], [], session);
    expect(ctx.messages.length).toBeGreaterThan(0);
  });

  it('自动压缩 AbortError 向上抛出', async () => {
    hoisted.shouldAutoCompress.mockReturnValue(true);
    hoisted.compressWithLLM.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    const ctx = makeCtx({ state: S.INIT });
    await expect(handleInit(ctx, api as never, 'm', callbacks(), 'hello', [], [], session)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('加载自定义文件后检测到中止则抛出', async () => {
    hoisted.loadCustomFiles.mockImplementation(async () => {
      const ac = new AbortController();
      ac.abort();
      state.set(KEYS.ABORT_CONTROLLER, ac);
    });
    const ctx = makeCtx({ state: S.INIT });
    await expect(handleInit(ctx, api as never, 'm', callbacks(), 'hello', [], [], session)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('记忆搜索后检测到中止则抛出', async () => {
    hoisted.search.mockImplementation(async () => {
      const ac = new AbortController();
      ac.abort();
      state.set(KEYS.ABORT_CONTROLLER, ac);
      return [];
    });
    const ctx = makeCtx({ state: S.INIT });
    await expect(handleInit(ctx, api as never, 'm', callbacks(), 'hello', [], [], session)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('记忆搜索与历史摘要异常时静默继续', async () => {
    hoisted.search.mockRejectedValue(new Error('memory down'));
    hoisted.loadSessionSummaries.mockImplementation(() => {
      throw new Error('summary down');
    });
    const ctx = makeCtx({ state: S.INIT });
    await expect(handleInit(ctx, api as never, 'm', callbacks(), 'hello', [], [], session)).resolves.toBeUndefined();
    expect(ctx.messages.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// REFLECTING
// ═══════════════════════════════════════════════════════════════

describe('handleReflecting', () => {
  it('已中止时直接返回', async () => {
    const ac = new AbortController();
    ac.abort();
    state.set(KEYS.ABORT_CONTROLLER, ac);
    const ctx = makeCtx({ state: S.REFLECTING });
    await handleReflecting(ctx, callbacks(), null);
    expect(ctx.state).toBe(S.REFLECTING);
  });

  it('达到最大轮次时结束并返回工具记录', async () => {
    const ctx = makeCtx({
      state: S.REFLECTING,
      loopCount: 10,
      maxLoops: 10,
      content: 'final',
      allToolRecords: [
        { name: 'read_file', arguments: {}, result: { success: true }, status: 'success', timestamp: 1 },
      ],
    });
    const cb = callbacks();
    await handleReflecting(ctx, cb, null);
    expect(ctx.state).toBe(S.TERMINATED);
    expect(cb.onDone).toHaveBeenCalledWith('final', ctx.allToolRecords, expect.anything());
  });

  it('达到最大轮次且无内容时使用默认文案', async () => {
    const ctx = makeCtx({ state: S.REFLECTING, loopCount: 10, maxLoops: 10 });
    const cb = callbacks();
    await handleReflecting(ctx, cb, null);
    expect(cb.onDone).toHaveBeenCalledWith('（达到最大工具调用次数限制）', [], expect.anything());
  });

  it('仍有工具调用时回到 THINKING', async () => {
    const ctx = makeCtx({
      state: S.REFLECTING,
      toolCalls: [{ type: 'function', function: { name: 'read_file', arguments: {} } }],
    });
    const cb = callbacks();
    await handleReflecting(ctx, cb, null);
    expect(ctx.state).toBe(S.THINKING);
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it('pre_completion Hook 未通过时仍完成', async () => {
    hoisted.executeHooks.mockResolvedValue({
      results: [{ passed: false, message: 'missing tests' }],
      allPassed: false,
    });
    const ctx = makeCtx({ state: S.REFLECTING, content: 'answer' });
    const cb = callbacks();
    await handleReflecting(ctx, cb, null);
    expect(ctx.state).toBe(S.TERMINATED);
    expect(cb.onDone).toHaveBeenCalledWith('answer', undefined, expect.anything());
  });

  it('pre_completion Hook 抛错时仍完成', async () => {
    hoisted.executeHooks.mockRejectedValue(new Error('hook down'));
    const ctx = makeCtx({ state: S.REFLECTING, content: 'answer' });
    const cb = callbacks();
    await handleReflecting(ctx, cb, null);
    expect(cb.onDone).toHaveBeenCalled();
  });

  it('未中止时安排记忆提取定时器', async () => {
    state.set(KEYS.ABORT_CONTROLLER, new AbortController());
    const ctx = makeCtx({ state: S.REFLECTING, content: 'answer' });
    await handleReflecting(ctx, callbacks(), null);
    expect(pendingMemoryTimers.length).toBe(1);
    clearPendingMemoryTimers();
  });

  it('优先使用当前会话消息，过滤 tool 并处理空内容', async () => {
    state.set(KEYS.ABORT_CONTROLLER, new AbortController());
    state.set(KEYS.CURRENT_SESSION, {
      id: 's1',
      messages: [
        { role: 'tool', content: 'ignored' },
        { role: 'user', content: '' },
        { role: 'assistant', content: '' },
      ],
    });
    const ctx = makeCtx({ state: S.REFLECTING, content: 'answer' });
    await handleReflecting(ctx, callbacks(), null);
    expect(pendingMemoryTimers.length).toBe(1);
    clearPendingMemoryTimers();
  });

  it('信号已中止时不安排记忆提取', async () => {
    const ac = new AbortController();
    ac.abort();
    state.set(KEYS.ABORT_CONTROLLER, ac);
    // isAborted 为 true 时会在函数开头返回，因此这里直接验证无定时器
    const ctx = makeCtx({ state: S.REFLECTING, content: 'answer' });
    await handleReflecting(ctx, callbacks(), null);
    expect(pendingMemoryTimers.length).toBe(0);
  });
});
