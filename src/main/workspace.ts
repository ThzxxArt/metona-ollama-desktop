/**
 * Workspace - 终端进程管理器
 * 管理长时间运行的子进程，通过 IPC 流式推送输出
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { mainWindow } from './main.js';
import { checkPathAllowed, checkCommandAllowed, addBlocklistExemptions, isSystemBlockedPath } from './tool-security.js';

/** 发送日志到渲染进程日志面板 */
function sendLog(level: 'info' | 'success' | 'warn' | 'error' | 'debug', message: string, detail?: string): void {
  mainWindow?.webContents.send('main:log', { level, message, detail });
}

export const DEFAULT_WORKSPACE_DIR = path.join(app.getPath('userData'), 'workspace');

/** 活跃进程 Map */
const activeProcesses = new Map<string, ChildProcess>();

/** 确保工作空间目录存在 */
export function ensureWorkspaceDir(): void {
  if (!fs.existsSync(DEFAULT_WORKSPACE_DIR)) {
    fs.mkdirSync(DEFAULT_WORKSPACE_DIR, { recursive: true });
    sendLog('info', `📁 创建默认工作空间目录`, DEFAULT_WORKSPACE_DIR);
  }
  // 工作空间目录及其子目录不受安全黑名单限制
  addBlocklistExemptions([DEFAULT_WORKSPACE_DIR]);
}

/** 获取当前工作空间目录（支持用户自定义） */
let _workspaceDir = DEFAULT_WORKSPACE_DIR;

export function getWorkspaceDir(): string {
  return _workspaceDir;
}

export function setWorkspaceDir(dir: string): void {
  const resolved = path.resolve(dir);
  // 系统目录硬红线：防止"把 C:\Windows\x 设为工作空间"导致黑名单被豁免穿透
  if (isSystemBlockedPath(resolved)) {
    throw new Error(`不能将系统目录设为工作空间: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  _workspaceDir = resolved;
  // 用户自定义的工作空间目录也需安全豁免
  addBlocklistExemptions([resolved]);
}

/**
 * 启动一个命令进程
 * @param id 唯一标识，用于后续 kill
 * @param command 要执行的 shell 命令
 * @param cwd 工作目录，默认 workspace
 * @param onOutput 输出回调 (type, data)
 * @param onExit 退出回调 (code)
 */
export function startProcess(
  id: string,
  command: string,
  cwd: string | undefined,
  onOutput: (type: 'stdout' | 'stderr', data: string) => void,
  onExit: (code: number | null) => void
): { success: boolean; error?: string } {
  // 安全检查
  const cmdCheck = checkCommandAllowed(command);
  if (!cmdCheck.ok) {
    sendLog('warn', `🖥️ 命令被拦截`, `${command.slice(0, 100)} | ${cmdCheck.reason}`);
    return { success: false, error: cmdCheck.reason };
  }

  const workDir = cwd ? path.resolve(cwd) : _workspaceDir;
  const dirCheck = checkPathAllowed(workDir, 'read');
  if (!dirCheck.ok) {
    sendLog('warn', `🖥️ 目录被拦截`, `${workDir} | ${dirCheck.reason}`);
    return { success: false, error: dirCheck.reason };
  }

  sendLog('info', `🖥️ spawn`, `ID: ${id} | ${command.slice(0, 100)} | cwd: ${workDir}`);

  // 确保目录存在
  if (!fs.existsSync(workDir)) {
    return { success: false, error: `工作目录不存在: ${workDir}` };
  }

  // 杀掉同 id 的旧进程
  if (activeProcesses.has(id)) {
    try { activeProcesses.get(id)!.kill('SIGTERM'); } catch { /* ignore */ }
    activeProcesses.delete(id);
  }

  try {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'bash';
    // Windows cmd 默认代码页为 GBK/CP936，中文输出会乱码
    // chcp 65001 切换到 UTF-8 代码页，>nul 抑制 chcp 自身的输出
    const actualCmd = isWin ? `chcp 65001 >nul && ${command}` : command;
    const shellArgs = isWin ? ['/c', actualCmd] : ['-c', actualCmd];
    const proc = spawn(shell, shellArgs, {
      cwd: workDir,
      env: {
        ...process.env,
        ...(isWin ? {} : { TERM: 'xterm-256color' }),
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        PYTHONIOENCODING: 'utf-8'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    activeProcesses.set(id, proc);

    proc.stdout.on('data', (data: Buffer) => {
      onOutput('stdout', data.toString('utf-8'));
    });

    proc.stderr.on('data', (data: Buffer) => {
      onOutput('stderr', data.toString('utf-8'));
    });

    proc.on('close', (code) => {
      activeProcesses.delete(id);
      sendLog(code === 0 ? 'success' : 'warn', `🖥️ 进程退出`, `ID: ${id} | code: ${code}`);
      onExit(code);
    });

    proc.on('error', (err) => {
      activeProcesses.delete(id);
      sendLog('error', `🖥️ 进程启动失败`, `ID: ${id} | ${err.message}`);
      onOutput('stderr', `进程启动失败: ${err.message}\n`);
      onExit(1);
    });

    return { success: true };
  } catch (err) {
    sendLog('error', `🖥️ spawn 异常`, `ID: ${id} | ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

/** 停止指定进程 */
export function killProcess(id: string): boolean {
  const proc = activeProcesses.get(id);
  if (!proc) {
    sendLog('warn', `🖥️ kill 未找到进程`, `ID: ${id}`);
    return false;
  }
  try {
    // Windows 不支持 POSIX 信号，需用 taskkill 强制终止进程树
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    } else {
      proc.kill('SIGTERM');
    }
    activeProcesses.delete(id);
    sendLog('info', `🖥️ 进程已终止`, `ID: ${id}`);
    return true;
  } catch {
    activeProcesses.delete(id);
    sendLog('warn', `🖥️ kill 异常`, `ID: ${id}`);
    return false;
  }
}

/** 停止所有进程（窗口关闭时调用） */
export function killAllProcesses(): void {
  for (const [id, proc] of activeProcesses) {
    try {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
      } else {
        proc.kill('SIGTERM');
      }
    } catch { /* ignore */ }
  }
  activeProcesses.clear();
}

/** 列出工作空间目录内容 */
export function listWorkspaceDir(dirPath?: string): { success: boolean; entries?: Array<{ name: string; type: string; size: number | null; modified: string }>; error?: string } {
  try {
    const targetDir = dirPath ? path.resolve(dirPath) : _workspaceDir;

    // 安全检查：必须在 workspace 范围内（Windows 路径大小写不敏感）
    const isWin = process.platform === 'win32';
    const targetCheck = isWin ? targetDir.toLowerCase() : targetDir;
    const wsCheck = isWin ? _workspaceDir.toLowerCase() : _workspaceDir;
    const defaultCheck = isWin ? DEFAULT_WORKSPACE_DIR.toLowerCase() : DEFAULT_WORKSPACE_DIR;
    if (!targetCheck.startsWith(wsCheck) && !targetCheck.startsWith(defaultCheck)) {
      return { success: false, error: '只能浏览工作空间目录内的文件' };
    }

    if (!fs.existsSync(targetDir)) {
      return { success: false, error: '目录不存在' };
    }

    const items = fs.readdirSync(targetDir, { withFileTypes: true });
    const entries = items
      .filter(item => !item.name.startsWith('.'))
      .map(item => {
        const fullPath = path.join(targetDir, item.name);
        const stat = fs.statSync(fullPath);
        return {
          name: item.name,
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isFile() ? stat.size : null,
          modified: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => {
        // 目录优先，然后按名称排序
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return { success: true, entries };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
