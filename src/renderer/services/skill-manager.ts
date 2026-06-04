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
  /** Level 0 简短摘要（~100 tokens），用于索引展示 */
  summary: string;
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
  const bridge = window.metonaDesktop;
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
  const existingSkills = await bridge.db.getAllSkills() as Skill[];
  const duplicate = existingSkills.find(s => {
    try {
      const existingChain: ToolChainStep[] = JSON.parse(s.tool_chain);
      return existingChain.map((c: ToolChainStep) => c.name).join(' → ') === chainNames;
    } catch { return false; }
  });

  if (duplicate) {
    // v1.1: 重复链 → 更新参数提示（合并新知）+ 增加计数
    try {
      const existingChain: ToolChainStep[] = JSON.parse(duplicate.tool_chain);
      let updated = false;
      for (let i = 0; i < Math.min(chain.length, existingChain.length); i++) {
        const newArgs = chain[i].args_hint.split(',').map(a => a.trim()).filter(Boolean);
        const oldArgs = existingChain[i].args_hint.split(',').map(a => a.trim()).filter(Boolean);
        const merged = [...new Set([...oldArgs, ...newArgs])];
        const mergedHint = merged.join(', ');
        if (mergedHint !== existingChain[i].args_hint) {
          existingChain[i].args_hint = mergedHint;
          updated = true;
        }
      }
      if (updated) {
        duplicate.tool_chain = JSON.stringify(existingChain);
        duplicate.success_count++;
        duplicate.updated_at = Date.now();
        await bridge.db.saveSkill(duplicate);
        logInfo(`技能参数优化: ${duplicate.name}`, `合并了新的参数提示`);
        return 1;
      }
    } catch { /* 更新失败不阻塞 */ }
    logInfo(`技能已存在，跳过提取: ${duplicate.name}`);
    return 0;
  }

  // 从用户消息中提取触发关键词
  const keywords = extractKeywords(userMessage);

  // 生成技能名称和描述
  const name = generateSkillName(chain, userMessage);
  const description = generateSkillDescription(chain, sessionTitle);

  const summary = generateSkillSummary(chain, userMessage);

  const skill: Skill = {
    id: `skill_${generateId()}`,
    name,
    description,
    summary,
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
 * 匹配用户消息与已有技能。
 * v1.1: 关键词 + 语义匹配融合，未使用技能衰减。
 */
export async function matchSkills(userMessage: string, limit = 3): Promise<Skill[]> {
  const bridge = window.metonaDesktop;
  if (!bridge?.db?.getAllSkills) return [];

  try {
    const allSkills = await bridge.db.getAllSkills() as any as Skill[];
    if (allSkills.length === 0) return [];

    const messageLower = userMessage.toLowerCase();
    const messageWords = new Set(messageLower.split(/[\s,，。！？、；：""''（）\[\]【】]+/).filter(w => w.length > 1));

    // ── 语义匹配（如果 embedding 模型可用）──
    let userEmbedding: number[] | null = null;
    try {
      const memEnabled = state.get<boolean>('memoryEnabled', false);
      const embedModel = state.get<string>('embeddingModel', '');
      if (memEnabled && embedModel) {
        const api = state.get<any>(KEYS.API);
        if (api?.embed) {
          const result = await api.embed(embedModel, userMessage);
          userEmbedding = result.embedding || result.embeddings?.[0] || null;
        }
      }
    } catch { /* 语义匹配失败回退关键词 */ }

    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

    const scored = allSkills.map(skill => {
      let score = 0;

      // 关键词匹配
      if (skill.trigger_keywords) {
        const kwSet = new Set(skill.trigger_keywords.toLowerCase().split(',').map(k => k.trim()));
        for (const kw of kwSet) {
          if (kw && messageLower.includes(kw)) score += 0.3;
        }
      }

      // 名称和描述匹配
      const nameWords = skill.name.toLowerCase().split(/[\s→\-]+/);
      for (const w of nameWords) {
        if (w.length > 1 && messageWords.has(w)) score += 0.15;
      }

      // 语义匹配：余弦相似度加权（主导分数）
      if (userEmbedding && skill.summary) {
        const skillEmbed = getCachedSkillEmbedding(skill.id);
        if (skillEmbed) {
          const sim = cosineSimilarity(userEmbedding, skillEmbed);
          score += sim * 0.4; // 语义匹配主导
        }
      }

      // 成功率加权
      const total = skill.success_count + skill.fail_count;
      if (total > 0) score *= (0.5 + 0.5 * (skill.success_count / total));

      // ── v1.1 未使用技能衰减 ──
      if (skill.last_used_at) {
        const daysSinceUse = (now - skill.last_used_at) / (24 * 3600 * 1000);
        if (daysSinceUse > 30) score *= 0.5;  // 30天未用降权50%
        if (daysSinceUse > 90) score *= 0.3;  // 90天未用几乎忽略
      }

      return { skill, score };
    });

    // ── v1.1 技能链合并：相同前缀的链抽象为一个技能 ──
    const merged = mergeSimilarSkills(scored);

    return merged
      .filter(s => s.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.skill);
  } catch {
    return [];
  }
}

// ── 向量计算工具 ──

/** 技能 embedding 缓存（LRU 简单实现） */
const _skillEmbedCache = new Map<string, { embedding: number[]; time: number }>();

function getCachedSkillEmbedding(skillId: string): number[] | null {
  const cached = _skillEmbedCache.get(skillId);
  if (cached && Date.now() - cached.time < 300_000) return cached.embedding; // 5分钟有效
  return null;
}

export function cacheSkillEmbedding(skillId: string, embedding: number[]): void {
  _skillEmbedCache.set(skillId, { embedding, time: Date.now() });
  // 限制缓存大小
  if (_skillEmbedCache.size > 200) {
    const oldest = [..._skillEmbedCache.entries()].sort((a, b) => a[1].time - b[1].time)[0];
    if (oldest) _skillEmbedCache.delete(oldest[0]);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── 技能链合并 ──

interface ScoredSkill { skill: Skill; score: number; }

/**
 * v1.1 技能链合并：两个以上技能有相同前缀（前 2 步相同），
 * 合并为一个抽象技能，分数取最高。
 */
function mergeSimilarSkills(scored: ScoredSkill[]): ScoredSkill[] {
  if (scored.length < 2) return scored;

  const result: ScoredSkill[] = [];
  const used = new Set<number>();

  for (let i = 0; i < scored.length; i++) {
    if (used.has(i)) continue;
    const group: ScoredSkill[] = [scored[i]];

    // 找同前缀的
    for (let j = i + 1; j < scored.length; j++) {
      if (used.has(j)) continue;
      if (getChainPrefix(scored[i].skill) === getChainPrefix(scored[j].skill)) {
        group.push(scored[j]);
        used.add(j);
      }
    }

    if (group.length >= 2) {
      // 合并为一个抽象技能
      const best = group.reduce((a, b) => a.score > b.score ? a : b);
      const chainNames = group.map(g => {
        try { return (JSON.parse(g.skill.tool_chain) as ToolChainStep[]).map(s => s.name).join('→'); }
        catch { return g.skill.name; }
      });
      const mergedSkill: Skill = {
        ...best.skill,
        name: `${getChainPrefix(best.skill)} → ...`,
        description: `合并了 ${group.length} 个相似技能: ${chainNames.join(' | ')}`,
        summary: best.skill.summary,
      };
      result.push({ skill: mergedSkill, score: best.score * 1.1 }); // 合并后略加分
      used.add(i);
    } else {
      result.push(scored[i]);
    }
  }

  return result;
}

/** 获取技能链的前 2 步前缀（用于相似度判断） */
function getChainPrefix(skill: Skill): string {
  try {
    const chain: ToolChainStep[] = JSON.parse(skill.tool_chain);
    return chain.slice(0, 2).map(s => s.name).join('→');
  } catch {
    return skill.name;
  }
}

/**
 * 从匹配的技能构建 system prompt 上下文（Level 0：仅名称 + 描述索引）
 * 完整工具链通过 skill_view 工具按需加载（Level 1）
 */
export function buildSkillContext(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const parts = skills.map(skill => {
    const total = skill.success_count + skill.fail_count;
    const rate = total > 0 ? Math.round(skill.success_count / total * 100) : 100;
    return `• ${skill.name} — ${skill.description}（成功率 ${rate}%）`;
  }).filter(Boolean);

  if (parts.length === 0) return '';

  return `【可用技能 — 以下技能曾成功完成过类似任务】\n${parts.join('\n')}\n\n提示：使用 skill_view 工具查看某个技能的完整工具链和参数提示。`;
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

/** 生成技能简短摘要（Level 0，~100 tokens） */
function generateSkillSummary(chain: ToolChainStep[], userMessage: string): string {
  const toolNames = chain.map(s => s.name).join(' → ');
  const msgPreview = userMessage.slice(0, 30).replace(/[\r\n]/g, ' ');
  return `工具链: ${toolNames}。场景: ${msgPreview}`;
}

// ── 渐进式技能加载 ──

/** 列出所有技能（渐进式 Level 0：只返回名称、描述摘要、成功率） */
export async function listSkills(): Promise<Array<{
  name: string;
  description: string;
  summary: string;
  success_rate: string;
  chain_preview: string;
}>> {
  const bridge = window.metonaDesktop;
  if (!bridge?.db?.getAllSkills) return [];
  const allSkills: Skill[] = await bridge.db.getAllSkills() as any;
  return (allSkills as any[]).map((skill: any) => {
    const total = skill.success_count + skill.fail_count;
    const rate = total > 0 ? Math.round(skill.success_count / total * 100) : 100;
    let chainPreview = '';
    try {
      const chain: ToolChainStep[] = JSON.parse(skill.tool_chain);
      chainPreview = chain.map(s => s.name).join(' → ');
    } catch { /* */ }
    return {
      name: skill.name,
      description: skill.description,
      summary: skill.summary || skill.description,
      success_rate: `${rate}%`,
      chain_preview: chainPreview
    };
  });
}

/** 查看技能详情（渐进式 Level 1：返回完整工具链和参数提示） */
export async function viewSkill(skillName: string): Promise<{
  success: boolean;
  skill?: Skill & { chain: ToolChainStep[]; success_rate: string };
  error?: string;
}> {
  const bridge = window.metonaDesktop;
  if (!bridge?.db?.getAllSkills) return { success: false, error: '数据库不可用' };
  const allSkills: Skill[] = await bridge.db.getAllSkills() as any;
  const skill = allSkills.find(s =>
    s.name.toLowerCase() === skillName.toLowerCase() ||
    s.name.toLowerCase().includes(skillName.toLowerCase())
  );
  if (!skill) return { success: false, error: `未找到技能: ${skillName}` };
  let chain: ToolChainStep[] = [];
  try { chain = JSON.parse(skill.tool_chain); } catch { /* */ }
  const total = skill.success_count + skill.fail_count;
  const rate = total > 0 ? Math.round(skill.success_count / total * 100) : 100;
  return {
    success: true,
    skill: { ...skill, chain, success_rate: `${rate}%` }
  };
}
