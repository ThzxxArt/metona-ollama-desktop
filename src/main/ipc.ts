/**
 * Metona Ollama Desktop - IPC 处理器
 */

import { ipcMain, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { mainWindow } from './main.js';
import { showNotification } from './utils.js';
import {
  handleReadFile,
  handleWriteFile,
  handleListDir,
  handleSearchFiles,
  handleCreateDir,
  handleDeleteFile,
  handleRunCommand
} from './tool-handlers.js';
import { getAllowedDirs, getBlockedDirs, setAllowedDirs } from './tool-security.js';
import { startProcess, killProcess, getWorkspaceDir, setWorkspaceDir, listWorkspaceDir } from './workspace.js';

export function setupIPC(): void {
  ipcMain.handle('dialog:openFile', async (_, options?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: options?.filters || [{ name: '所有文件', extensions: ['*'] }]
    });
    if (result.canceled) return null;
    return result.filePaths;
  });

  ipcMain.handle('dialog:saveFile', async (_, options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: options?.defaultPath || 'export',
      filters: options?.filters || [{ name: '所有文件', extensions: ['*'] }]
    });
    if (result.canceled) return null;
    return result.filePath;
  });

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { success: true, content, name: path.basename(filePath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string, encoding?: string) => {
    try {
      await fs.promises.writeFile(filePath, content, (encoding as BufferEncoding) || 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('notify', (_: unknown, title: string, body: string) => {
    showNotification(title, body);
  });

  ipcMain.handle('app:info', () => ({
    version: require('electron').app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    userDataPath: require('electron').app.getPath('userData')
  }));

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  ipcMain.handle('shell:openExternal', (_, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
      shell.openExternal(url);
    }
  });

  // ── Tool Calling IPC ──
  ipcMain.handle('tool:execute', async (_, toolName: string, args: Record<string, unknown>) => {
    try {
      console.log('[IPC] tool:execute', toolName, JSON.stringify(args || {}).slice(0, 200));
      switch (toolName) {
        case 'read_file':          return await handleReadFile(args as { path: string; encoding?: string; start_line?: number; end_line?: number });
        case 'write_file':         return await handleWriteFile(args as { path: string; content: string; encoding?: string });
        case 'list_directory':     return await handleListDir(args as { path: string; recursive?: boolean; max_depth?: number; include_hidden?: boolean; filter_extension?: string });
        case 'search_files':       return await handleSearchFiles(args as { path: string; query: string; search_type?: string; case_sensitive?: boolean; max_results?: number; file_extensions?: string[] });
        case 'create_directory':   return await handleCreateDir(args as { path: string });
        case 'delete_file':        return await handleDeleteFile(args as { path: string; recursive?: boolean });
        case 'run_command':        return await handleRunCommand(args as { command: string; cwd?: string; timeout?: number });
        default:                   return { success: false, error: `未知工具: ${toolName}` };
      }
    } catch (err) {
      console.error('[IPC] tool:execute 异常:', toolName, err);
      return { success: false, error: (err as Error).message || '工具执行异常' };
    }
  });

  ipcMain.handle('tool:getConfig', () => ({
    allowedDirs: getAllowedDirs(),
    blockedDirs: getBlockedDirs()
  }));

  ipcMain.handle('tool:setAllowedDirs', (_, dirs: string[]) => {
    setAllowedDirs(dirs);
  });

  // ── Workspace IPC ──

  // 获取工作空间目录
  ipcMain.handle('workspace:getDir', () => {
    return { dir: getWorkspaceDir(), defaultDir: getWorkspaceDir() };
  });

  // 设置工作空间目录
  ipcMain.handle('workspace:setDir', (_, dir: string) => {
    try {
      setWorkspaceDir(dir);
      return { success: true, dir: getWorkspaceDir() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 列出工作空间目录
  ipcMain.handle('workspace:listDir', (_, dirPath?: string) => {
    return listWorkspaceDir(dirPath);
  });

  // 读取工作空间文件（复用 tool-handlers）
  ipcMain.handle('workspace:readFile', async (_, filePath: string) => {
    return handleReadFile({ path: filePath });
  });

  // 启动命令（流式输出，通过 workspace:output 事件推送）
  ipcMain.on('workspace:exec', (event, { id, command, cwd }: { id: string; command: string; cwd?: string }) => {
    console.log('[IPC] workspace:exec', id, command.slice(0, 200));

    const result = startProcess(
      id,
      command,
      cwd,
      (type, data) => {
        // 流式推送输出到渲染进程
        event.sender.send('workspace:output', { id, type, data });
      },
      (code) => {
        // 通知进程结束
        event.sender.send('workspace:exit', { id, code });
      }
    );

    if (!result.success) {
      event.sender.send('workspace:output', { id, type: 'stderr', data: result.error + '\n' });
      event.sender.send('workspace:exit', { id, code: 1 });
    }
  });

  // 停止命令
  ipcMain.on('workspace:kill', (_, id: string) => {
    console.log('[IPC] workspace:kill', id);
    killProcess(id);
  });
}
