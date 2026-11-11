// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { state, KEYS } from '../src/renderer/state/state.js';
import { setWorkspaceDirPath } from '../src/renderer/services/workspace-state.js';
import { executeSubAgent, type SubAgentOptions } from '../src/renderer/services/sub-agent.js';
import { resetAllSafetyState, recordErrorPattern, collectDiagnostics } from '../src/renderer/services/agent-safety.js';
import type { ToolDefinition } from '../src/renderer/types.js';

function toolDef(name: string): ToolDefinition {
  return { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } };
}

function makeApi(
  chatStream: (...args: any[]) => Promise<void>,
  showModel = vi.fn(async () => ({ model_info: { 'llama.context_length': 4096 } })),
) {
  return { chatStream, showModel };
}

function baseOptions(overrides: SubAgentOptions = {}): SubAgentOptions {
  return {
    tools: [toolDef('read_file'), toolDef('write_file'), toolDef('run_command'), toolDef('delete_file')],
    executeTool: vi.fn(async () => ({ success: true, content: 'tool ok' })),
    ...overrides,
  };
}

beforeEach(() => {
  resetAllSafetyState();
  state.set('_defaultModel', 'qwen3');
  state.set(KEYS.NUM_CTX, 8192);
  state.set('subAgentMaxLoops', 10);
  state.set('subAgentTimeout', 300_000);
  state.set(KEYS.ABORT_CONTROLLER, null);
  setWorkspaceDirPath('');
});

afterEach(() => {
  vi.useRealTimers();
  setWorkspaceDirPath('');
});

// ═══════════════════════════════════════════════════════════════
// 基础校验与完成
// ═══════════════════════════════════════════════════════════════

describe('executeSubAgent 基础流程', () => {
  it('缺少 API 或模型时返回错误', async () => {
    state.set(KEYS.API, null);
    expect(await executeSubAgent('task')).toEqual({ success: false, error: '未选择模型，无法执行子任务' });

    const api = makeApi(vi.fn(async () => {}));
    state.set(KEYS.API, api);
    state.set('_defaultModel', '');
    expect(await executeSubAgent('task')).toEqual({ success: false, error: '未选择模型，无法执行子任务' });
  });

  it('无工具调用时直接返回模型内容', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      onChunk({ message: { content: '子任务完成' } });
    });
    const api = makeApi(chatStream);
    state.set(KEYS.API, api);
    const executeTool = vi.fn();
    const result = await executeSubAgent('总结项目', '附加上下文', baseOptions({ executeTool }));
    expect(result).toMatchObject({ success: true, content: '子任务完成', loops: 1 });
    expect(result.duration).toBeGreaterThanOrEqual(0);
    const params = chatStream.mock.calls[0][0] as Record<string, any>;
    expect(params.model).toBe('qwen3');
    expect(params.messages[0].content).toContain('只读工具权限');
    expect(params.messages[0].content).toContain('附加上下文');
    expect(params.messages[0].content).not.toContain('REFERENCE_DATA');
    expect(params.messages[1]).toEqual({ role: 'user', content: '总结项目' });
    expect(params.options.num_ctx).toBe(8192);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('showModel 失败时回退用户上下文设置', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk({ message: { content: 'ok' } }));
    const api = makeApi(
      chatStream,
      vi.fn(async () => {
        throw new Error('show failed');
      }),
    );
    state.set(KEYS.API, api);
    await executeSubAgent('task', undefined, baseOptions());
    expect((chatStream.mock.calls[0][0] as Record<string, any>).options.num_ctx).toBe(8192);
  });

  it('上下文长度以用户设置为准，不被模型标称上限钳制', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk({ message: { content: 'ok' } }));
    state.set(
      KEYS.API,
      makeApi(
        chatStream,
        vi.fn(async () => ({ model_info: { 'qwen.context_length': 2048 } })),
      ),
    );
    await executeSubAgent('task', undefined, baseOptions());
    expect((chatStream.mock.calls[0][0] as Record<string, any>).options.num_ctx).toBe(8192);
  });
});

// ═══════════════════════════════════════════════════════════════
// 权限与白名单
// ═══════════════════════════════════════════════════════════════

