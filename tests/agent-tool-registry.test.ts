// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class DuplicateEntryError extends Error {
    existingId = 'mem_existing';
    existingPreview = 'same content';
    constructor() {
      super('duplicate');
      this.name = 'DuplicateEntryError';
    }
  }
  return {
    DuplicateEntryError,
    search: vi.fn(),
    addEntry: vi.fn(),
    replaceEntry: vi.fn(),
    removeEntry: vi.fn(),
    removeEntries: vi.fn(),
    loadAllEntries: vi.fn(),
    executeSubAgent: vi.fn(),
    getMCPToolDefinitions: vi.fn(),
    executeMCPTool: vi.fn(),
  };
});

vi.mock('../src/renderer/services/memory-service.js', () => ({
  search: hoisted.search,
  addEntry: hoisted.addEntry,
  replaceEntry: hoisted.replaceEntry,
  removeEntry: hoisted.removeEntry,
  removeEntries: hoisted.removeEntries,
  loadAllEntries: hoisted.loadAllEntries,
  DuplicateEntryError: hoisted.DuplicateEntryError,
}));

vi.mock('../src/renderer/services/sub-agent.js', () => ({
  executeSubAgent: hoisted.executeSubAgent,
}));

vi.mock('../src/renderer/services/mcp-client.js', () => ({
  getMCPToolDefinitions: hoisted.getMCPToolDefinitions,
  executeMCPTool: hoisted.executeMCPTool,
}));

import { state } from '../src/renderer/state/state.js';
import {
  TOOL_DEFINITIONS,
  MODE_TOOLS,
  needsConfirmation,
  getToolMode,
  setToolMode,
  setRunCommandMode,
  initGlobalToolMode,
  setToolEnabled,
  getEnabledToolDefinitions,
  getRelevantToolDefinitions,
  refreshMCPTools,
  setSubAgentConfirmHandler,
  executeTool,
  getToolAnalytics,
  resetToolAnalytics,
  getToolHeatmap,
} from '../src/renderer/services/tool-registry.js';
import type { ToolCall, ToolDefinition } from '../src/renderer/types.js';

const toolExecute = vi.fn();
const execTool = vi.fn();
const getSessionSummaries = vi.fn();
const getSession = vi.fn();
const getMessages = vi.fn();

function installBridge(overrides: Record<string, unknown> = {}) {
  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = {
    isDesktop: true,
    tool: { execute: toolExecute },
    workspace: { execTool },
    db: { getSessionSummaries, getSession, getMessages },
    ...overrides,
  };
}

