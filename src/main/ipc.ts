/**
 * IPC 注册入口（0.18.0）
 *
 * 已拆分：
 * - ipc/app.ts      应用 / 对话框 / 系统信息 / 更新检查
 * - ipc/ollama.ts   Ollama 代理
 * - ipc/tools.ts    工具 + 工作空间
 * - ipc/db.ts       数据库 / 会话 / 设置 / 统计
 * - ipc/memory.ts   MEMORY.md
 * - ipc/mcp.ts      MCP
 * - ipc/media.ts    视频帧
 * - ipc/register.ts 发送方校验 / zod / 日志脱敏
 * - ipc/shared.ts   日志桥
 */

import { initDatabase, getSetting } from './db/sqlite.js';
import { sendLog } from './ipc/shared.js';
import { registerAppIPC } from './ipc/app.js';
import { registerOllamaIPC } from './ipc/ollama.js';
import { registerToolsIPC } from './ipc/tools.js';
import { registerDbIPC } from './ipc/db.js';
import { registerMemoryIPC } from './ipc/memory.js';
import { registerMcpIPC } from './ipc/mcp.js';
import { registerMediaIPC } from './ipc/media.js';
import { setWorkspaceDir } from './workspace.js';

export async function setupIPC(): Promise<void> {
  await initDatabase();
  sendLog('success', '📦 SQLite 数据库已初始化');

  // Ollama 必须在数据库初始化之后注册（读取连接配置）
  registerOllamaIPC();
  registerAppIPC();
  registerToolsIPC();
  registerDbIPC();
  registerMemoryIPC();
  registerMcpIPC();
  registerMediaIPC();

  try {
    const savedWsDir = getSetting<string>('workspaceDir', '');
    if (savedWsDir) {
      setWorkspaceDir(savedWsDir);
      sendLog('info', '📁 恢复工作空间目录', savedWsDir);
    }
  } catch {
    /* ignore */
  }
}
