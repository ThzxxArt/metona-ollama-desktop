/** Shell 命令执行与终止。 */

import * as path from 'path';
import { spawn } from 'child_process';
import { checkPathAllowed, checkCommandAllowed } from '../tool-security.js';
import { mainWindow } from '../window-state.js';
import { sendLog, type ToolResult } from '../tool-handlers-shared.js';
import { getWorkspaceDir } from '../workspace.js';

// 允许多个工具命令并发（Agent 可能同批调用多个 run_command），
// 必须逐个跟踪，不能只保留最后一个，否则 cmd:kill 会漏杀。
const _toolProcs = new Set<ReturnType<typeof spawn>>();

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

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(shell, shellArgs, {
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
      } catch (err) {
        // spawn 可能在 Promise executor 内同步抛错；必须 resolve 为工具错误，
        // 否则会变成 rejected Promise，外层 catch 无法归一化。
        const message = (err as Error).message;
        sendLog('error', `🔧 run_command 启动失败`, message);
        resolve({
          success: false,
          stdout: '',
          stderr: message,
          exitCode: 1,
          error: message,
          cwd,
          command: params.command,
        });
        return;
      }
      _toolProcs.add(proc);

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8');
        stdout += str;
        mainWindow?.webContents.send('cmd:output', { command: params.command, type: 'stdout', data: str });
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8');
        stderr += str;
        mainWindow?.webContents.send('cmd:output', { command: params.command, type: 'stderr', data: str });
      });

      proc.on('close', (code) => {
        _toolProcs.delete(proc);
        const duration = Date.now() - startTime;
        sendLog(
          code === 0 ? 'success' : 'warn',
          `🔧 run_command 完成`,
          `exitCode: ${code} | ${duration}ms | stdout: ${stdout.length}B | stderr: ${stderr.length}B`,
        );
        mainWindow?.webContents.send('cmd:done', { command: params.command, exitCode: code });
        resolve({ success: code === 0, stdout, stderr, exitCode: code, duration, cwd, command: params.command });
      });

      proc.on('error', (err) => {
        _toolProcs.delete(proc);
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
  if (_toolProcs.size === 0) {
    sendLog('warn', `🔧 cmd:kill`, '无正在运行的工具命令');
    return false;
  }
  let killed = 0;
  for (const proc of _toolProcs) {
    try {
      proc.kill('SIGTERM');
      killed++;
    } catch {
      /* 单个进程终止失败不影响其他进程 */
    }
  }
  _toolProcs.clear();
  sendLog('info', `🔧 cmd:kill`, `工具命令已终止 (${killed} 个)`);
  return killed > 0;
}