function mcpDef(name: string): ToolDefinition {
  return { type: 'function', function: { name, description: 'mcp', parameters: { type: 'object', properties: {} } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetToolAnalytics();
  initGlobalToolMode('confirm');
  for (const def of TOOL_DEFINITIONS) setToolEnabled(def.function.name, true);
  setSubAgentConfirmHandler(null);
  state.set('subAgentMaxPermission', 'readonly');
  state.set('subAgentModel', '');
  installBridge();
});

afterEach(async () => {
  hoisted.getMCPToolDefinitions.mockResolvedValue([]);
  await refreshMCPTools();
});

// ═══════════════════════════════════════════════════════════════
// 模式与启用状态
// ═══════════════════════════════════════════════════════════════

describe('工具模式与确认判定', () => {
  it('写类工具默认需要确认，只读工具永不确认', () => {
    expect(MODE_TOOLS).toContain('run_command');
    expect(getToolMode('run_command')).toBe('confirm');
    expect(needsConfirmation('run_command')).toBe(true);
    expect(needsConfirmation('read_file')).toBe(false);
    expect(needsConfirmation('mcp_srv__tool')).toBe(false);
  });

  it('设置 auto 后不再确认，disabled 会禁用工具', () => {
    setToolMode('run_command', 'auto');
    expect(needsConfirmation('run_command')).toBe(false);
    expect(getEnabledToolDefinitions().map((t) => t.function.name)).toContain('run_command');

    setToolMode('run_command', 'disabled');
    expect(needsConfirmation('run_command')).toBe(false);
    expect(getEnabledToolDefinitions().map((t) => t.function.name)).not.toContain('run_command');
  });

  it('setRunCommandMode 兼容旧接口', () => {
    setRunCommandMode('auto');
    expect(getToolMode('run_command')).toBe('auto');
  });

  it('initGlobalToolMode 应用到所有写类工具', () => {
    initGlobalToolMode('auto');
    for (const name of MODE_TOOLS) expect(getToolMode(name)).toBe('auto');
    initGlobalToolMode('disabled');
    for (const name of MODE_TOOLS) expect(getToolMode(name)).toBe('disabled');
  });

  it('setToolEnabled 控制内置工具定义输出', () => {
    setToolEnabled('read_file', false);
    expect(getEnabledToolDefinitions().map((t) => t.function.name)).not.toContain('read_file');
    setToolEnabled('read_file', true);
    expect(getEnabledToolDefinitions().map((t) => t.function.name)).toContain('read_file');
  });
});

// ═══════════════════════════════════════════════════════════════
// 执行分发
// ═══════════════════════════════════════════════════════════════

describe('executeTool 分发', () => {
  it('未启用工具直接拒绝（含旧工具名）', async () => {
    for (const legacy of ['read_multiple_files', 'browser_open', 'session_list', 'calculator']) {
      const r = await executeTool(legacy, {});
      expect(r.success).toBe(false);
      expect(r.error).toContain('未启用');
    }
  });

  it('非桌面环境拒绝执行', async () => {
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { isDesktop: false };
    const r = await executeTool('read_file', { path: 'a.txt' });
    expect(r).toEqual({ success: false, error: '工具调用仅支持桌面版' });
  });

  it('参数校验失败不调用 IPC', async () => {
    const r = await executeTool('write_file', {});
    expect(r.success).toBe(false);
    expect(r.error).toContain('参数验证失败');
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it('安全校验拦截 URL 路径', async () => {
    const r = await executeTool('read_file', { path: 'https://example.com/a' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('web_fetch');
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it('普通工具走 IPC 并做格式化与分析记录', async () => {
    toolExecute.mockResolvedValue({ success: true, path: 'a.txt', content: 'line1\nline2' });
    const r = await executeTool('read_file', { path: 'a.txt' });
    expect(toolExecute).toHaveBeenCalledWith('read_file', { path: 'a.txt' });
    expect(r.success).toBe(true);
    expect(r._meta).toContain('2 行');
    const analytics = getToolAnalytics();
    expect(analytics.find((a) => a.toolName === 'read_file')).toMatchObject({ totalCalls: 1, successCount: 1 });
  });

  it('参数自动类型转换后执行', async () => {
    toolExecute.mockResolvedValue({ success: true, content: 'ok' });
    await executeTool('read_file', { path: 'a.txt', start_line: '5' });
    expect(toolExecute).toHaveBeenCalledWith('read_file', expect.objectContaining({ start_line: 5 }));
  });

  it('IPC 抛错时返回错误并附带修复建议', async () => {
    toolExecute.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    const r = await executeTool('read_file', { path: 'missing.txt' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('ENOENT');
    expect(r.error).toContain('💡 建议');
    expect(getToolAnalytics().find((a) => a.toolName === 'read_file')).toMatchObject({ totalCalls: 1, errorCount: 1 });
  });

  it('run_command 走工作空间 IPC 并截断/格式化', async () => {
    execTool.mockResolvedValue({ success: true, stdout: 'hello', stderr: '', exitCode: 0, duration: 5 });
    const r = await executeTool('run_command', { command: 'echo hello' });
    expect(execTool).toHaveBeenCalledWith('echo hello', undefined);
    expect(r).toMatchObject({ success: true, stdout: 'hello', exitCode: 0 });
    expect(getToolAnalytics().find((a) => a.toolName === 'run_command')?.totalCalls).toBe(1);
  });

  it('run_command 缺少 command 返回错误', async () => {
    const r = await executeTool('run_command', { command: '' });
    expect(r).toEqual({ success: false, error: '缺少 command 参数' });
    const missing = await executeTool('run_command', {});
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('缺少必填参数');
  });

  it('MCP 工具路由到 mcp-client', async () => {
    hoisted.executeMCPTool.mockResolvedValue({ success: true, content: 'mcp result' });
    const r = await executeTool('mcp_demo__echo', { text: 'hi' });
    expect(hoisted.executeMCPTool).toHaveBeenCalledWith('mcp_demo__echo', { text: 'hi' });
    expect(r).toEqual({ success: true, content: 'mcp result' });
  });
});

// ═══════════════════════════════════════════════════════════════
// memory 工具
// ═══════════════════════════════════════════════════════════════

describe('memory 工具', () => {
  it('search 缺少 query 返回错误，正常查询默认 limit=8', async () => {
    expect(await executeTool('memory', { action: 'search' })).toEqual({ success: false, error: '缺少 query 参数' });
    hoisted.search.mockResolvedValue([{ id: 'm1' }]);
    const r = await executeTool('memory', { action: 'search', query: 'x' });
    expect(hoisted.search).toHaveBeenCalledWith('x', 8);
    expect(r).toMatchObject({ success: true, action: 'search', total: 1 });
    await executeTool('memory', { action: 'search', query: 'x', limit: '3.9' });
    expect(hoisted.search).toHaveBeenLastCalledWith('x', 3);
  });

  it('add 校验内容并钳制 importance', async () => {
    expect((await executeTool('memory', { action: 'add', content: 'a' })).success).toBe(false);
    hoisted.addEntry.mockResolvedValue({ id: 'm1', type: 'fact', content: 'hello' });
    const r = await executeTool('memory', { action: 'add', content: 'hello', importance: 99, tags: ['t'] });
    expect(hoisted.addEntry).toHaveBeenCalledWith('fact', 'hello', 10, ['t']);
    expect(r).toMatchObject({ success: true, id: 'm1', type: 'fact' });
    await executeTool('memory', { action: 'add', content: 'hello2' });
    expect(hoisted.addEntry).toHaveBeenLastCalledWith('fact', 'hello2', 5, []);
  });

  it('add 重复内容返回软成功', async () => {
    hoisted.addEntry.mockRejectedValue(new hoisted.DuplicateEntryError());
    const r = await executeTool('memory', { action: 'add', content: 'dupe' });
    expect(r).toMatchObject({ success: true, duplicate: true, existing_id: 'mem_existing' });
    expect(String(r.message)).toContain('相同内容');
  });

  it('add 其他异常向上返回失败', async () => {
    hoisted.addEntry.mockRejectedValue(new Error('disk full'));
    const r = await executeTool('memory', { action: 'add', content: 'hello' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('disk full');
  });

  it('replace / remove 透传结果', async () => {
    hoisted.replaceEntry.mockResolvedValue({ success: true, message: 'replaced' });
    expect(await executeTool('memory', { action: 'replace', old_text: 'a', new_content: 'b' })).toMatchObject({
      success: true,
      message: 'replaced',
    });
    hoisted.replaceEntry.mockResolvedValue({ success: false, message: 'not found' });
    const failed = await executeTool('memory', { action: 'replace', old_text: 'a', new_content: 'b' });
    expect(failed).toMatchObject({ success: false, error: 'not found' });

    hoisted.removeEntry.mockResolvedValue({ success: true, message: 'removed' });
    expect(await executeTool('memory', { action: 'remove', old_text: 'a' })).toMatchObject({ success: true });
    hoisted.removeEntry.mockResolvedValue({ success: false, message: 'missing' });
    expect((await executeTool('memory', { action: 'remove', old_text: 'a' })).success).toBe(false);
  });

  it('remove_batch 校验并透传结果', async () => {
    expect((await executeTool('memory', { action: 'remove_batch', old_texts: [] })).success).toBe(false);
    hoisted.removeEntries.mockResolvedValue({ success: true, results: [], deleted: 0, failed: 0, message: 'done' });
    const r = await executeTool('memory', { action: 'remove_batch', old_texts: ['a', 1] });
    expect(hoisted.removeEntries).toHaveBeenCalledWith(['a', '1']);
    expect(r).toMatchObject({ success: true, deleted: 0, failed: 0 });
  });

  it('read_all 与未知 action 被 schema 拒绝', async () => {
    hoisted.loadAllEntries.mockResolvedValue([{ id: 'm1' }]);
    expect(await executeTool('memory', { action: 'read_all' })).toMatchObject({ success: true, total: 1 });
    const unknown = await executeTool('memory', { action: 'nope' });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain('不在允许范围');
  });
});

// ═══════════════════════════════════════════════════════════════
// session 工具
// ═══════════════════════════════════════════════════════════════

describe('session 工具', () => {
  it('无数据库时拒绝', async () => {
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { isDesktop: true };
    expect(await executeTool('session', { action: 'list' })).toEqual({ success: false, error: '桌面 API 不可用' });
  });

  it('list 支持搜索、排序与 limit', async () => {
    getSessionSummaries.mockResolvedValue([
      { id: 'a', title: 'Alpha', model: 'm', message_count: 1, created_at: 1, updated_at: 10 },
      { id: 'b', title: 'Beta', model: 'm', message_count: 2, created_at: 2, updated_at: 30 },
      { id: 'c', title: 'alpha two', model: 'm', message_count: 3, created_at: 3, updated_at: 20 },
    ]);
    const r = await executeTool('session', { action: 'list', search: 'alpha', limit: 1 });
    expect(r).toMatchObject({ success: true, action: 'list', total: 1 });
    expect((r.sessions as Array<Record<string, unknown>>)[0].id).toBe('c');
    const all = await executeTool('session', { action: 'list' });
    expect((all.sessions as Array<Record<string, unknown>>).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('read 校验 session_id、不存在与成功读取', async () => {
    expect((await executeTool('session', { action: 'read' })).success).toBe(false);
    getSession.mockResolvedValue(null);
    expect((await executeTool('session', { action: 'read', session_id: 'x' })).success).toBe(false);

    getSession.mockResolvedValue({ id: 'x', title: 'T', model: 'm' });
    getMessages.mockResolvedValue([
      { role: 'user', content: 'hi', created_at: 1 },
      { role: 'assistant', content: 'yo', created_at: 2 },
    ]);
    const r = await executeTool('session', { action: 'read', session_id: 'x', max_messages: 1 });
    expect(r).toMatchObject({ success: true, action: 'read', total: 2 });
    expect(r.messages as unknown[]).toHaveLength(1);
  });

  it('未知 action 被 schema 拒绝', async () => {
    const r = await executeTool('session', { action: 'delete' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('不在允许范围');
  });
});

// ═══════════════════════════════════════════════════════════════
// spawn_task 子代理委派
// ═══════════════════════════════════════════════════════════════

describe('spawn_task 委派', () => {
  it('缺少 task 返回错误', async () => {
    const missing = await executeTool('spawn_task', {});
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('缺少必填参数');
    expect(await executeTool('spawn_task', { task: '' })).toEqual({ success: false, error: '缺少 task 参数' });
  });

  it('权限只降不升，并注入配置模型与确认回调', async () => {
    state.set('subAgentMaxPermission', 'limited_write');
    state.set('subAgentModel', 'sub-model');
    const confirm = vi.fn(async () => true);
    setSubAgentConfirmHandler(confirm);
    hoisted.executeSubAgent.mockResolvedValue({ success: true, content: 'done', loops: 2 });
    const r = await executeTool('spawn_task', { task: 'do work', context: 'ctx', permission: 'full_write' });
    expect(r).toMatchObject({ success: true, content: 'done' });
    const opts = hoisted.executeSubAgent.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toMatchObject({ model: 'sub-model', permission: 'limited_write', confirmHandler: confirm });
    expect(typeof opts.needsConfirmation).toBe('function');
    expect(typeof opts.executeTool).toBe('function');
    expect((opts.tools as ToolDefinition[]).length).toBeGreaterThan(0);
  });

  it('请求低权限时保持低权限，未配置模型时跟随当前模型', async () => {
    state.set('subAgentMaxPermission', 'full_write');
    hoisted.executeSubAgent.mockResolvedValue({ success: true, content: 'ok', loops: 1 });
    await executeTool('spawn_task', { task: 'read only' });
    const opts = hoisted.executeSubAgent.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.permission).toBe('readonly');
    expect(opts.model).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// MCP 工具合并
// ═══════════════════════════════════════════════════════════════

describe('refreshMCPTools', () => {
  it('合并新 MCP 工具并跳过与内置工具重名项', async () => {
    hoisted.getMCPToolDefinitions.mockResolvedValue([mcpDef('mcp_srv__echo'), mcpDef('read_file')]);
    await refreshMCPTools();
    const names = getEnabledToolDefinitions().map((t) => t.function.name);
    expect(names).toContain('mcp_srv__echo');
    expect(names.filter((n) => n === 'read_file')).toHaveLength(1);
  });

  it('获取失败时清空 MCP 缓存', async () => {
    hoisted.getMCPToolDefinitions.mockResolvedValue([mcpDef('mcp_srv__echo')]);
    await refreshMCPTools();
    expect(getEnabledToolDefinitions().some((t) => t.function.name === 'mcp_srv__echo')).toBe(true);
    hoisted.getMCPToolDefinitions.mockRejectedValue(new Error('mcp down'));
    await refreshMCPTools();
    expect(getEnabledToolDefinitions().some((t) => t.function.name === 'mcp_srv__echo')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 热力图
// ═══════════════════════════════════════════════════════════════

describe('getToolHeatmap', () => {
  it('未调用工具时全部为 0 热度', () => {
    const heatmap = getToolHeatmap();
    expect(heatmap.length).toBeGreaterThanOrEqual(TOOL_DEFINITIONS.length);
    expect(heatmap.every((h) => h.totalCalls === 0 && h.heatLevel === 0)).toBe(true);
  });

  it('调用后热度按最大调用量分级', async () => {
    toolExecute.mockResolvedValue({ success: true });
    await executeTool('read_file', { path: 'a' });
    await executeTool('read_file', { path: 'b' });
    await executeTool('list_directory', { path: '.' });
    const heatmap = getToolHeatmap();
    const read = heatmap.find((h) => h.toolName === 'read_file')!;
    const list = heatmap.find((h) => h.toolName === 'list_directory')!;
    expect(read.totalCalls).toBe(2);
    expect(read.heatLevel).toBe(4);
    expect(list.heatLevel).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 子代理确认处理器
// ═══════════════════════════════════════════════════════════════

describe('setSubAgentConfirmHandler', () => {
  it('可设置与清空', () => {
    const handler = vi.fn(async (_call: ToolCall) => true);
    expect(() => setSubAgentConfirmHandler(handler)).not.toThrow();
    expect(() => setSubAgentConfirmHandler(null)).not.toThrow();
  });
});
