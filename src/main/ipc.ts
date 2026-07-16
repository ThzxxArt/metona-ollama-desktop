/**
 * Metona Ollama Desktop - IPC 处理器
 */

import { ipcMain, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mainWindow } from './main.js';
import { showNotification } from './utils.js';
import {
  initDatabase, saveSession, getSession, getAllSessions, deleteSession, clearAllSessions,
  saveMessage, getMessagesBySession,
  saveSetting, getSetting, saveSettingsBatch,
  saveTrace, getTracesBySession,
  exportAllSessions, importSessions,
  getAllSessionsTokenStats
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
  handleEditFile,
  handleGetFileInfo,
  handleTree,
  handleDownloadFile,
  handleDiffFiles,
  handleReplaceInFiles,
  handleReadMultipleFiles,
  handleGit,
  handleCompress,
  handleDateTime,
  handleCalculator,
  handleRandom,
  handleUUID,
  handleJsonFormat,
  handleHash
} from './tool-handlers.js';
import { browserOpen, browserScreenshot, browserEvaluate, browserExtract, browserClick, browserType, browserScroll, browserClose, browserWait } from './browser.js';
import { startServer, stopServer, stopAllServers, callTool, getAllTools, getServerStatuses, refreshTools, setMCPTimeout } from './mcp-manager.js';
import { getAllowedDirs, getBlockedDirs, setAllowedDirs, checkPathAllowed } from './tool-security.js';
import { startProcess, killProcess, getWorkspaceDir, setWorkspaceDir, listWorkspaceDir } from './workspace.js';
import { setHTTPTimeout } from './tool-handlers-system.js';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import ffmpegStatic from 'ffmpeg-static';

/** 获取 ffmpeg 可执行文件路径（优先打包内置，回退系统PATH） */
function getFFmpegPath(): string {
  if (ffmpegStatic) return ffmpegStatic;
  return 'ffmpeg';
}

/** 工具结果摘要（用于日志面板） */
function summarizeResult(toolName: string, result: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file': return `${result.path} (${result.lines} 行${result.truncated ? ', 已截断' : ''})`;
    case 'write_file': return `${result.path} (${result.bytesWritten}B${result.created ? ', 新建' : ''})`;
    case 'list_directory': return `${result.path} (${result.total} 项${result.truncated ? ', 已截断' : ''})`;
    case 'search_files': return `"${result.query}" → ${result.total_matches} 匹配 / ${result.total_files} 文件`;
    case 'create_directory': return String(result.path);
    case 'delete_file': return result.batch ? `批量删除 ${result.successCount}/${result.totalPaths} 个路径` : String(result.path);
    case 'move_file': return `${result.source} → ${result.destination}`;
    case 'copy_file': return `${result.source} → ${result.destination}`;
    case 'web_fetch': return `${result.status} | ${result.length} chars`;
    case 'web_search': return `[${String(result._mode) === 'searxng' ? 'SearXNG' : '内置'}] "${result.query}" → ${result.total} 条结果`;
    case 'edit_file': return `${result.path} (${result.replaceCount} 处替换)`;
    case 'get_file_info': return `${result.name} (${result.type}, ${result.size}B)`;
    case 'tree': return `${result.path} (${result.fileCount} 文件 / ${result.dirCount} 目录)`;
    case 'download_file': return `${result.url} → ${result.destination} (${result.size}B)`;
    case 'diff_files': return result.hasChanges ? `${result.file1} ↔ ${result.file2} (有差异)` : '无差异';
    case 'replace_in_files': return `${result.filesChanged} 文件 / ${result.totalReplacements} 处替换`;
    case 'read_multiple_files': return `${result.total} 个文件`;
    case 'git': return `${result.action} ✓`;
    case 'compress': return `${result.action} → ${result.archive || result.destination}`;
    case 'datetime': return `${result.date || result.iso}`;
    case 'calculator': return `${result.expression} = ${result.result}`;
    case 'random': return `${String(result.type) === 'pick' ? '🎲 ' : ''}${result.result}`;
    case 'uuid': return `${result.result}`;
    case 'json_format': return `${Number(result.keys) || 0} keys, ${result.formatted_size}B`;
    case 'hash': return `${result.algorithm}: ${String(result.hash ?? '').slice(0, 16)}...`;
    default: return '完成';
  }
}

