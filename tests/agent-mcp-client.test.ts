// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { state, KEYS } from '../src/renderer/state/state.js';
import {
  getMCPServers,
  saveMCPServers,
  addMCPServer,
  removeMCPServer,
  toggleMCPServer,
  getEnabledMCPServers,
  startAllMCPServers,
  stopAllMCPServers,
  getMCPServerStatuses,
  getMCPToolDefinitions,
  executeMCPTool,
  type MCPServerConfig,
} from '../src/renderer/services/mcp-client.js';

function server(name: string, enabled = true): MCPServerConfig {
  return { name, command: 'node', args: ['server.js'], enabled };
}

const db = {
  getSetting: vi.fn(),
  saveSetting: vi.fn(async () => ({ success: true })),
};

beforeEach(() => {
  vi.clearAllMocks();
  db.getSetting.mockImplementation(async (_key: string, fallback: unknown) => fallback);
  state.set(KEYS.DB, db);
  delete (window as unknown as { metonaDesktop?: unknown }).metonaDesktop;
});

describe('MCP 配置管理', () => {
  it('无数据库时返回空列表，保存为无操作', async () => {
    state.set(KEYS.DB, null);
    expect(await getMCPServers()).toEqual([]);
    await expect(saveMCPServers([server('a')])).resolves.toBeUndefined();
    expect(db.saveSetting).not.toHaveBeenCalled();
  });

  it('数据库读取异常时返回空列表', async () => {
    db.getSetting.mockRejectedValue(new Error('db down'));
    expect(await getMCPServers()).toEqual([]);
  });

  it('读取已保存配置', async () => {
    db.getSetting.mockResolvedValue([server('a')]);
    expect(await getMCPServers()).toEqual([server('a')]);
    expect(db.getSetting).toHaveBeenCalledWith('mcp_servers', []);
  });

  it('新增与更新同名 Server', async () => {
    db.getSetting.mockResolvedValue([server('a', true)]);
    await addMCPServer(server('b'));
    expect(db.saveSetting).toHaveBeenCalledWith('mcp_servers', [server('a', true), server('b')]);

    await addMCPServer({ ...server('a'), enabled: false });
    const saved = db.saveSetting.mock.calls.at(-1)![1] as MCPServerConfig[];
    expect(saved).toHaveLength(2);
    expect(saved[0].enabled).toBe(false);
  });

  it('删除 Server 时先停止进程再过滤配置', async () => {
    const stopServer = vi.fn(async () => ({ success: true }));
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { mcp: { stopServer } };
    db.getSetting.mockResolvedValue([server('a'), server('b')]);
    await removeMCPServer('a');
    expect(stopServer).toHaveBeenCalledWith('a');
    expect(db.saveSetting).toHaveBeenCalledWith('mcp_servers', [server('b')]);
  });

  it('无桌面桥删除时仍过滤配置', async () => {
    db.getSetting.mockResolvedValue([server('a')]);
    await removeMCPServer('a');
    expect(db.saveSetting).toHaveBeenCalledWith('mcp_servers', []);
  });

  it('切换不存在 Server 返回 false，存在则翻转', async () => {
    db.getSetting.mockResolvedValue([server('a', true)]);
    expect(await toggleMCPServer('missing')).toBe(false);
    expect(await toggleMCPServer('a')).toBe(false);
    expect(db.saveSetting).toHaveBeenLastCalledWith('mcp_servers', [server('a', false)]);
    db.getSetting.mockResolvedValue([server('a', false)]);
    expect(await toggleMCPServer('a')).toBe(true);
  });

  it('只返回启用的 Server', async () => {
    db.getSetting.mockResolvedValue([server('a', true), server('b', false)]);
    expect(await getEnabledMCPServers()).toEqual([server('a', true)]);
  });
});

