/**
 * Metona Ollama Desktop - IPC 处理器
 */

import { ipcMain, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { mainWindow } from './main.js';
import { showNotification } from './utils.js';
import {
  initDatabase, saveSession, getSession, getAllSessions, deleteSession, clearAllSessions,
  saveMessage, getMessagesBySession,
  saveMemory, getMemory, getAllMemories, getMemoriesByType, deleteMemory, clearAllMemories, searchMemoriesFTS,
  saveSetting, getSetting,
  saveToolCall, getToolCallsBySession,
  saveTrace, getTracesBySession,
  saveSkill, getAllSkills, deleteSkill, clearAllSkills, searchSkills, incrementSkillUsage,
  exportAllSessions, importSessions
} from './db/sqlite.js';
import type { ExportData } from './db/sqlite.js';

/** 发送日志到渲染进程日志面板 */
function sendLog(level: 'info' | 'success' | 'warn' | 'error' | 'debug', message: string, detail?: string): void {
  mainWindow?.webContents.send('main:log', { level, message, detail });
}
import {
  handleReadFile,
  handleWriteFile,
  handleListDir,
  handleSearchFiles,
  handleCreateDir,
  handleDeleteFile,
  handleRunCommand,
  killToolProcess,
  handleMoveFile,
  handleCopyFile,
  handleWebFetch,
  handleWebSearch,
  handleAppendFile,
  handleEditFile,
  handleGetFileInfo,
  handleTree,
  handleDownloadFile,
  handleDiffFiles,
  handleReplaceInFiles,
  handleReadMultipleFiles,
  handleGit,
  handleCompress
} from './tool-handlers.js';
import { browserOpen, browserScreenshot, browserEvaluate, browserExtract, browserClick, browserType, browserScroll, browserClose } from './browser.js';
import { startServer, stopServer, stopAllServers, callTool, getAllTools, getServerStatuses, refreshTools } from './mcp-manager.js';
import { getAllowedDirs, getBlockedDirs, setAllowedDirs } from './tool-security.js';
import { startProcess, killProcess, getWorkspaceDir, setWorkspaceDir, listWorkspaceDir } from './workspace.js';

/** 工具结果摘要（用于日志面板） */
function summarizeResult(toolName: string, result: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file': return `${result.path} (${result.lines} 行${result.truncated ? ', 已截断' : ''})`;
    case 'write_file': return `${result.path} (${result.bytesWritten}B${result.created ? ', 新建' : ''})`;
    case 'list_directory': return `${result.path} (${result.total} 项${result.truncated ? ', 已截断' : ''})`;
    case 'search_files': return `"${result.query}" → ${result.total_matches} 匹配 / ${result.total_files} 文件`;
    case 'create_directory': return String(result.path);
    case 'delete_file': return String(result.path);
    case 'move_file': return `${result.source} → ${result.destination}`;
    case 'copy_file': return `${result.source} → ${result.destination}`;
    case 'web_fetch': return `${result.status} | ${result.length} chars`;
    case 'web_search': return `"${result.query}" → ${result.total} 条结果`;
    case 'append_file': return `${result.path} (${result.newSize}B)`;
    case 'edit_file': return `${result.path} (${result.replaceCount} 处替换)`;
    case 'get_file_info': return `${result.name} (${result.type}, ${result.size}B)`;
    case 'tree': return `${result.path} (${result.fileCount} 文件 / ${result.dirCount} 目录)`;
    case 'download_file': return `${result.url} → ${result.destination} (${result.size}B)`;
    case 'diff_files': return result.hasChanges ? `${result.file1} ↔ ${result.file2} (有差异)` : '无差异';
    case 'replace_in_files': return `${result.filesChanged} 文件 / ${result.totalReplacements} 处替换`;
    case 'read_multiple_files': return `${result.total} 个文件`;
    case 'git': return `${result.action} ✓`;
    case 'compress': return `${result.action} → ${result.archive || result.destination}`;
    default: return '完成';
  }
}