export async function setupIPC(): Promise<void> {
  ipcMain.handle('dialog:openFile', async (_, options?: { filters?: Array<{ name: string; extensions: string[] }>; properties?: string[]; multiple?: boolean }) => {
    const dialogProperties: Array<'openFile' | 'multiSelections' | 'openDirectory'> = ['openFile'];
    if (options?.multiple !== false && !options?.properties?.includes('openFile')) {
      dialogProperties.push('multiSelections');
    }
    if (options?.properties) {
      for (const p of options.properties) {
        if (p === 'multiSelections' && !dialogProperties.includes('multiSelections')) {
          dialogProperties.push('multiSelections');
        }
      }
    }
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: dialogProperties,
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

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory']
    });
    if (result.canceled) return null;
    return result.filePaths;
  });

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    try {
      const check = checkPathAllowed(path.resolve(filePath), 'read');
      if (!check.ok) return { success: false, error: check.reason };
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { success: true, content, name: path.basename(filePath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:readFileBase64', async (_, filePath: string) => {
    try {
      const check = checkPathAllowed(path.resolve(filePath), 'read');
      if (!check.ok) return { success: false, error: check.reason };
      const buf = await fs.promises.readFile(filePath);
      return { success: true, content: buf.toString('base64'), size: buf.length, name: path.basename(filePath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string, encoding?: string) => {
    try {
      const check = checkPathAllowed(path.resolve(filePath), 'write');
      if (!check.ok) return { success: false, error: check.reason };
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
        case 'list_directory':     result = await handleListDir(args as { path: string; recursive?: boolean; max_depth?: number; include_hidden?: boolean; filter_extension?: string; limit?: number; offset?: number }); break;
        case 'search_files':       result = await handleSearchFiles(args as { path: string; query: string; search_type?: string; case_sensitive?: boolean; use_regex?: boolean; max_results?: number; file_extensions?: string[] }); break;
        case 'create_directory':   result = await handleCreateDir(args as { path: string }); break;
        case 'delete_file':        result = await handleDeleteFile(args as { path?: string; paths?: string[]; recursive?: boolean }); break;
        case 'run_command':        return await handleRunCommand(args as { command: string; cwd?: string }); // run_command 自身管理日志
        case 'move_file':          result = await handleMoveFile(args as { source: string; destination: string }); break;
        case 'copy_file':          result = await handleCopyFile(args as { source: string; destination: string; recursive?: boolean }); break;
        case 'web_fetch':          result = await handleWebFetch(args as { url: string; max_chars?: number; extract_mode?: string; mobile_ua?: boolean; retry?: boolean }); break;
        case 'web_search':         result = await handleWebSearch(args as { query: string; max_results?: number; time_range?: string; enhance_snippets?: boolean; fetch_top?: number }); break;
        case 'edit_file':          result = await handleEditFile(args as { path: string; old_text: string; new_text: string; all?: boolean; use_regex?: boolean }); break;
        case 'get_file_info':      result = await handleGetFileInfo(args as { path: string }); break;
        case 'tree':               result = await handleTree(args as { path: string; max_depth?: number; include_hidden?: boolean }); break;
        case 'download_file':      result = await handleDownloadFile(args as { url: string; destination: string }); break;
        case 'diff_files':         result = await handleDiffFiles(args as { file1: string; file2: string; context_lines?: number }); break;
        case 'replace_in_files':   result = await handleReplaceInFiles(args as { path: string; glob: string; old_text: string; new_text: string }); break;
        case 'read_multiple_files':result = await handleReadMultipleFiles(args as { paths: string[]; max_chars_per_file?: number }); break;
        case 'git':                result = await handleGit(args as { action: string; path?: string; files?: string[]; message?: string; branch?: string; tag_name?: string; stash_sub?: string; remote?: string; remote_url?: string; count?: number; all?: boolean; staged?: boolean; new_branch?: boolean; delete_branch?: boolean; force?: boolean; url?: string }); break;
        case 'compress':           result = await handleCompress(args as { action: string; path: string; destination?: string; format?: string }); break;
    case 'datetime':          result = handleDateTime(args as { format?: string; timezone?: string }); break;
    case 'calculator':        result = handleCalculator(args as { expression: string }); break;
    case 'random':            result = handleRandom(args as { type?: string; min?: number; max?: number; count?: number; items?: string[]; length?: number }); break;
    case 'uuid':              result = handleUUID(args as { count?: number }); break;
    case 'json_format':       result = handleJsonFormat(args as { json: string; indent?: number; sort_keys?: boolean }); break;
    case 'hash':              result = handleHash(args as { text: string; algorithm?: string }); break;
        // v5.1 Browser 控制（增强版）
        case 'browser_open':       result = await browserOpen(args.url as string, args.wait_selector as string | undefined); break;
        case 'browser_screenshot': result = await browserScreenshot({ full_page: args.full_page as boolean, selector: args.selector as string }); break;
        case 'browser_evaluate':   result = await browserEvaluate(args.js as string); break;
        case 'browser_extract':    result = await browserExtract({ selector: args.selector as string, max_chars: args.max_chars as number }); break;
        case 'browser_click':      result = await browserClick(args.selector as string, (args.wait as boolean) || false); break;
        case 'browser_type':       result = await browserType(args.selector as string, args.text as string, args.clear !== false, args.submit as boolean || false); break;
        case 'browser_scroll':     result = await browserScroll({ direction: args.direction as string, selector: args.selector as string }); break;
        case 'browser_wait':       result = await browserWait({ selector: args.selector as string, time_ms: args.time_ms as number }); break;
        case 'browser_close':      await browserClose(); result = { success: true }; break;
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

  ipcMain.handle('tool:setTimeouts', (_, timeouts: { http?: number; mcp?: number }) => {
    if (typeof timeouts.http === 'number' && timeouts.http >= 0) {
      setHTTPTimeout(timeouts.http);
    }
    if (typeof timeouts.mcp === 'number' && timeouts.mcp >= 0) {
      setMCPTimeout(timeouts.mcp);
    }
    return { success: true };
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
	      // ── 持久化到 SQLite，重启后恢复 ──
	      saveSetting('workspaceDir', getWorkspaceDir());
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

  // ── 恢复工作空间目录 ──
  try {
    const savedWsDir = getSetting<string>('workspaceDir', '');
    if (savedWsDir) {
      setWorkspaceDir(savedWsDir);
      sendLog('info', '📁 恢复工作空间目录', savedWsDir);
    }
  } catch { /* ignore */ }

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

  // Settings
  ipcMain.handle('db:saveSetting', (_, key: string, value: unknown) => {
    try { saveSetting(key, value); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  // P1-P2 修复：批量保存设置，只触发一次 persist
  ipcMain.handle('db:saveSettingsBatch', (_, entries: Array<{ key: string; value: unknown }>) => {
    try { saveSettingsBatch(entries); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getSetting', (_, key: string, defaultValue?: unknown) => {
    try { return getSetting(key, defaultValue ?? null); }
    catch { return defaultValue ?? null; }
  });

  // Tool Calls — P1-P3 修复：删除死代码（渲染进程从未调用，工具记录通过 messages.tool_calls 存储）

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

  // ── Token 全局统计 ──
  ipcMain.handle('db:getAllTokenStats', () => {
    try { return getAllSessionsTokenStats(); }
    catch (err) { sendLog('error', '获取全局 Token 统计失败', (err as Error).message); return null; }
  });

  // ── Memory 文件访问（专用通道，绕过 checkPathAllowed，仅限 MEMORY.md）──
  ipcMain.handle('memory:read', async () => {
    const wsDir = getWorkspaceDir();
    const memoryPath = path.join(wsDir, 'MEMORY.md');
    try {
      if (!fs.existsSync(memoryPath)) {
        return { success: true, content: '' };
      }
      const content = await fs.promises.readFile(memoryPath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('memory:write', async (_, content: string) => {
    const wsDir = getWorkspaceDir();
    const memoryPath = path.join(wsDir, 'MEMORY.md');
    try {
      // 确保工作空间目录存在
      if (!fs.existsSync(wsDir)) {
        await fs.promises.mkdir(wsDir, { recursive: true });
      }
      if (content === '' || content.trim() === '') {
        // 空内容 → 删除文件（让下次读取返回空）
        if (fs.existsSync(memoryPath)) {
          await fs.promises.unlink(memoryPath);
        }
        sendLog('info', '🧠 memory:write', 'MEMORY.md 已清空');
        return { success: true };
      }
      await fs.promises.writeFile(memoryPath, content, 'utf-8');
      sendLog('success', '🧠 memory:write', `MEMORY.md 已写入 (${content.length} 字符)`);
      return { success: true };
    } catch (err) {
      sendLog('error', '🧠 memory:write 失败', (err as Error).message);
      return { success: false, error: (err as Error).message };
    }
  });

  /** MEMORY.md 初始化：检查 → 校验 → 备份(如格式错误) → 重建 */
  ipcMain.handle('memory:init', async () => {
    const wsDir = getWorkspaceDir();
    const memoryPath = path.join(wsDir, 'MEMORY.md');
    const result: { action: string; existed: boolean; valid: boolean; backedUp?: string } = {
      action: '', existed: false, valid: false,
    };

    try {
      // 确保工作空间目录存在
      if (!fs.existsSync(wsDir)) {
        await fs.promises.mkdir(wsDir, { recursive: true });
        sendLog('info', '🧠 memory:init', `工作空间目录已创建: ${wsDir}`);
      }

      const exists = fs.existsSync(memoryPath);
      result.existed = exists;

      if (!exists) {
        // 文件不存在 → 创建符合格式的空模板
        const template = `# METONA MEMORY
> ⚠️ 此文件由 memory 工具自动管理，严禁手动编辑
> 元数据格式: ## [类型] | id: [ID] | importance: [1-10] | tags: [tag1, tag2, ...]
> 条目内容紧跟元数据行，直到下一个 ## 或文件末尾

`;
        await fs.promises.writeFile(memoryPath, template, 'utf-8');
        result.action = 'created';
        sendLog('success', '🧠 MEMORY.md 已创建', `路径: ${memoryPath}`);
      } else {
        // 文件存在 → 校验格式
        const content = await fs.promises.readFile(memoryPath, 'utf-8');
        const valid = validateMemoryContent(content);
        result.valid = valid;

        if (!valid) {
          // 格式不符合 → 备份为 .bak，然后重建
          const bakPath = memoryPath + '.bak';
          await fs.promises.copyFile(memoryPath, bakPath);
          result.backedUp = bakPath;

          const template = `# METONA MEMORY
> ⚠️ 此文件由 memory 工具自动管理，严禁手动编辑
> 元数据格式: ## [类型] | id: [ID] | importance: [1-10] | tags: [tag1, tag2, ...]
> 条目内容紧跟元数据行，直到下一个 ## 或文件末尾

`;
          await fs.promises.writeFile(memoryPath, template, 'utf-8');
          result.action = 'recreated';
          sendLog('warn', '🧠 MEMORY.md 格式不符合规范，已备份并重建',
            `原文件 → ${bakPath} | 新文件已创建: ${memoryPath}`);
        } else {
          result.action = 'valid';
          sendLog('info', '🧠 MEMORY.md 格式校验通过', `路径: ${memoryPath} | ${content.split('\n').filter(l => /^## (fact|preference|rule)/i.test(l)).length} 条记忆`);
        }
      }

      return { success: true, ...result };
    } catch (err) {
      sendLog('error', '🧠 memory:init 失败', (err as Error).message);
      return { success: false, error: (err as Error).message, ...result };
    }
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

  // ── 视频帧提取 ──
  ipcMain.handle('video:extractFrames', async (_, filePath: string, options?: { maxFrames?: number; maxWidth?: number; maxSize?: number }) => {
    const maxFrames = options?.maxFrames || 600;
    const maxWidth = options?.maxWidth || 512;
    const maxSize = options?.maxSize || 10 * 1024 * 1024; // 默认 10MB

    // 文件大小检查
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > maxSize) {
        return { success: false, error: `视频文件过大: ${(stat.size / 1024 / 1024).toFixed(1)}MB，限制 ${maxSize / 1024 / 1024}MB` };
      }
    } catch {
      return { success: false, error: '无法读取视频文件' };
    }

    return extractVideoFrames(filePath, maxFrames, maxWidth);
  });
}

/** 校验 MEMORY.md 内容格式 */
function validateMemoryContent(content: string): boolean {
  if (!content || !content.trim()) return false;
  const lines = content.split('\n');
  const firstLine = lines[0]?.trim();
  if (firstLine !== '# METONA MEMORY') return false;

  // 检查 ## 条目头格式是否正确
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('>')) continue;
    const match = trimmed.match(/^##\s+(fact|preference|rule)\s*\|\s*id:\s*(mem_\d{8}_\d{3})\s*\|\s*importance:\s*(\d{1,2})\s*\|\s*tags:\s*(.+)$/i);
    if (match) {
      const importance = parseInt(match[3], 10);
      if (importance < 1 || importance > 10) return false;
      const tagsStr = match[4]?.trim();
      if (!tagsStr) return false;
    }
  }

  // 允许空文件（只有头部没有条目），也允许有条目的文件
  return true;
}

// ── 视频帧提取 (ffmpeg) ──

interface ExtractedFrame {
  name: string;            // 如 "frame_01_0.0s.jpg"
  base64: string;          // JPEG base64
  timestampSeconds: number; // 帧在视频中的时间位置（秒）
}

interface VideoInfo {
  duration: number;   // 秒
  width: number;
  height: number;
}

function parseVideoInfo(stderr: string): { duration: number; width: number; height: number } | null {
  // 解析 Duration: 00:00:30.05
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  const duration = durMatch ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]) : 0;

  // 解析 Video: ... 1920x1080 ...
  const resMatch = stderr.match(/(\d{2,5})x(\d{2,5})/);
  const width = resMatch ? parseInt(resMatch[1]) : 0;
  const height = resMatch ? parseInt(resMatch[2]) : 0;

  if (duration <= 0 && width <= 0) return null;
  return { duration, width, height };
}

async function extractVideoFrames(filePath: string, maxFrames: number, maxWidth: number): Promise<{ success: boolean; frames?: ExtractedFrame[]; videoInfo?: VideoInfo; error?: string }> {
  const tmpDir = path.join(os.tmpdir(), `metona-video-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });

    // ffmpeg 提取帧：1fps，同时捕获 stderr 解析进度和视频信息
    const outPattern = path.join(tmpDir, 'frame_%04d.jpg');
    let ffmpegStderr = '';
    let lastProgressFrame = 0;
    let lastProgressTime = Date.now();

    await new Promise<void>((ffResolve, ffReject) => {
      const child = execFile(getFFmpegPath(), [
        '-y',
        '-i', filePath,
        '-vf', `scale=${maxWidth}:-1,fps=1`,
        '-q:v', '3',
        '-frames:v', String(maxFrames),
        '-threads', '2',
        '-progress', 'pipe:1',  // 结构化进度输出到 stdout
        outPattern
      ], { timeout: 120_000 }, (err) => {
        if (err) { ffReject(new Error(`ffmpeg 执行失败: ${err.message}`)); return; }
        ffResolve();
      });
      child.stderr?.on('data', (data: Buffer) => {
        ffmpegStderr += data.toString();
        // 实时推送进度到渲染进程（每秒一次，覆盖更新）
        const match = ffmpegStderr.match(/frame=\s*(\d+)/g);
        if (match) {
          const last = match[match.length - 1];
          const currentFrame = parseInt(last.replace(/\D/g, ''));
          if (currentFrame > lastProgressFrame && Date.now() - lastProgressTime > 1000) {
            lastProgressFrame = currentFrame;
            lastProgressTime = Date.now();
            mainWindow?.webContents.send('video:progress', { current: currentFrame });
          }
        }
      });
    });

    // 从 stderr 解析视频信息，失败则从帧数估算
    let videoInfo = parseVideoInfo(ffmpegStderr);
    if (!videoInfo) {
      videoInfo = { duration: 0, width: 0, height: 0 };
    }

    // 读取提取的帧
    const files = await fs.promises.readdir(tmpDir);
    const jpegs = files.filter(f => f.endsWith('.jpg')).sort();
    if (jpegs.length === 0) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
      return { success: false, error: '没有提取到视频帧' };
    }

    // 如果没解析到时长，从帧数估算（fps=1）
    if (videoInfo.duration <= 0) {
      videoInfo.duration = jpegs.length;
    }

    const frames: ExtractedFrame[] = [];
    for (let i = 0; i < jpegs.length; i++) {
      const f = jpegs[i];
      const buf = await fs.promises.readFile(path.join(tmpDir, f));
      if (buf.length < 200) continue;
      const timestampSec = i; // fps=1，帧索引 = 秒数
      frames.push({
        name: `frame_${String(i + 1).padStart(2, '0')}_${timestampSec.toFixed(1)}s.jpg`,
        base64: buf.toString('base64'),
        timestampSeconds: timestampSec
      });
    }

    await fs.promises.rm(tmpDir, { recursive: true, force: true });

    return { success: true, frames, videoInfo };

  } catch (err) {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    sendLog('error', '视频帧提取失败', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}
