/**
 * Workspace - 终端进程管理器
 * 管理长时间运行的子进程，通过 IPC 流式推送输出
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { mainWindow } from './main.js';
import { checkPathAllowed, checkCommandAllowed } from './tool-security.js';

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
}

/** 获取当前工作空间目录（支持用户自定义） */
let _workspaceDir = DEFAULT_WORKSPACE_DIR;

export function getWorkspaceDir(): string {
  return _workspaceDir;
}

export function setWorkspaceDir(dir: string): void {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  _workspaceDir = resolved;
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
    const proc = spawn('bash', ['-c', command], {
      cwd: workDir,
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    activeProcesses.set(id, proc);

    proc.stdout.on('data', (data: Buffer) => {
      onOutput('stdout', data.toString());
    });

    proc.stderr.on('data', (data: Buffer) => {
      onOutput('stderr', data.toString());
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
    proc.kill('SIGTERM');
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
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  activeProcesses.clear();
}

/** 列出工作空间目录内容 */
export function listWorkspaceDir(dirPath?: string): { success: boolean; entries?: Array<{ name: string; type: string; size: number | null; modified: string }>; error?: string } {
  try {
    const targetDir = dirPath ? path.resolve(dirPath) : _workspaceDir;

    // 安全检查：必须在 workspace 范围内
    if (!targetDir.startsWith(_workspaceDir) && !targetDir.startsWith(DEFAULT_WORKSPACE_DIR)) {
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

/** 检查进程是否还活着 */
export function isProcessAlive(id: string): boolean {
  return activeProcesses.has(id);
}

/** 获取活跃进程数量 */
export function getActiveProcessCount(): number {
  return activeProcesses.size;
}
