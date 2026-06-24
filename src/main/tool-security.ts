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
  // Linux/macOS 系统目录
  '/etc', '/sys', '/proc', '/dev', '/boot', '/root',
  '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib',
  '/var/log', '/var/run', '/var/spool', '/var/mail',
  '/tmp/.X11-unix', '/tmp/.font-unix',
  // Windows 系统目录
  'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Windows\\SysWOW64',
  'C:\\Windows\\System', 'C:\\Windows\\WinSxS',
  'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
  // 用户敏感目录
  path.join(HOME, '.ssh'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.aws'),
  path.join(HOME, '.azure'),
  path.join(HOME, '.config'),
  path.join(HOME, '.kube'),
  path.join(HOME, 'AppData'),
];

/** 命令黑名单 */
const BLOCKED_COMMANDS: string[] = [
  // POSIX 危险命令
  'rm -rf /', 'rm -rf /*', ':(){ :|:& };:',
  'mkfs', 'dd if=', 'wipefs', 'shred',
  'shutdown', 'reboot', 'poweroff', 'halt',
  'useradd', 'usermod', 'userdel', 'passwd',
  'chmod 777', 'chown root',
  'crontab -e',
  'systemctl enable', 'systemctl disable',
  'curl | sh', 'wget | sh', 'curl | bash', 'wget | bash',
  'eval', 'exec >',
  // Windows 危险命令
  'rmdir /s', 'del /f', 'del /s', 'del /q',
  'format', 'diskpart',
  'reg add', 'reg delete', 'reg import', 'reg export',
  'sc stop', 'sc delete', 'sc config',
  'net user', 'net localgroup', 'net share',
  'icacls', 'takeown', 'cacls',
  'bcdedit', 'wmic', 'rundll32',
  'schtasks /create', 'schtasks /delete',
];

export interface CheckResult {
  ok: boolean;
  reason?: string;
}

/** 路径安全豁免列表：这些路径即使匹配 BLOCKED_DIRS 也放行（如 app 自己的工作空间） */
let blocklistExemptions: string[] = [];

/** 工作空间下受保护的文件名：任何工具都禁止直接读写，只能通过专用通道访问 */
const BLOCKED_FILES = new Set(['MEMORY.md']);

/** 注册路径为安全豁免（不受 BLOCKED_DIRS 限制）。主要用于注册工作空间目录 */
export function addBlocklistExemptions(dirs: string[]): void {
  for (const d of dirs) {
    const resolved = path.resolve(d);
    if (!blocklistExemptions.includes(resolved)) {
      blocklistExemptions.push(resolved);
    }
  }
}

/** 检查路径是否在豁免列表中 */
function isBlocklistExempt(resolved: string): boolean {
  for (const exempt of blocklistExemptions) {
    if (resolved === exempt || resolved.startsWith(exempt + path.sep)) {
      return true;
    }
  }
  return false;
}

/** 检查文件是否在工作空间下且属于受保护文件（MEMORY.md 等） */
export function isBlockedFile(targetPath: string): boolean {
  try {
    const resolved = path.resolve(targetPath);
    const basename = path.basename(resolved);
    if (!BLOCKED_FILES.has(basename)) return false;
    // 只保护工作空间下的 MEMORY.md（其他目录下的同名文件不保护）
    for (const exempt of blocklistExemptions) {
      if (resolved === path.join(exempt, basename) || resolved.startsWith(exempt + path.sep)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function checkPathAllowed(targetPath: string, operation: 'read' | 'write'): CheckResult {
  const resolved = path.resolve(targetPath);

  if (targetPath.split(path.sep).filter(s => s === '..').length > 5) {
    return { ok: false, reason: '路径遍历深度过大' };
  }

  // ── 文件级保护：MEMORY.md 等受保护文件禁止所有工具直接访问 ──
  if (isBlockedFile(resolved)) {
    const basename = path.basename(resolved);
    return { ok: false, reason: `禁止直接访问 ${basename}。此文件只能通过 memory 工具操作，其他任何工具都无权读写。` };
  }

  for (const blocked of BLOCKED_DIRS) {
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      // 如果路径在安全豁免列表中（如 app 自己的工作空间），放行
      if (!isBlocklistExempt(resolved)) {
        return { ok: false, reason: `禁止访问受保护路径: ${blocked}` };
      }
    }
  }

  if (operation === 'write') {
    // 允许写入的目录：allowedDirs 白名单 + 黑名单豁免目录（工作空间等）
    const inAllowedDir = allowedDirs.some(dir =>
      resolved === dir || resolved.startsWith(dir + path.sep)
    ) || isBlocklistExempt(resolved);
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
