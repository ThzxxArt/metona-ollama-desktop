/**
 * 工具执行与工作空间 IPC。
 */

import { ipcMain } from 'electron';
import { sendLog } from './shared.js';
import { handleRunCommand, killToolProcess } from '../tool-handlers.js';
import { getToolHandler } from '../tool-dispatch.js';
import { getAllowedDirs, getBlockedDirs, setAllowedDirs } from '../tool-security.js';
import { setHTTPTimeout } from '../tool-handlers-system.js';
import { setMCPTimeout } from '../mcp-manager.js';
import { startProcess, killProcess, getWorkspaceDir, setWorkspaceDir, listWorkspaceDir } from '../workspace.js';
import { saveSetting } from '../db/sqlite.js';

function summarizeResult(toolName: string, result: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file':
      return result.total !== undefined
        ? `${result.total} 个文件`
        : `${result.path} (${result.lines} 行${result.truncated ? ', 已截断' : ''})`;
    case 'write_file':
      return `${result.path} (${result.bytesWritten}B${result.created ? ', 新建' : ''})`;
    case 'list_directory':
      return `${result.path} (${result.total ?? result.fileCount ?? 0} 项${result.truncated ? ', 已截断' : ''})`;
    case 'search_files':
      return `"${result.query}" → ${result.total_matches} 匹配 / ${result.total_files} 文件`;
    case 'delete_file':
      return result.batch ? `批量删除 ${result.successCount}/${result.totalPaths} 个路径` : String(result.path);
    case 'file_transfer':
      return `${result.source} → ${result.destination}`;
    case 'web_fetch':
      return `${result.status} | ${result.length} chars`;
    case 'web_search':
      return `[${String(result._mode) === 'searxng' ? 'SearXNG' : '内置'}] "${result.query}" → ${result.total} 条结果`;
    case 'edit_file':
      return `${result.path} (${result.replaceCount} 处替换)`;
    case 'download_file':
      return `${result.url} → ${result.destination} (${result.size}B)`;
    case 'git':
      return `${result.action} ✓`;
    case 'compress':
      return `${result.action} → ${result.archive || result.destination}`;
    case 'diff':
      return result.identical ? '无差异' : `+${result.additions} -${result.deletions} (${result.hunk_count} hunks)`;
    case 'browser':
      return `browser.${result.action} ✓`;
    default:
      return '完成';
  }
}

export function registerToolsIPC(): void {
  ipcMain.handle('tool:execute', async (_, toolName: string, args: Record<string, unknown>) => {
    try {
      sendLog('debug', `🔧 tool:execute ${toolName}`, JSON.stringify(args || {}).slice(0, 200));
      if (toolName === 'run_command') {
        return await handleRunCommand(args as { command: string; cwd?: string });
      }
      const handler = getToolHandler(toolName);
      if (!handler) return { success: false, error: `未知工具: ${toolName}` };
      const result = await handler(args);
      if (result.success) {
        sendLog('success', `🔧 ${toolName} ✓`, summarizeResult(toolName, result));
      } else {
        sendLog('warn', `🔧 ${toolName} ✗`, String(result.error || '未知错误').slice(0, 200));
      }
      return result;
    } catch (err) {
      sendLog('error', `❌ tool:execute 异常: ${toolName}`, String(err));
      return { success: false, error: (err as Error).message || '工具执行异常' };
    }
  });

  ipcMain.handle('tool:getConfig', () => ({
    allowedDirs: getAllowedDirs(),
    blockedDirs: getBlockedDirs(),
  }));

  ipcMain.handle('tool:setAllowedDirs', (_, dirs: string[]) => {
    setAllowedDirs(dirs);
  });

  ipcMain.handle('tool:setTimeouts', (_, timeouts: { http?: number; mcp?: number }) => {
    if (typeof timeouts.http === 'number' && timeouts.http >= 0) setHTTPTimeout(timeouts.http);
    if (typeof timeouts.mcp === 'number' && timeouts.mcp >= 0) setMCPTimeout(timeouts.mcp);
    return { success: true };
  });

  ipcMain.handle('workspace:getDir', () => {
    return { dir: getWorkspaceDir(), defaultDir: getWorkspaceDir() };
  });

  ipcMain.handle('workspace:setDir', (_, dir: string) => {
    try {
      setWorkspaceDir(dir);
      saveSetting('workspaceDir', getWorkspaceDir());
      return { success: true, dir: getWorkspaceDir() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('workspace:listDir', (_, dirPath?: string) => {
    return listWorkspaceDir(dirPath);
  });

  ipcMain.handle('workspace:readFile', async (_, filePath: string) => {
    const handler = getToolHandler('read_file');
    if (!handler) return { success: false, error: 'read_file 处理器不可用' };
    return handler({ path: filePath });
  });

  ipcMain.on('workspace:exec', (event, { id, command, cwd }: { id: string; command: string; cwd?: string }) => {
    sendLog('info', `🖥️ workspace:exec`, `ID: ${id} | ${command.slice(0, 200)}`);
    const result = startProcess(
      id,
      command,
      cwd,
      (type, data) => {
        event.sender.send('workspace:output', { id, type, data });
      },
      (code) => {
        event.sender.send('workspace:exit', { id, code });
      },
    );
    if (!result.success) {
      event.sender.send('workspace:output', { id, type: 'stderr', data: result.error + '\n' });
      event.sender.send('workspace:exit', { id, code: 1 });
    }
  });

  ipcMain.on('workspace:kill', (_, id: string) => {
    sendLog('info', `🖥️ workspace:kill`, `ID: ${id}`);
    killProcess(id);
  });

  ipcMain.handle('cmd:kill', async () => {
    const killed = killToolProcess();
    sendLog('info', `🔧 cmd:kill`, killed ? '已终止' : '无正在运行的工具命令');
    return { killed };
  });
}
