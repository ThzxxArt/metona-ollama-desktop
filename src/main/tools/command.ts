/** Shell 命令执行与终止。 */

import * as path from 'path';
import { spawn } from 'child_process';
import { checkPathAllowed, checkCommandAllowed } from '../tool-security.js';
import { mainWindow } from '../window-state.js';
import { sendLog, type ToolResult } from '../tool-handlers-shared.js';
import { getWorkspaceDir } from '../workspace.js';

let _toolProc: ReturnType<typeof spawn> | null = null;

export async function handleRunCommand(params: { command: string; cwd?: string }): Promise<ToolResult> {
  try {
    const cmdCheck = checkCommandAllowed(params.command);
    if (!cmdCheck.ok) {
      sendLog('warn', `🔧 run_command 被拦截`, `${params.command.slice(0, 100)} | ${cmdCheck.reason}`);
      return { success: false, error: cmdCheck.reason };
    }

    const cwd = params.cwd ? path.resolve(params.cwd) : getWorkspaceDir();
    const dirCheck = checkPathAllowed(cwd, 'read');
    if (!dirCheck.ok) {
      sendLog('warn', `🔧 run_command 目录被拦截`, `${cwd} | ${dirCheck.reason}`);
      return { success: false, error: dirCheck.reason };
    }

    sendLog('info', `🔧 run_command 执行`, `${params.command.slice(0, 200)} | cwd: ${cwd}`);

    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : 'bash';
      const actualCmd = isWin ? `chcp 65001 >nul && ${params.command}` : params.command;
      const shellArgs = isWin ? ['/c', actualCmd] : ['-c', actualCmd];
      const startTime = Date.now();

      _toolProc = spawn(shell, shellArgs, {
        cwd,
        env: {
          ...process.env,
          ...(isWin ? {} : { TERM: 'xterm-256color' }),
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      _toolProc.stdout?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8');
        stdout += str;
        mainWindow?.webContents.send('cmd:output', { command: params.command, type: 'stdout', data: str });
      });

      _toolProc.stderr?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8');
        stderr += str;
        mainWindow?.webContents.send('cmd:output', { command: params.command, type: 'stderr', data: str });
      });

      _toolProc.on('close', (code) => {
        _toolProc = null;
        const duration = Date.now() - startTime;
        sendLog(
          code === 0 ? 'success' : 'warn',
          `🔧 run_command 完成`,
          `exitCode: ${code} | ${duration}ms | stdout: ${stdout.length}B | stderr: ${stderr.length}B`,
        );
        mainWindow?.webContents.send('cmd:done', { command: params.command, exitCode: code });
        resolve({ success: code === 0, stdout, stderr, exitCode: code, duration, cwd, command: params.command });
      });

      _toolProc.on('error', (err) => {
        _toolProc = null;
        const duration = Date.now() - startTime;
        sendLog('error', `🔧 run_command 失败`, `${err.message} | ${duration}ms`);
        mainWindow?.webContents.send('cmd:done', { command: params.command, exitCode: 1 });
        resolve({
          success: false,
          stdout,
          stderr: stderr + (stderr ? '\n' : '') + err.message,
          exitCode: 1,
          error: err.message,
          duration,
          cwd,
          command: params.command,
        });
      });
    });
  } catch (err) {
    sendLog('error', `🔧 run_command 异常`, (err as Error).message);
    return {
      success: false,
      stdout: '',
      stderr: (err as Error).message,
      exitCode: 1,
      error: (err as Error).message,
    };
  }
}

export function killToolProcess(): boolean {
  if (!_toolProc) {
    sendLog('warn', `🔧 cmd:kill`, '无正在运行的工具命令');
    return false;
  }
  try {
    _toolProc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  _toolProc = null;
  sendLog('info', `🔧 cmd:kill`, '工具命令已终止');
  return true;
}
