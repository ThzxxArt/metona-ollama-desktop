/**
 * 工具参数校验、安全校验、类型转换与错误建议。
 */

import { logWarn } from '../log-service.js';
import { TOOL_DEFINITIONS } from './catalog.js';

// ── R28: 路径遍历 / 命令注入 ──

function hasPathTraversal(path: string): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, '/');
  const traversalCount = (normalized.match(/\.\.\//g) || []).length;
  if (traversalCount > 3) return true;
  if (normalized.includes('../../../')) return true;
  return false;
}

const DANGEROUS_CMD_KEYWORDS = 'rm|del|format|mkfs|dd|fdisk|shred|umount|chmod\\s+777|chown|shutdown|reboot|halt';

function hasCommandInjection(command: string): boolean {
  if (!command) return false;
  const dangerousPatterns = [
    /;\s*(rm|del|format|mkfs|dd)\s/i,
    /\|\s*(rm|del|format|mkfs)\s/i,
    /&&\s*(rm|del|format|mkfs)\s/i,
    /\$\{.*IFS.*\}/i,
    new RegExp(`\\$\\([^)]*\\b(?:${DANGEROUS_CMD_KEYWORDS})\\b[^)]*\\)`, 'i'),
    new RegExp('`[^`]*\\b(?:' + DANGEROUS_CMD_KEYWORDS + ')\\b[^`]*`', 'i'),
    /\x00/,
  ];
  return dangerousPatterns.some((p) => p.test(command));
}

/** R28: 工具安全验证 — 在执行前检查安全风险 */
export function validateToolSecurity(toolName: string, args: Record<string, unknown>): string | null {
  const localFileTools = [
    'read_file',
    'write_file',
    'edit_file',
    'list_directory',
    'search_files',
    'delete_file',
    'file_transfer',
  ];
  if (localFileTools.includes(toolName)) {
    const pathFields = ['path', 'source', 'destination', 'file1', 'file2'];
    for (const field of pathFields) {
      if (typeof args[field] === 'string') {
        const val = (args[field] as string).toLowerCase().trim();
        if (val.startsWith('http://') || val.startsWith('https://')) {
          return `参数 "${field}" 是 URL，不是本地路径。请改用 web_fetch 工具读取网页内容: ${args[field]}`;
        }
      }
    }
    if (Array.isArray(args.paths)) {
      const urls = (args.paths as string[]).filter((p) => {
        if (typeof p !== 'string') return false;
        const lower = p.toLowerCase().trim();
        return lower.startsWith('http://') || lower.startsWith('https://');
      });
      if (urls.length > 0) {
        return `paths 数组中包含 ${urls.length} 个 URL，read_file 仅支持本地文件。请改用 web_fetch 工具逐个抓取以下 URL:\n${urls.join('\n')}`;
      }
    }
  }

  const pathFields = ['path', 'source', 'destination', 'file1', 'file2', 'cwd'];
  for (const field of pathFields) {
    if (typeof args[field] === 'string' && hasPathTraversal(args[field] as string)) {
      return `安全警告: 参数 "${field}" 包含可疑的路径遍历模式: ${args[field]}`;
    }
  }

  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === 'string' && hasPathTraversal(p)) {
        return `安全警告: paths 数组中包含可疑的路径遍历模式: ${p}`;
      }
    }
  }

  if (toolName === 'run_command' && typeof args.command === 'string') {
    if (hasCommandInjection(args.command as string)) {
      return `安全警告: 命令中包含潜在的注入模式: ${args.command}`;
    }
  }

  if (typeof args.url === 'string') {
    const url = args.url;
    if (url.toLowerCase().startsWith('file://')) {
      return `安全警告: 不允许 file:// 协议`;
    }
    const internalIpPattern = /^(https?:\/\/)?(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.|localhost)/i;
    if (internalIpPattern.test(url)) {
      logWarn(`R28: 访问内网地址: ${url}`);
    }
  }

  return null;
}

