/**
 * Tool Security - 安全检查模块
 * 路径白名单/黑名单、命令过滤、路径遍历检测
 */

import * as path from 'path';
import * as os from 'os';

const HOME = os.homedir();

/** 默认允许的目录（可通过设置覆盖） */
let allowedDirs: string[] = [
  HOME,
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'Projects'),
  path.join(HOME, 'projects'),
  '/tmp',
];

/** 永久禁止的目录 */
const BLOCKED_DIRS: string[] = [
  '/etc', '/sys', '/proc', '/dev', '/boot', '/root',
  'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData',
  path.join(HOME, '.ssh'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.aws'),
];

/** 命令黑名单 */
const BLOCKED_COMMANDS: string[] = [
  'rm -rf /', 'rm -rf /*', ':(){ :|:& };:',
  'mkfs', 'dd if=', 'wipefs', 'shred',
  'shutdown', 'reboot', 'poweroff', 'halt',
  'useradd', 'usermod', 'userdel', 'passwd',
  'chmod 777', 'chown root',
  'crontab -e',
  'systemctl enable', 'systemctl disable',
  'curl | sh', 'wget | sh', 'curl | bash', 'wget | bash',
  'eval', 'exec >',
];

export interface CheckResult {
  ok: boolean;
  reason?: string;
}

export function checkPathAllowed(targetPath: string, operation: 'read' | 'write'): CheckResult {
  const resolved = path.resolve(targetPath);

  if (targetPath.split(path.sep).filter(s => s === '..').length > 5) {
    return { ok: false, reason: '路径遍历深度过大' };
  }

  for (const blocked of BLOCKED_DIRS) {
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      return { ok: false, reason: `禁止访问受保护路径: ${blocked}` };
    }
  }

  if (operation === 'write') {
    const inAllowedDir = allowedDirs.some(dir =>
      resolved === dir || resolved.startsWith(dir + path.sep)
    );
    if (!inAllowedDir) {
      return { ok: false, reason: `写操作被限制在允许的目录内。当前路径: ${resolved}` };
    }
  }

  return { ok: true };
}

export function checkCommandAllowed(command: string): CheckResult {
  const lowerCmd = command.toLowerCase().trim();

  for (const blocked of BLOCKED_COMMANDS) {
    if (lowerCmd.includes(blocked.toLowerCase())) {
      return { ok: false, reason: `命令包含被禁止的操作: ${blocked}` };
    }
  }

  if (/(\||>|<)\s*(sh|bash|zsh|powershell|cmd)/i.test(lowerCmd)) {
    return { ok: false, reason: '禁止通过管道执行 shell 命令' };
  }

  if (/\/dev\/tcp\//i.test(lowerCmd) || /bash\s+-i\s+>&/i.test(lowerCmd)) {
    return { ok: false, reason: '检测到疑似反弹 shell 操作' };
  }

  return { ok: true };
}

export function setAllowedDirs(dirs: string[]): void {
  allowedDirs = dirs.map(d => path.resolve(d));
}

export function getAllowedDirs(): string[] {
  return [...allowedDirs];
}

export function getBlockedDirs(): string[] {
  return [...BLOCKED_DIRS];
}
