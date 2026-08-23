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
  saveMessage, saveMessagesBatch, getMessagesBySession,
  saveSetting, getSetting, saveSettingsBatch,
  saveTrace, saveTracesBatch, getTracesBySession,
  exportAllSessions, importSessions,
  getSessionSummaries, searchSessions, getAllSessionsData,
  getAllSessionsTokenStats,
  saveToolAudit, getToolAuditsBySession, getAllToolAudits
} from './db/sqlite.js';
import type { ExportData, MessageRow, SessionSummaryRow } from './db/sqlite.js';

/** 发送日志到渲染进程日志面板 */
function sendLog(level: 'info' | 'success' | 'warn' | 'error' | 'debug', message: string, detail?: string): void {
  mainWindow?.webContents.send('main:log', { level, message, detail });
}
import {
  handleRunCommand,
  killToolProcess,
} from './tool-handlers.js';
import { getToolHandler } from './tool-dispatch.js';
import { startServer, stopServer, stopAllServers, callTool, getAllTools, getServerStatuses, refreshTools, setMCPTimeout } from './mcp-manager.js';
import { getAllowedDirs, getBlockedDirs, setAllowedDirs, checkPathAllowed } from './tool-security.js';
import { startProcess, killProcess, getWorkspaceDir, setWorkspaceDir, listWorkspaceDir } from './workspace.js';
import { setHTTPTimeout } from './tool-handlers-system.js';
import { updateCorsAllowlist } from './main.js';
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
    case 'tree': return `${result.path} (${result.fileCount} 文件 / ${result.dirCount} 目录)`;
    case 'download_file': return `${result.url} → ${result.destination} (${result.size}B)`;
    case 'read_multiple_files': return `${result.total} 个文件`;
    case 'git': return `${result.action} ✓`;
    case 'compress': return `${result.action} → ${result.archive || result.destination}`;
    case 'diff': return result.identical ? '无差异' : `+${result.additions} -${result.deletions} (${result.hunk_count} hunks)`;
    case 'calculator': return `${result.expression} = ${result.result}`;
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

  // ── 内置资源读取（SOUL.md / AGENT.md 等；basename 防路径穿越）──
  // 取代渲染进程在 file:// 页面上直接 fetch 相对路径（webSecurity 开启后不可用）
  ipcMain.handle('app:readResource', (_, name: string) => {
    const safe = path.basename(String(name || ''));
    if (!safe || safe.startsWith('.')) {
      return { success: false, error: `非法资源名: ${name}` };
    }
    const app = require('electron').app;
    // 开发模式资源在 src/renderer/public/；生产模式在 dist/renderer/
    const base = app.isPackaged
      ? path.join(__dirname, '..', 'renderer')
      : path.join(__dirname, '..', '..', 'src', 'renderer', 'public');
    const filePath = path.join(base, safe);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, content };
    } catch {
      return { success: false, error: `资源不存在: ${safe}` };
    }
  });

  // ── 更新 Ollama 地址的 CORS 允许清单（设置面板保存地址后调用）──
  ipcMain.handle('app:setOllamaOrigin', (_, url: string) => {
    updateCorsAllowlist(url);
    return { success: true };
  });

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
      if (toolName === 'run_command') {
        // run_command 自身管理日志与实时输出流，提前返回
        return await handleRunCommand(args as { command: string; cwd?: string });
      }
      const handler = getToolHandler(toolName);
      if (!handler) {
        return { success: false, error: `未知工具: ${toolName}` };
      }
      result = await handler(args);
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

  // 读取工作空间文件（复用 tool-handlers 注册表）
  ipcMain.handle('workspace:readFile', async (_, filePath: string) => {
    const handler = getToolHandler('read_file');
    if (!handler) return { success: false, error: 'read_file 处理器不可用' };
    return handler({ path: filePath });
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
  ipcMain.handle('db:saveMessagesBatch', (_, msgs: MessageRow[]) => {
    try { return { success: true, count: saveMessagesBatch(msgs) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getMessages', (_, sessionId) => {
    try { return getMessagesBySession(sessionId); }
    catch { return []; }
  });

  // ── 会话摘要（单条 SQL，历史列表/搜索不再全量加载消息）──
  ipcMain.handle('db:getSessionSummaries', () => {
    try { return getSessionSummaries(); }
    catch (err) { sendLog('error', '获取会话摘要失败', (err as Error).message); return []; }
  });
  ipcMain.handle('db:searchSessions', (_, query: string) => {
    try { return searchSessions(String(query || '')); }
    catch (err) { sendLog('error', '搜索会话失败', (err as Error).message); return []; }
  });
  // 全量会话+消息（导出用，一次 IPC 取代渲染端 N+1 往返）
  ipcMain.handle('db:getAllSessionsData', () => {
    try { return getAllSessionsData(); }
    catch (err) { sendLog('error', '获取全量会话数据失败', (err as Error).message); return { sessions: [], messages: [] }; }
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
  ipcMain.handle('db:saveTracesBatch', (_, traces) => {
    try { return { success: true, count: saveTracesBatch(traces) }; }
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

  // ── 工具审计日志 ──
  ipcMain.handle('db:saveToolAudit', (_: unknown, audit: unknown) => {
    try { return { success: true, id: saveToolAudit(audit as any) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getToolAudits', (_: unknown, sessionId: string) => {
    try { return { success: true, audits: getToolAuditsBySession(sessionId) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });
  ipcMain.handle('db:getAllToolAudits', (_: unknown, limit?: number) => {
    try { return { success: true, audits: getAllToolAudits(limit || 200) }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
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

/** 校验 MEMORY.md 内容格式（兼容可选的访问统计后缀 `| hits: N | last: TS`） */
function validateMemoryContent(content: string): boolean {
  if (!content || !content.trim()) return false;
  const lines = content.split('\n');
  const firstLine = lines[0]?.trim();
  if (firstLine !== '# METONA MEMORY') return false;

  // 检查 ## 条目头格式是否正确
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('>')) continue;
    const match = trimmed.match(/^##\s+(fact|preference|rule)\s*\|\s*id:\s*(mem_\d{8}_\d{3})\s*\|\s*importance:\s*(\d{1,2})\s*\|\s*tags:\s+(.+?)(?:\s*\|\s*hits:\s*(\d+)\s*\|\s*last:\s*(\d+))?\s*$/i);
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
        const chunk = data.toString();
        // 只保留最近 32KB stderr（解析视频信息用），避免长视频提取时无限累积
        ffmpegStderr = (ffmpegStderr + chunk).slice(-32768);
        // 帧进度：只解析当前 chunk，避免对全量字符串反复正则（O(n²) 退化）
        const frameMatch = chunk.match(/frame=\s*(\d+)/g);
        if (frameMatch) {
          const currentFrame = parseInt(frameMatch[frameMatch.length - 1].replace(/\D/g, ''));
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