describe('子代理权限白名单', () => {
  it('readonly 只向模型暴露只读工具', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk({ message: { content: 'ok' } }));
    state.set(KEYS.API, makeApi(chatStream));
    await executeSubAgent('task', undefined, baseOptions({ permission: 'readonly' }));
    const tools = (chatStream.mock.calls[0][0] as Record<string, any>).tools as ToolDefinition[];
    expect(tools.map((t) => t.function.name)).toEqual(['read_file']);
  });

  it('limited_write 暴露读写工具但排除命令与删除', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk({ message: { content: 'ok' } }));
    state.set(KEYS.API, makeApi(chatStream));
    await executeSubAgent('task', undefined, baseOptions({ permission: 'limited_write' }));
    const names = ((chatStream.mock.calls[0][0] as Record<string, any>).tools as ToolDefinition[]).map(
      (t) => t.function.name,
    );
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).not.toContain('run_command');
    expect(names).not.toContain('delete_file');
  });

  it('full_write 暴露全部白名单工具', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk({ message: { content: 'ok' } }));
    state.set(KEYS.API, makeApi(chatStream));
    await executeSubAgent('task', undefined, baseOptions({ permission: 'full_write' }));
    const names = ((chatStream.mock.calls[0][0] as Record<string, any>).tools as ToolDefinition[]).map(
      (t) => t.function.name,
    );
    expect(names).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_command', 'delete_file']));
  });

  it('模型幻觉出的越权工具调用被忽略，不执行工具', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      onChunk({
        message: {
          content: '想删文件',
          tool_calls: [{ function: { name: 'delete_file', arguments: { path: '/ws/a' } } }],
        },
      });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const executeTool = vi.fn();
    const result = await executeSubAgent('task', undefined, baseOptions({ permission: 'readonly', executeTool }));
    expect(result).toMatchObject({ success: true, content: '想删文件', loops: 1 });
    expect(executeTool).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// 工具执行、确认与异常
// ═══════════════════════════════════════════════════════════════

describe('子代理工具执行与确认', () => {
  it('有限写工具经确认后执行并回传结果信封', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) {
        onChunk({
          message: {
            content: '写文件',
            tool_calls: [{ function: { name: 'write_file', arguments: { path: '/ws/a.txt', content: 'x' } } }],
          },
        });
      } else {
        onChunk({ message: { content: '完成' } });
      }
    });
    state.set(KEYS.API, makeApi(chatStream));
    const executeTool = vi.fn(async () => ({ success: true, path: '/ws/a.txt', bytesWritten: 1 }));
    const confirmHandler = vi.fn(async () => true);
    const result = await executeSubAgent(
      'task',
      undefined,
      baseOptions({
        permission: 'limited_write',
        executeTool,
        needsConfirmation: (name) => name === 'write_file',
        confirmHandler,
      }),
    );
    expect(result).toMatchObject({ success: true, content: '完成', loops: 2 });
    expect(confirmHandler).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith('write_file', { path: '/ws/a.txt', content: 'x' });
    const secondMessages = (chatStream.mock.calls[1][0] as Record<string, any>).messages as Array<Record<string, any>>;
    const toolMsg = secondMessages.find((m) => m.role === 'tool');
    expect(toolMsg!.content).toContain('TOOL_RESULT_START name="write_file"');
    expect(toolMsg!.content).toContain('bytesWritten');
  });

  it('用户拒绝确认时不执行工具并继续下一轮', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({ message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: '/ws/a' } } }] } });
      else onChunk({ message: { content: '已跳过' } });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const executeTool = vi.fn();
    const result = await executeSubAgent(
      'task',
      undefined,
      baseOptions({
        permission: 'limited_write',
        executeTool,
        needsConfirmation: () => true,
        confirmHandler: async () => false,
      }),
    );
    expect(result).toMatchObject({ success: true, content: '已跳过' });
    expect(executeTool).not.toHaveBeenCalled();
    const toolMsg = ((chatStream.mock.calls[1][0] as Record<string, any>).messages as Array<Record<string, any>>).find(
      (m) => m.role === 'tool',
    );
    expect(toolMsg!.content).toContain('用户取消了操作');
  });

  it('没有确认回调时默认拒绝写操作', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({ message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: '/ws/a' } } }] } });
      else onChunk({ message: { content: 'done' } });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const executeTool = vi.fn();
    await executeSubAgent(
      'task',
      undefined,
      baseOptions({
        permission: 'limited_write',
        executeTool,
        needsConfirmation: () => true,
      }),
    );
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('工具执行抛错时把错误写回上下文', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: '/ws/a' } } }] } });
      else onChunk({ message: { content: 'recovered' } });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const executeTool = vi.fn(async () => {
      throw new Error('disk read error');
    });
    const result = await executeSubAgent('task', undefined, baseOptions({ executeTool }));
    expect(result).toMatchObject({ success: true, content: 'recovered' });
    const toolMsg = ((chatStream.mock.calls[1][0] as Record<string, any>).messages as Array<Record<string, any>>).find(
      (m) => m.role === 'tool',
    );
    expect(toolMsg!.content).toContain('disk read error');
  });

  it('缺少工具执行器时写回错误而不是崩溃', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: '/ws/a' } } }] } });
      else onChunk({ message: { content: 'ok' } });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const result = await executeSubAgent('task', undefined, { tools: [toolDef('read_file')] });
    expect(result).toMatchObject({ success: true, content: 'ok' });
    const toolMsg = ((chatStream.mock.calls[1][0] as Record<string, any>).messages as Array<Record<string, any>>).find(
      (m) => m.role === 'tool',
    );
    expect(toolMsg!.content).toContain('子代理缺少工具执行器');
  });

  it('工具结果超过 8000 字符时智能截断', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: '/ws/a' } } }] } });
      else onChunk({ message: { content: 'ok' } });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const executeTool = vi.fn(async () => ({ success: true, content: 'x'.repeat(20_000) }));
    await executeSubAgent('task', undefined, baseOptions({ executeTool }));
    const toolMsg = ((chatStream.mock.calls[1][0] as Record<string, any>).messages as Array<Record<string, any>>).find(
      (m) => m.role === 'tool',
    );
    expect(toolMsg!.content).toContain('字符已截断');
    expect(toolMsg!.content.length).toBeLessThan(20_000);
  });

  it('工具失败结果保留 error 字段', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: '/ws/a' } } }] } });
      else onChunk({ message: { content: 'ok' } });
    });
    state.set(KEYS.API, makeApi(chatStream));
    await executeSubAgent(
      'task',
      undefined,
      baseOptions({ executeTool: async () => ({ success: false, error: 'nope' }) }),
    );
    const toolMsg = ((chatStream.mock.calls[1][0] as Record<string, any>).messages as Array<Record<string, any>>).find(
      (m) => m.role === 'tool',
    );
    expect(toolMsg!.content).toContain('"error":"nope"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 安全拦截
// ═══════════════════════════════════════════════════════════════

describe('子代理安全拦截', () => {
  it('路径沙箱拒绝工作空间外路径', async () => {
    setWorkspaceDirPath('/ws');
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: '/etc/passwd' } } }] } });
      else onChunk({ message: { content: 'blocked' } });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const executeTool = vi.fn();
    const result = await executeSubAgent('task', undefined, baseOptions({ executeTool }));
    expect(result).toMatchObject({ success: true, content: 'blocked' });
    expect(executeTool).not.toHaveBeenCalled();
    const toolMsg = ((chatStream.mock.calls[1][0] as Record<string, any>).messages as Array<Record<string, any>>).find(
      (m) => m.role === 'tool',
    );
    expect(toolMsg!.content).toContain('不在工作空间');
  });

  it('禁止命令被拦截且不执行', async () => {
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1)
        onChunk({
          message: { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'rm -rf /' } } }] },
        });
      else onChunk({ message: { content: 'blocked' } });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const executeTool = vi.fn();
    const result = await executeSubAgent('task', undefined, baseOptions({ permission: 'full_write', executeTool }));
    expect(result).toMatchObject({ success: true, content: 'blocked' });
    expect(executeTool).not.toHaveBeenCalled();
    const toolMsg = ((chatStream.mock.calls[1][0] as Record<string, any>).messages as Array<Record<string, any>>).find(
      (m) => m.role === 'tool',
    );
    expect(toolMsg!.content).toContain('禁止执行');
  });
});