/** R21: 根据 schema 验证工具参数，返回错误消息列表 */
export function validateToolArgs(toolName: string, args: Record<string, unknown>): string[] {
  const def = TOOL_DEFINITIONS.find((d) => d.function.name === toolName);
  if (!def) return [];

  const params = def.function.parameters;
  const errors: string[] = [];

  if (params.required) {
    for (const req of params.required) {
      if (!(req in args) || args[req] === undefined || args[req] === null) {
        errors.push(`缺少必填参数: "${req}"`);
      }
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const prop = params.properties[key];
    if (!prop) continue;

    if (prop.type === 'string' && typeof value !== 'string') {
      errors.push(`参数 "${key}" 应为字符串类型，实际为 ${typeof value}`);
    } else if (prop.type === 'integer' && (!Number.isInteger(Number(value)) || typeof value === 'boolean')) {
      errors.push(`参数 "${key}" 应为整数，实际为 ${JSON.stringify(value)}`);
    } else if (prop.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`参数 "${key}" 应为布尔值，实际为 ${typeof value}`);
    } else if (prop.type === 'array' && !Array.isArray(value)) {
      errors.push(`参数 "${key}" 应为数组，实际为 ${typeof value}`);
    } else if (prop.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      errors.push(`参数 "${key}" 应为对象，实际为 ${typeof value}`);
    }

    if (prop.enum && !prop.enum.includes(String(value))) {
      errors.push(`参数 "${key}" 值 "${value}" 不在允许范围内: ${prop.enum.join(', ')}`);
    }
  }

  return errors;
}

/** R23: 根据工具定义自动转换参数类型 */
export function coerceToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOL_DEFINITIONS.find((d) => d.function.name === toolName);
  if (!def) return args;

  const params = def.function.parameters;
  const coerced = { ...args };

  for (const [key, value] of Object.entries(coerced)) {
    if (value === undefined || value === null) continue;
    const prop = params.properties[key];
    if (!prop) continue;

    if (prop.type === 'integer' && typeof value === 'string') {
      const num = parseInt(value, 10);
      if (!isNaN(num)) coerced[key] = num;
    } else if (prop.type === 'number' && typeof value === 'string') {
      const num = parseFloat(value);
      if (!isNaN(num)) coerced[key] = num;
    } else if (prop.type === 'boolean' && typeof value === 'string') {
      if (value === 'true' || value === '1') coerced[key] = true;
      else if (value === 'false' || value === '0') coerced[key] = false;
    } else if (prop.type === 'array' && typeof value === 'string') {
      try {
        coerced[key] = JSON.parse(value);
      } catch {
        coerced[key] = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } else if (prop.type === 'object' && typeof value === 'string') {
      try {
        coerced[key] = JSON.parse(value);
      } catch {
        // 保持原样
      }
    }
  }

  return coerced;
}

/** R24: 分析工具错误并给出修复建议 */
export function suggestToolFix(toolName: string, args: Record<string, unknown>, error: string): string {
  const err = error.toLowerCase();

  if (
    err.includes('no such file') ||
    err.includes('not found') ||
    err.includes('文件不存在') ||
    err.includes('enoent')
  ) {
    const path = args.path || args.source || args.file1 || '';
    return `文件路径可能不正确: "${path}"。建议：1) 使用 list_directory 检查路径是否存在; 2) 检查拼写; 3) 尝试绝对路径。`;
  }

  if (err.includes('permission denied') || err.includes('eacces') || err.includes('权限')) {
    return `权限不足。建议：1) 检查文件/目录权限; 2) 确认工作空间路径是否正确; 3) 某些系统目录可能需要管理员权限。`;
  }

  if (err.includes('invalid path') || err.includes('illegal characters') || err.includes('路径无效')) {
    const path = args.path || args.destination || '';
    return `路径格式可能不正确: "${path}"。建议：1) 检查特殊字符; 2) Windows 路径使用反斜杠或正斜杠; 3) 确认路径在工作空间内。`;
  }

  if (err.includes('network') || err.includes('timeout') || err.includes('econnrefused') || err.includes('fetch')) {
    return `网络请求失败。建议：1) 检查 URL 是否正确; 2) 确认网络连接; 3) 某些站点可能需要使用 browser action="open" 工具代替 web_fetch。`;
  }

  if (err.includes('json') || err.includes('parse') || err.includes('syntax')) {
    return `数据解析失败。建议：1) 检查 JSON 字符串是否完整、引号与逗号是否合法; 2) 确认参数是有效的 JSON 字符串。`;
  }

  if (err.includes('git') || err.includes('not a repository')) {
    return `Git 操作失败。建议：1) 确认当前目录是 Git 仓库; 2) 使用 git status 检查仓库状态; 3) 检查分支名是否正确。`;
  }

  if (err.includes('command') || err.includes('exit code')) {
    return `命令执行失败。建议：1) 检查命令拼写; 2) 确认命令在当前系统可用; 3) 使用 cwd 参数指定正确的工作目录。`;
  }

  return '';
}