export async function setupIPC(): Promise<void> {
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

  ipcMain.handle('fs:readFileBase64', async (_, filePath: string) => {
    try {
      const buf = await fs.promises.readFile(filePath);
      return { success: true, content: buf.toString('base64'), size: buf.length, name: path.basename(filePath) };
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
      sendLog('debug', `🔧 tool:execute ${toolName}`, JSON.stringify(args || {}).slice(0, 200));
      let result;
      switch (toolName) {
        case 'read_file':          result = await handleReadFile(args as { path: string; encoding?: string; start_line?: number; end_line?: number }); break;
        case 'write_file':         result = await handleWriteFile(args as { path: string; content: string; encoding?: string }); break;
        case 'list_directory':     result = await handleListDir(args as { path: string; recursive?: boolean; max_depth?: number; include_hidden?: boolean; filter_extension?: string }); break;
        case 'search_files':       result = await handleSearchFiles(args as { path: string; query: string; search_type?: string; case_sensitive?: boolean; max_results?: number; file_extensions?: string[] }); break;
        case 'create_directory':   result = await handleCreateDir(args as { path: string }); break;
        case 'delete_file':        result = await handleDeleteFile(args as { path: string; recursive?: boolean }); break;
        case 'run_command':        return await handleRunCommand(args as { command: string; cwd?: string; timeout?: number }); // run_command 自身管理日志
        case 'move_file':          result = await handleMoveFile(args as { source: string; destination: string }); break;
        case 'copy_file':          result = await handleCopyFile(args as { source: string; destination: string; recursive?: boolean }); break;
        case 'web_fetch':          result = await handleWebFetch(args as { url: string; max_chars?: number; extract_mode?: string }); break;
        case 'web_search':         result = await handleWebSearch(args as { query: string; max_results?: number }); break;
        case 'append_file':        result = await handleAppendFile(args as { path: string; content: string; newline?: boolean }); break;
        case 'edit_file':          result = await handleEditFile(args as { path: string; old_text: string; new_text: string; all?: boolean }); break;
        case 'get_file_info':      result = await handleGetFileInfo(args as { path: string }); break;
        case 'tree':               result = await handleTree(args as { path: string; max_depth?: number; include_hidden?: boolean }); break;
        case 'download_file':      result = await handleDownloadFile(args as { url: string; destination: string }); break;
        case 'diff_files':         result = await handleDiffFiles(args as { file1: string; file2: string; context_lines?: number }); break;
        case 'replace_in_files':   result = await handleReplaceInFiles(args as { path: string; glob: string; old_text: string; new_text: string }); break;
        case 'read_multiple_files':result = await handleReadMultipleFiles(args as { paths: string[]; max_chars_per_file?: number }); break;
        case 'git':                result = await handleGit(args as any); break;
        case 'compress':           result = await handleCompress(args as { action: string; path: string; destination?: string; format?: string }); break;
        // v5.0 Browser 控制
        case 'browser_open':       result = await browserOpen(args.url as string); break;
        case 'browser_screenshot': result = await browserScreenshot(); break;
        case 'browser_evaluate':   result = await browserEvaluate(args.js as string); break;
        case 'browser_extract':    result = await browserExtract(); break;
        case 'browser_click':      result = await browserClick(args.selector as string); break;
        case 'browser_type':       result = await browserType(args.selector as string, args.text as string); break;
        case 'browser_scroll':     result = await browserScroll((args.direction as 'down' | 'up' | 'top' | 'bottom') || 'down'); break;
        case 'browser_close':      browserClose(); result = { success: true }; break;
        default:                   return { success: false, error: `未知工具: ${toolName}` };
      }
      // 结果日志
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
    sendLog('info', `🖥️ workspace:exec`, `ID: ${id} | ${command.slice(0, 200)}`);

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
    sendLog('info', `🖥️ workspace:kill`, `ID: ${id}`);
    killProcess(id);
  });

  // 终止当前 AI 工具命令
  ipcMain.handle('cmd:kill', async () => {
    const killed = killToolProcess();
    sendLog('info', `🔧 cmd:kill`, killed ? '已终止' : '无正在运行的工具命令');
    return { killed };
  });

  // ══════════════════════════════════════════════
  // SQLite 数据库 IPC Handlers (v4.0)
  // ══════════════════════════════════════════════

  // 初始化数据库
  await initDatabase();
  sendLog('success', '📦 SQLite 数据库已初始化');

  // Sessions
  ipcMain.handle('db:saveSession', (_, session) => {
    try { return { success: true, id: saveSession(session) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getSession', (_, id) => {
    try { return getSession(id); }
    catch { return null; }
  });
  ipcMain.handle('db:getAllSessions', () => {
    try { return getAllSessions(); }
    catch { return []; }
  });
  ipcMain.handle('db:deleteSession', (_, id) => {
    try { deleteSession(id); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:clearAllSessions', () => {
    try { clearAllSessions(); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });

  // Messages
  ipcMain.handle('db:saveMessage', (_, msg) => {
    try { return { success: true, id: saveMessage(msg) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getMessages', (_, sessionId) => {
    try { return getMessagesBySession(sessionId); }
    catch { return []; }
  });

  // Memories
  ipcMain.handle('db:saveMemory', (_, entry) => {
    try { return { success: true, id: saveMemory(entry) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getMemory', (_, id) => {
    try { return getMemory(id); }
    catch { return null; }
  });
  ipcMain.handle('db:getAllMemories', () => {
    try { return getAllMemories(); }
    catch { return []; }
  });
  ipcMain.handle('db:getMemoriesByType', (_, type) => {
    try { return getMemoriesByType(type); }
    catch { return []; }
  });
  ipcMain.handle('db:deleteMemory', (_, id) => {
    try { deleteMemory(id); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:clearAllMemories', () => {
    try { clearAllMemories(); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:searchMemories', (_, query: string, limit?: number) => {
    try { return searchMemoriesFTS(query, limit ?? 10); }
    catch { return []; }
  });

  // Settings
  ipcMain.handle('db:saveSetting', (_, key: string, value: unknown) => {
    try { saveSetting(key, value); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getSetting', (_, key: string, defaultValue?: unknown) => {
    try { return getSetting(key, defaultValue ?? null); }
    catch { return defaultValue ?? null; }
  });

  // Tool Calls
  ipcMain.handle('db:saveToolCall', (_, tc) => {
    try { return { success: true, id: saveToolCall(tc) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getToolCalls', (_, sessionId) => {
    try { return getToolCallsBySession(sessionId); }
    catch { return []; }
  });

  // Traces
  ipcMain.handle('db:saveTrace', (_, trace) => {
    try { return { success: true, id: saveTrace(trace) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getTraces', (_, sessionId) => {
    try { return getTracesBySession(sessionId); }
    catch { return []; }
  });

  // Export/Import
  ipcMain.handle('db:exportSessions', () => {
    try { return exportAllSessions(); }
    catch (err) { sendLog('error', '导出失败', (err as Error).message); return null; }
  });
  ipcMain.handle('db:importSessions', (_, data: ExportData) => {
    try { return importSessions(data); }
    catch (err) { sendLog('error', '导入失败', (err as Error).message); return { imported: 0, skipped: 0 }; }
  });

  // ── Skills (v4.2) ──
  ipcMain.handle('db:saveSkill', (_, skill) => {
    try { return { success: true, id: saveSkill(skill) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getAllSkills', () => {
    try { return getAllSkills(); }
    catch { return []; }
  });
  ipcMain.handle('db:deleteSkill', (_, id) => {
    try { deleteSkill(id); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:clearAllSkills', () => {
    try { clearAllSkills(); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:searchSkills', (_, query: string, limit?: number) => {
    try { return searchSkills(query, limit ?? 5); }
    catch { return []; }
  });
  ipcMain.handle('db:incrementSkillUsage', (_, id: string, success: boolean, durationMs: number) => {
    try { incrementSkillUsage(id, success, durationMs); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });

  // ── MCP IPC ──
  ipcMain.handle('mcp:startServer', async (_, config) => {
    return startServer(config);
  });
  ipcMain.handle('mcp:stopServer', (_, name: string) => {
    stopServer(name);
    return { success: true };
  });
  ipcMain.handle('mcp:stopAll', () => {
    stopAllServers();
    return { success: true };
  });
  ipcMain.handle('mcp:callTool', async (_, serverName: string, toolName: string, args: Record<string, unknown>) => {
    return callTool(serverName, toolName, args);
  });
  ipcMain.handle('mcp:getTools', () => {
    return getAllTools();
  });
  ipcMain.handle('mcp:getStatuses', () => {
    return getServerStatuses();
  });
  ipcMain.handle('mcp:refreshTools', async (_, name: string) => {
    return refreshTools(name);
  });
}
