/**
 * Agent 提示词构建：注入清洗、系统环境、行为文件（SOUL.md / AGENTS.md）与 USER.md。
 */

import { state } from '../../state/state.js';
import { logInfo } from '../log-service.js';
import { estimateTokens } from '../context-manager.js';

/** S1/S6: 清洗不可信文本，移除提示词注入模式 */
export function sanitizeUntrustedInput(text: string): string {
  if (!text) return '';
  const normalized = text
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  return normalized
    .replace(/ignore\s+(all\s+)?(previous|prior|above)\s*(instructions?|prompts?|rules?)?/gi, '...')
    .replace(/forget\s+(all\s+)?(instructions?|prompts?|rules?|everything)/gi, '...')
    .replace(/you\s+are\s+now\s+a/gi, '...')
    .replace(/new\s+system\s*prompt/gi, '...')
    .replace(/override\s+(your|the|all)\s+/gi, '...')
    .replace(/disregard\s+(all|any|previous|prior)\s*(instructions?|rules?)?/gi, '...')
    .replace(/act\s+as\s+(if|a|an)\s+(you\s+are|different)/gi, '...')
    .replace(/忽略.{0,4}(之前|前面|以上|所有).{0,4}(指令|提示|规则|系统)/g, '...')
    .replace(/忘记.{0,4}(所有|之前|前面).{0,4}(指令|提示|规则)/g, '...')
    .replace(/你现在是一个/g, '...')
    .replace(/覆盖.{0,4}(系统|你的).{0,4}(提示|指令|规则)/g, '...')
    .replace(/从现在起.{0,4}(你是|你将|请)/g, '...')
    .replace(/system\s*:\s*/gi, '...')
    .replace(/\[system\]/gi, '...');
}

export function getThinkLevel(): false | 'low' | 'medium' | 'high' | 'max' {
  const level = state.get<string>('thinkLevel', 'off');
  if (level === 'low' || level === 'medium' || level === 'high' || level === 'max') return level;
  return false;
}

function getOSEnvironment() {
  const isWin = navigator.platform?.toLowerCase().includes('win') || false;
  const isMac = navigator.platform?.toLowerCase().includes('mac') || false;
  const bridge = window.metonaDesktop;
  const isDesktop = bridge?.isDesktop || false;

  const sys = bridge?.sys;
  const realHomeDir = sys?.homeDir || '';
  const realShell = sys?.shell || '';
  const realArch = sys?.arch || navigator.platform || 'unknown';
  const realUser = sys?.username || '';

  return {
    os: isWin ? 'Windows' : isMac ? 'macOS' : 'Linux',
    platform: isDesktop ? 'Electron Desktop' : 'Browser',
    arch: realArch,
    shell: realShell || (isWin ? 'cmd.exe / PowerShell' : 'bash'),
    homeDir: realHomeDir || (isWin ? 'C:\\Users\\<用户名>' : '/home/<用户名>'),
    username: realUser,
    lineEnding: isWin ? 'CRLF (\\r\\n)' : 'LF (\\n)',
    pathSep: isWin ? '\\ (反斜杠)' : '/ (正斜杠)',
  };
}

export function truncateByTokenBudget(text: string, maxTokens: number): string {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;
  const ratio = maxTokens / estimated;
  const cutAt = Math.floor(text.length * ratio * 0.9);
  return text.slice(0, cutAt) + '\n\n... (已截断以控制 Token 预算)';
}

async function readBuiltinResource(name: string): Promise<string> {
  const bridge = window.metonaDesktop;
  if (bridge?.readAppResource) {
    try {
      const r = await bridge.readAppResource(name);
      if (r?.success && r.content) return r.content;
    } catch {
      /* ignore */
    }
    return '';
  }
  try {
    const resp = await fetch('./' + name);
    if (resp.ok) return await resp.text();
  } catch {
    /* ignore */
  }
  return '';
}

/** 行为文件 Token 预算：合并后统一限制，避免自定义文件挤占上下文 */
const BEHAVIOR_FILE_MAX_TOKENS = 3000;

interface BehaviorFile {
  label: 'SOUL.md' | 'AGENTS.md';
  content: string;
}

async function readWorkspaceTextFile(
  workspaceDir: string,
  name: string,
): Promise<{ content: string; lines?: number } | null> {
  if (!workspaceDir) return null;
  try {
    const r = await window.metonaDesktop?.workspace.readFile(workspaceDir.replace(/[\\/]+$/, '') + '/' + name);
    if (r?.success && r.content) return { content: r.content, lines: r.lines };
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 行为文件只加载一份，优先级：
 * 1. 工作空间 SOUL.md
 * 2. 工作空间 AGENTS.md
 * 3. 内置 SOUL.md（已合并原 AGENT.md 的身份、行为与工具规则）
 */
async function loadBehaviorFile(workspaceDir: string): Promise<BehaviorFile | null> {
  const workspaceSoul = await readWorkspaceTextFile(workspaceDir, 'SOUL.md');
  if (workspaceSoul) {
    logInfo('SOUL.md 已从工作空间加载', `${workspaceSoul.lines || 0} 行`);
    return { label: 'SOUL.md', content: workspaceSoul.content };
  }

  const workspaceAgents = await readWorkspaceTextFile(workspaceDir, 'AGENTS.md');
  if (workspaceAgents) {
    logInfo('AGENTS.md 已从工作空间加载', `${workspaceAgents.lines || 0} 行`);
    return { label: 'AGENTS.md', content: workspaceAgents.content };
  }

  const builtinSoul = await readBuiltinResource('SOUL.md');
  if (builtinSoul) {
    logInfo('SOUL.md 已从内置加载', `${builtinSoul.length} 字符`);
    return { label: 'SOUL.md', content: builtinSoul };
  }

  return null;
}

export async function loadCustomFiles(workspaceDir: string, systemPromptParts: string[]): Promise<void> {
  const behavior = await loadBehaviorFile(workspaceDir);
  if (behavior) {
    const content = truncateByTokenBudget(sanitizeUntrustedInput(behavior.content), BEHAVIOR_FILE_MAX_TOKENS);
    systemPromptParts.unshift(`[${behavior.label}]\n${content}`);
  }

  const userProfile = await readWorkspaceTextFile(workspaceDir, 'USER.md');
  if (userProfile) {
    systemPromptParts.push(`[USER.md]\n${sanitizeUntrustedInput(userProfile.content)}`);
    logInfo('USER.md 已从工作空间加载', `${userProfile.lines || 0} 行`);
  }
}

export function buildStandardPrompts(): string[] {
  const parts: string[] = [];
  const osInfo = getOSEnvironment();
  parts.push(`[环境] 运行环境信息
操作系统: ${osInfo.os}
平台: ${osInfo.platform}
架构: ${osInfo.arch}
Shell: ${osInfo.shell}
用户目录: ${osInfo.homeDir}
换行符: ${osInfo.lineEnding}
路径分隔符: ${osInfo.pathSep}
⚠️ 命令语法必须匹配当前OS（${osInfo.os}），跨平台命令会失败。`);

  const now = new Date();
  parts.push(`[日期] ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（系统时钟，以此为准）`);
  return parts;
}