describe('MCP 服务器生命周期', () => {
  it('无桌面桥时启动/停止/状态查询安全返回', async () => {
    await expect(startAllMCPServers()).resolves.toBeUndefined();
    await expect(stopAllMCPServers()).resolves.toBeUndefined();
    expect(await getMCPServerStatuses()).toEqual([]);
  });

  it('启动所有已启用 Server，记录失败与异常', async () => {
    const startServer = vi.fn(async (cfg: MCPServerConfig) => {
      if (cfg.name === 'a') return { success: true };
      if (cfg.name === 'b') return { success: false, error: 'bad' };
      throw new Error('crash');
    });
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { mcp: { startServer } };
    db.getSetting.mockResolvedValue([server('a'), server('b'), server('c'), server('d', false)]);
    await startAllMCPServers();
    expect(startServer).toHaveBeenCalledTimes(3);
  });

  it('停止所有 Server', async () => {
    const stopAll = vi.fn(async () => ({ success: true }));
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { mcp: { stopAll } };
    await stopAllMCPServers();
    expect(stopAll).toHaveBeenCalled();
  });

  it('状态查询透传，异常时返回空数组', async () => {
    const getStatuses = vi.fn(async () => [{ name: 'a', running: true, toolCount: 2 }]);
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { mcp: { getStatuses } };
    expect(await getMCPServerStatuses()).toEqual([{ name: 'a', running: true, toolCount: 2 }]);
    getStatuses.mockRejectedValue(new Error('down'));
    expect(await getMCPServerStatuses()).toEqual([]);
  });
});

describe('MCP 工具定义与执行', () => {
  it('无桌面桥或空工具列表返回空数组', async () => {
    expect(await getMCPToolDefinitions()).toEqual([]);
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { mcp: { getTools: vi.fn(async () => []) } };
    expect(await getMCPToolDefinitions()).toEqual([]);
  });

  it('转换 MCP 工具为 ToolDefinition', async () => {
    const getTools = vi.fn(async () => [
      {
        serverName: 'srv',
        name: 'echo',
        fullName: 'mcp_srv__echo',
        description: 'Echo text',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'text' } },
          required: ['text'],
        },
      },
    ]);
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { mcp: { getTools } };
    const defs = await getMCPToolDefinitions();
    expect(defs).toEqual([
      {
        type: 'function',
        function: {
          name: 'mcp_srv__echo',
          description: 'Echo text',
          parameters: {
            type: 'object',
            required: ['text'],
            properties: { text: { type: 'string', description: 'text' } },
          },
        },
      },
    ]);
  });

  it('inputSchema 缺少 required/properties 时使用空默认值', async () => {
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = {
      mcp: {
        getTools: vi.fn(async () => [
          { serverName: 's', name: 't', fullName: 'mcp_s__t', description: 'd', inputSchema: { type: 'object' } },
        ]),
      },
    };
    const defs = await getMCPToolDefinitions();
    expect(defs[0].function.parameters).toEqual({ type: 'object', required: [], properties: {} });
  });

  it('工具获取异常时返回空数组', async () => {
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = {
      mcp: {
        getTools: vi.fn(async () => {
          throw new Error('mcp down');
        }),
      },
    };
    expect(await getMCPToolDefinitions()).toEqual([]);
  });

  it('执行 MCP 工具校验桥、工具名与异常', async () => {
    expect(await executeMCPTool('mcp_srv__echo', {})).toEqual({ success: false, error: 'MCP API 不可用' });

    const callTool = vi.fn(async () => ({ success: true, content: 'ok' }));
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { mcp: { callTool } };
    expect(await executeMCPTool('bad-name', {})).toEqual({ success: false, error: '无效的 MCP 工具名: bad-name' });
    expect(callTool).not.toHaveBeenCalled();

    expect(await executeMCPTool('mcp_srv__echo', { text: 'hi' })).toEqual({ success: true, content: 'ok' });
    expect(callTool).toHaveBeenCalledWith('srv', 'echo', { text: 'hi' });

    callTool.mockRejectedValue(new Error('call failed'));
    expect(await executeMCPTool('mcp_srv__echo', {})).toEqual({ success: false, error: 'call failed' });
  });

  it('工具名支持 Server 名与工具名包含单下划线', async () => {
    const callTool = vi.fn(async () => ({ success: true }));
    (window as unknown as { metonaDesktop: unknown }).metonaDesktop = { mcp: { callTool } };
    await executeMCPTool('mcp_my_server__my_tool', {});
    expect(callTool).toHaveBeenCalledWith('my_server', 'my_tool', {});
  });
});
