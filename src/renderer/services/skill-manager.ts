/**
 * SkillManager - 技能自动生成系统 (v4.2)
 * 从成功的工具调用链中提取可复用技能，匹配用户意图后注入上下文
 */

import { state, KEYS } from '../state/state.js';
import { generateId } from '../utils/utils.js';
import { logInfo, logWarn, logSkill } from './log-service.js';
import type { ToolCallRecord, ChatSession } from '../types.js';

/** 技能数据结构 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  trigger_keywords: string | null;
  tool_chain: string; // JSON: ToolChainStep[]
  success_count: number;
  fail_count: number;
  avg_duration_ms: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

/** 工具链步骤 */
interface ToolChainStep {
  name: string;
  description: string; // 该步骤的作用描述
  args_hint: string;   // 参数提示（哪些参数是关键的）
}

/** 最小工具链长度，太短的不算技能 */
const MIN_CHAIN_LENGTH = 2;

/** 技能匹配最低阈值 */
const MATCH_THRESHOLD = 0.3;

/**
 * 从 Agent Loop 完成后的工具调用记录中提取技能
 * 只提取成功的、链长 >= 2 的工具调用序列
 */
export async function extractSkillsFromToolRecords(
  toolRecords: ToolCallRecord[],
  userMessage: string,
  sessionTitle: string
): Promise<number> {
  const bridge = (window as any).metonaDesktop;
  if (!bridge?.db?.saveSkill) return 0;

  // 只看成功的工具调用
  const successfulTools = toolRecords.filter(t => t.status === 'success');
  if (successfulTools.length < MIN_CHAIN_LENGTH) return 0;

  // 提取工具链
  const chain: ToolChainStep[] = successfulTools.map(t => ({
    name: t.name,
    description: describeToolStep(t),
    args_hint: extractKeyArgs(t)
  }));

  const chainNames = chain.map(s => s.name).join(' → ');

  // 检查是否已有完全相同的技能链
  const existingSkills: Skill[] = await bridge.db.getAllSkills();
  const duplicate = existingSkills.find(s => {
    try {
      const existingChain: ToolChainStep[] = JSON.parse(s.tool_chain);
      return existingChain.map((c: ToolChainStep) => c.name).join(' → ') === chainNames;
    } catch { return false; }
  });

  if (duplicate) {
    // 已有相同技能，不重复创建
    logInfo(`技能已存在，跳过提取: ${duplicate.name}`);
    return 0;
  }

  // 从用户消息中提取触发关键词
  const keywords = extractKeywords(userMessage);

  // 生成技能名称和描述
  const name = generateSkillName(chain, userMessage);
  const description = generateSkillDescription(chain, sessionTitle);

  const skill: Skill = {
    id: `skill_${generateId()}`,
    name,
    description,
    trigger_keywords: keywords,
    tool_chain: JSON.stringify(chain),
    success_count: 1,
    fail_count: 0,
    avg_duration_ms: toolRecords.reduce((sum, t) => sum + (t.timestamp - (toolRecords[0]?.timestamp || t.timestamp)), 0),
    created_at: Date.now(),
    updated_at: Date.now(),
    last_used_at: null
  };

  try {
    await bridge.db.saveSkill(skill);
    logSkill(`新技能提取: ${name}`, `链: ${chainNames}`);
    return 1;
  } catch (err) {
    logWarn('技能保存失败', (err as Error).message);
    return 0;
  }
}

/**
 * 匹配用户消息与已有技能
 * 返回匹配度最高的技能列表
 */
export async function matchSkills(userMessage: string, limit = 3): Promise<Skill[]> {
  const bridge = (window as any).metonaDesktop;
  if (!bridge?.db?.getAllSkills) return [];

  try {
    const allSkills: Skill[] = await bridge.db.getAllSkills();
    if (allSkills.length === 0) return [];

    const messageLower = userMessage.toLowerCase();
    const messageWords = new Set(messageLower.split(/[\s,，。！？、；：""''（）\[\]【】]+/).filter(w => w.length > 1));

    const scored = allSkills.map(skill => {
      let score = 0;

      // 关键词匹配
      if (skill.trigger_keywords) {
        const kwSet = new Set(skill.trigger_keywords.toLowerCase().split(',').map(k => k.trim()));
        for (const kw of kwSet) {
          if (kw && messageLower.includes(kw)) score += 0.4;
        }
      }

      // 名称和描述匹配
      const nameWords = skill.name.toLowerCase().split(/[\s→\-]+/);
      for (const w of nameWords) {
        if (w.length > 1 && messageWords.has(w)) score += 0.2;
      }

      // 成功率加成
      const total = skill.success_count + skill.fail_count;
      if (total > 0) score *= (0.5 + 0.5 * (skill.success_count / total));

      return { skill, score };
    });

    return scored
      .filter(s => s.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.skill);
  } catch {
    return [];
  }
}

/**
 * 从匹配的技能构建 system prompt 上下文
 */