// ═══════════════════════════════════════════════════════════════
// 超时、中止与最大轮次
// ═══════════════════════════════════════════════════════════════

describe('子代理生命周期', () => {
  it('超时后中止并返回部分结果', async () => {
    vi.useFakeTimers();
    const chatStream = vi.fn(
      (_params: any, _onChunk: any, ac: AbortController) =>
        new Promise<void>((_resolve, reject) => {
          ac.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    state.set(KEYS.API, makeApi(chatStream));
    const pending = executeSubAgent('slow task', undefined, baseOptions({ timeout: 20 }));
    await vi.advanceTimersByTimeAsync(30);
    const result = await pending;
    expect(result).toMatchObject({ success: true, content: '子任务执行已中止', partial: true, loops: 1 });
  });

  it('主 Agent 中止联动中止子代理', async () => {
    const mainAC = new AbortController();
    state.set(KEYS.ABORT_CONTROLLER, mainAC);
    const chatStream = vi.fn(
      (_params: any, _onChunk: any, ac: AbortController) =>
        new Promise<void>((_resolve, reject) => {
          ac.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    state.set(KEYS.API, makeApi(chatStream));
    const pending = executeSubAgent('slow task', undefined, baseOptions());
    await Promise.resolve();
    mainAC.abort();
    const result = await pending;
    expect(result).toMatchObject({ success: true, content: '子任务执行已中止', partial: true });
  });

  it('达到最大轮次返回部分结果', async () => {
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      onChunk({
        message: { content: 'again', tool_calls: [{ function: { name: 'read_file', arguments: { path: '/ws/a' } } }] },
      });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const executeTool = vi.fn(async () => ({ success: true, content: 'ok' }));
    const result = await executeSubAgent('loop', undefined, baseOptions({ executeTool, maxLoops: 2 }));
    expect(result).toMatchObject({ success: true, content: '达到最大轮次限制', loops: 2, partial: true });
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it('maxLoops=0 时不调用模型', async () => {
    const chatStream = vi.fn(async () => {});
    state.set(KEYS.API, makeApi(chatStream));
    const result = await executeSubAgent('none', undefined, baseOptions({ maxLoops: 0 }));
    expect(result).toMatchObject({ content: '达到最大轮次限制', loops: 0, partial: true });
    expect(chatStream).not.toHaveBeenCalled();
  });

  it('timeout=0 表示禁用超时', async () => {
    vi.useFakeTimers();
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk({ message: { content: 'ok' } }));
    state.set(KEYS.API, makeApi(chatStream));
    const result = await executeSubAgent('task', undefined, baseOptions({ timeout: 0 }));
    expect(result).toMatchObject({ success: true, content: 'ok' });
  });
});

// ═══════════════════════════════════════════════════════════════
// LLM 重试
// ═══════════════════════════════════════════════════════════════

describe('子代理 LLM 重试', () => {
  it('瞬态错误重试后成功', async () => {
    vi.useFakeTimers();
    let call = 0;
    const chatStream = vi.fn(async (_params: any, onChunk: any) => {
      call++;
      if (call === 1) throw new Error('network timeout');
      onChunk({ message: { content: 'retried' } });
    });
    state.set(KEYS.API, makeApi(chatStream));
    const pending = executeSubAgent('task', undefined, baseOptions());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result).toMatchObject({ success: true, content: 'retried' });
    expect(chatStream).toHaveBeenCalledTimes(2);
  });

  it('永久错误不重试', async () => {
    const chatStream = vi.fn(async () => {
      throw new Error('ENOENT: no such file');
    });
    state.set(KEYS.API, makeApi(chatStream));
    const result = await executeSubAgent('task', undefined, baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('不可重试');
    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it('重试耗尽返回最后错误', async () => {
    vi.useFakeTimers();
    const chatStream = vi.fn(async () => {
      throw new Error('network timeout');
    });
    state.set(KEYS.API, makeApi(chatStream));
    const pending = executeSubAgent('task', undefined, baseOptions());
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
    expect(chatStream).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// 安全状态隔离
// ═══════════════════════════════════════════════════════════════

describe('子代理安全状态隔离', () => {
  it('执行结束后恢复主 Agent 的错误模式', async () => {
    recordErrorPattern('read_file', 'ENOENT: no such file');
    expect(collectDiagnostics().errorPatternCount).toBe(1);
    const chatStream = vi.fn(async (_params: any, onChunk: any) => onChunk({ message: { content: 'ok' } }));
    state.set(KEYS.API, makeApi(chatStream));
    await executeSubAgent('task', undefined, baseOptions());
    expect(collectDiagnostics().errorPatternCount).toBe(1);
  });
});