export function buildSkillContext(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const parts = skills.map(skill => {
    let chain: ToolChainStep[] = [];
    try { chain = JSON.parse(skill.tool_chain); } catch { return ''; }

    const steps = chain.map((s, i) =>
      `  ${i + 1}. ${s.name}（${s.description}）${s.args_hint ? ` — 参数: ${s.args_hint}` : ''}`
    ).join('\n');

    const total = skill.success_count + skill.fail_count;
    const rate = total > 0 ? Math.round(skill.success_count / total * 100) : 100;

    return `【技能】${skill.name}\n${skill.description}\n成功执行 ${skill.success_count} 次（成功率 ${rate}%）\n工具链：\n${steps}`;
  }).filter(Boolean);

  if (parts.length === 0) return '';

  return `【可用技能提示 — 以下技能曾成功完成过类似任务，可作为参考】\n\n${parts.join('\n\n')}\n\n提示：如果当前任务与某个技能匹配，可以参考其工具链步骤，但根据实际情况调整参数。`;
}

// ── 辅助函数 ──

/** 生成工具步骤描述 */
function describeToolStep(t: ToolCallRecord): string {
  const args = t.arguments || {};
  switch (t.name) {
    case 'read_file': return `读取文件 ${args.path || ''}`;
    case 'write_file': return `写入文件 ${args.path || ''}`;
    case 'list_directory': return `列出目录 ${args.path || ''}`;
    case 'search_files': return `搜索文件 "${args.query || ''}"`;
    case 'web_search': return `联网搜索 "${args.query || ''}"`;
    case 'web_fetch': return `抓取网页 ${args.url || ''}`;
    case 'run_command': return `执行命令 ${String(args.command || '').slice(0, 60)}`;
    case 'git': return `Git ${args.action || ''}`;
    case 'edit_file': return `编辑文件 ${args.path || ''}`;
    case 'delete_file': return `删除 ${args.path || ''}`;
    case 'create_directory': return `创建目录 ${args.path || ''}`;
    case 'memory_search': return `搜索记忆 "${args.query || ''}"`;
    case 'memory_add': return `添加记忆`;
    case 'spawn_task': return `子代理委派`;
    case 'browser_open': return `打开网页 ${args.url || ''}`;
    case 'browser_screenshot': return `浏览器截图`;
    case 'browser_evaluate': return `执行浏览器 JS`;
    case 'browser_extract': return `提取页面内容`;
    case 'browser_click': return `点击元素 ${args.selector || ''}`;
    case 'browser_type': return `输入文本 ${args.selector || ''}`;
    case 'browser_scroll': return `滚动页面`;
    case 'browser_close': return `关闭浏览器`;
    default: return t.name;
  }
}

/** 提取关键参数名 */
function extractKeyArgs(t: ToolCallRecord): string {
  const args = t.arguments || {};
  const keys: string[] = [];
  if (args.path) keys.push('path');
  if (args.query) keys.push('query');
  if (args.url) keys.push('url');
  if (args.command) keys.push('command');
  if (args.action) keys.push('action');
  if (args.branch) keys.push('branch');
  return keys.join(', ');
}

/** 从用户消息提取关键词（简单分词） */
function extractKeywords(text: string): string {
  // 移除常见停用词
  const stopWords = new Set(['我', '你', '的', '了', '是', '在', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '请', '帮', '帮我', '可以', '怎么', '什么', '如何', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'for', 'it', 'with', 'as', 'this', 'from', 'by', 'on', 'not', 'but', 'what', 'all', 'can', 'had', 'how', 'do']);

  const words = text.toLowerCase()
    .split(/[\s,，。！？、；：""''（）\[\]【】<>《》]+/)
    .filter(w => w.length > 1 && !stopWords.has(w));

  // 取前 8 个关键词
  return [...new Set(words)].slice(0, 8).join(',');
}

/** 生成技能名称 */
function generateSkillName(chain: ToolChainStep[], userMessage: string): string {
  const firstTool = chain[0].name;
  const lastTool = chain[chain.length - 1].name;

  // 基于工具链模式命名
  const patterns: Record<string, string> = {
    'web_search → web_fetch': '联网搜索并抓取详情',
    'list_directory → read_file': '浏览目录并读取文件',
    'search_files → read_file': '搜索并读取文件',
    'search_files → edit_file': '搜索并编辑文件',
    'search_files → write_file': '搜索并写入文件',
    'run_command → read_file': '执行命令并读取输出',
    'web_search → web_fetch → write_file': '搜索、抓取并保存',
  };

  const chainKey = chain.map(s => s.name).join(' → ');
  if (patterns[chainKey]) return patterns[chainKey];

  // 基于用户消息前 20 字
  const msgPreview = userMessage.slice(0, 20).replace(/[\r\n]/g, ' ');
  return `${firstTool} → ... → ${lastTool}（${msgPreview}）`;
}

/** 生成技能描述 */
function generateSkillDescription(chain: ToolChainStep[], sessionTitle: string): string {
  const steps = chain.map((s, i) => `${i + 1}. ${s.description}`).join('；');
  return `从会话「${sessionTitle}」中提取。步骤：${steps}`;
}
