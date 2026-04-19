/**
 * MemoryManager - Agent 记忆系统（长效向量记忆）
 * 自动提取 → 存储 → 检索 → 注入上下文
 *
 * 记忆类型：
 * - fact: 用户告诉我的事实（项目信息、个人背景等）
 * - preference: 用户偏好（语言、风格、格式习惯）
 * - rule: 应遵守的规则（命名规范、输出格式要求）
 */

import { state, KEYS } from '../state/state.js';
import { generateId } from '../utils/utils.js';
import {
  initMemoryVectorStore, getOrCreateMemoryCollection,
  embedMemoryEntry, addMemoryVector, updateMemoryVector,
  deleteMemoryVector, searchMemoriesByVector, reindexAllMemories,
  getMemoryCollectionId
} from './vector-memory.js';
import { logMemory, logDebug, logWarn } from './log-service.js';
import type { MemoryEntry, MemorySearchResult, MemoryExtractionResult, ChatDB, OllamaAPI } from '../types.js';

const TYPE_ICONS: Record<string, string> = {
  fact: '📌',
  preference: '⚙️',
  rule: '📏'
};

const TYPE_NAMES: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  rule: '规则'
};

let memoryCache: MemoryEntry[] = [];
let memoryEnabled = true;
let embeddingModel = '';

// ── 初始化 ──

export async function initMemoryManager(): Promise<void> {
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (!db) return;

  memoryEnabled = await db.getSetting('memoryEnabled', true);
  state.set('memoryEnabled', memoryEnabled);

  // 加载嵌入模型设置
  embeddingModel = await db.getSetting('embeddingModel', '');
  state.set('embeddingModel', embeddingModel);

  memoryCache = await db.getAllMemories();
  state.set('memoryEntries', memoryCache);

  // 如果有嵌入模型，初始化向量存储
  if (embeddingModel) {
    try {
      await initMemoryVectorStore();
      logMemory('向量存储已初始化');
    } catch (err) {
      logWarn('向量存储初始化失败', (err as Error).message);
    }
  }

  logMemory(`初始化完成, 加载 ${memoryCache.length} 条${embeddingModel ? ', 向量记忆已启用' : ', 仅关键词模式'}`);
}

// ── 嵌入模型管理 ──

export function getEmbeddingModel(): string {
  return embeddingModel;
}

export async function setEmbeddingModel(model: string): Promise<void> {
  const oldModel = embeddingModel;
  embeddingModel = model;
  state.set('embeddingModel', model);

  const db = state.get<ChatDB | null>(KEYS.DB);
  if (db) await db.saveSetting('embeddingModel', model);

  if (model && model !== oldModel) {
    // 嵌入模型变化，重新索引所有记忆
    logMemory(`嵌入模型变更: ${oldModel || '(无)'} → ${model}`);
    await reindexMemories();
  }
}

export function isVectorMemoryEnabled(): boolean {
  return !!embeddingModel;
}

// ── 重新索引所有记忆 ──

export async function reindexMemories(): Promise<void> {
  if (!embeddingModel || memoryCache.length === 0) return;

  try {
    await initMemoryVectorStore();
    const { id: colId } = await getOrCreateMemoryCollection(embeddingModel);
    await reindexAllMemories(memoryCache, embeddingModel, colId, (done, total) => {
      logMemory(`重新索引进度: ${done}/${total}`);
    });
    logMemory('向量索引重建完成');
  } catch (err) {
    logWarn('向量索引重建失败', (err as Error).message);
  }
}

// ── 基础管理 ──

export function isMemoryEnabled(): boolean {
  return memoryEnabled;
}

export function setMemoryEnabled(enabled: boolean): void {
  memoryEnabled = enabled;
  state.set('memoryEnabled', enabled);
  const db = state.get<ChatDB | null>(KEYS.DB);
  if (db) db.saveSetting('memoryEnabled', enabled);
}

export function getMemoryCache(): MemoryEntry[] {
  return memoryCache;
}

export function getTypeIcon(type: string): string {
  return TYPE_ICONS[type] || '📌';
}

export function getTypeName(type: string): string {
  return TYPE_NAMES[type] || type;
}

// ── 记忆检索（向量优先，关键词补充）──

export function searchMemories(query: string, limit = 8): MemorySearchResult[] {
  if (!memoryEnabled || memoryCache.length === 0) return [];

  // 始终执行关键词搜索（即时结果）
  const keywordResults = searchMemoriesByKeyword(query, limit);

  // 如果启用了向量记忆，异步触发向量搜索（结果在下次调用时更新）
  if (embeddingModel) {
    triggerVectorSearch(query, limit);
  }

  return keywordResults;
}

// 向量搜索异步缓存
const vectorSearchCache = new Map<string, MemorySearchResult[]>();
let vectorSearchTimer: ReturnType<typeof setTimeout> | null = null;

function triggerVectorSearch(query: string, limit: number): void {
  if (vectorSearchTimer) clearTimeout(vectorSearchTimer);
  vectorSearchTimer = setTimeout(async () => {
    try {
      const colId = getMemoryCollectionId();
      if (!colId) return;
      const results = await searchMemoriesByVector(query, colId, limit);
      const memoryResults: MemorySearchResult[] = results.map(r => {
        const entry = memoryCache.find(e => e.id === r.docId);
        if (!entry) return null;
        return { ...entry, score: r.score };
      }).filter(Boolean) as MemorySearchResult[];
      vectorSearchCache.set(query, memoryResults);
    } catch (err) {
      logWarn('向量搜索失败', (err as Error).message);
    }
  }, 100);
}


// 关键词搜索
function searchMemoriesByKeyword(query: string, limit: number): MemorySearchResult[] {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/[\s,，。！？、；：""''（）\[\]{}<>`~@#$%^&*+=|\\/.]+/).filter(w => w.length > 1);

  // rule 和 preference 类型的记忆全局生效，始终注入
  const alwaysInclude: MemorySearchResult[] = [];
  const scored: MemorySearchResult[] = [];

  for (const entry of memoryCache) {
    if (entry.type === 'rule' || entry.type === 'preference') {
      // 规则和偏好：始终包含，按重要性排序
      alwaysInclude.push({ ...entry, score: 100 + entry.importance });
      continue;
    }

    // fact 类型：按关键词匹配
    let score = 0;
    const contentLower = entry.content.toLowerCase();
    const tagsLower = entry.tags.map(t => t.toLowerCase());

    // 完全匹配内容
    if (contentLower.includes(queryLower)) score += 50;

    // 标签匹配
    for (const tag of tagsLower) {
      if (queryLower.includes(tag) || tag.includes(queryLower)) score += 30;
      for (const word of queryWords) {
        if (tag.includes(word)) score += 15;
      }
    }

    // 关键词匹配
    for (const word of queryWords) {
      if (contentLower.includes(word)) score += 10;
    }

    // 重要性加权
    score *= (0.5 + entry.importance / 20);

    // 最近使用加权（7 天内使用过 +20%）
    const daysSinceUse = (Date.now() - entry.lastUsedAt) / (1000 * 60 * 60 * 24);
    if (daysSinceUse < 7) score *= 1.2;

    // 使用频率加权
    score *= (1 + Math.min(entry.useCount, 10) / 50);

    if (score > 0) {
      scored.push({ ...entry, score });
    }
  }

  // 合并：全局规则/偏好 + 关键词匹配的事实，去重后按分数排序
  const seen = new Set<string>();
  const merged: MemorySearchResult[] = [];
  for (const item of [...alwaysInclude, ...scored.sort((a, b) => b.score - a.score)]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }

  return merged.slice(0, limit);
}

// ── 记忆添加 ──

export async function addMemory(data: {
  type: MemoryEntry['type'];
  content: string;
  importance?: number;
  tags?: string[];
  source?: string;
  sessionId?: string;
}): Promise<MemoryEntry> {
  const db = state.get<ChatDB | null>(KEYS.DB);

  // 自动提取来源禁止添加 rule 类型
  if (data.type === 'rule' && data.source === '自动提取') {
    logWarn('记忆提取拦截', '自动提取不允许创建规则类型，规则只能由用户手动添加');
    throw new Error('规则类型记忆只能由用户手动添加');
  }

  // 安全扫描：检测 prompt injection 和敏感信息
  const securityCheck = scanMemorySecurity(data.content);
  if (!securityCheck.safe) {
    logWarn('记忆安全扫描拦截', securityCheck.reason);
    throw new Error(`记忆内容被安全规则拦截: ${securityCheck.reason}`);
  }

  // v5.1.2 记忆容量限制：超过上限自动清理低价值条目
  const MAX_MEMORIES = 500;
  if (memoryCache.length >= MAX_MEMORIES) {
    const evicted = autoCleanMemories();
    if (evicted > 0) {
      logInfo('记忆容量清理', `已清理 ${evicted} 条低价值记忆（上限 ${MAX_MEMORIES}）`);
    }
  }

  // 检查重复（内容相似度 > 80% 或前缀匹配则跳过）
  const existing = memoryCache.find(e => {
    if (e.type !== data.type) return false;
    // v5.1.3 前缀匹配：前 50 字符完全相同视为重复
    const prefixLen = Math.min(50, data.content.length, e.content.length);
    if (prefixLen > 20 && data.content.slice(0, prefixLen) === e.content.slice(0, prefixLen)) {
      return true;
    }
    const similarity = simpleSimilarity(e.content, data.content);
    return similarity > 0.8;
  });
  if (existing) return existing;

  const entry: MemoryEntry = {
    id: `mem_${generateId()}`,
    type: data.type,
    content: data.content.trim(),
    importance: data.importance ?? 5,
    tags: data.tags || extractTags(data.content),
    source: data.source,
    sessionId: data.sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsedAt: Date.now(),
    useCount: 0
  };

  memoryCache.push(entry);
  state.set('memoryEntries', [...memoryCache]);

  if (db) await db.saveMemory(entry);
  logMemory(`新增: ${data.type}`, entry.content.slice(0, 60));

  // 向量存储
  if (embeddingModel) {
    try {
      await initMemoryVectorStore();
      const colId = getMemoryCollectionId() || (await getOrCreateMemoryCollection(embeddingModel)).id;
      const embedding = await embedMemoryEntry(entry, embeddingModel);
      entry.embedding = embedding;
      await addMemoryVector(entry, embedding, colId);
      if (db) await db.saveMemory(entry); // 保存包含 embedding 的版本
    } catch (err) {
      const errMsg = (err as Error).message;
      logWarn('向量存储失败', `记忆 "${entry.content.slice(0, 40)}" (${entry.id}): ${errMsg}`);
      logDebug('向量存储失败详情', `模型: ${embeddingModel}, 类型: ${entry.type}, 错误: ${(err as Error).stack?.split('\n')[0] || errMsg}`);
    }
  }

  return entry;
}

// ── 容量管理 ──

/**
 * 自动清理低价值记忆条目
 * 策略：按综合评分排序，清理后 20% 的条目
 * 评分 = importance * 2 + useCount * 3 + recencyBonus（最近 7 天使用过 +5）
 * rule 类型记忆受保护不被清理
 * @returns 清理的条目数
 */
function autoCleanMemories(): number {
  const db = state.get<ChatDB | null>(KEYS.DB);
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 3600 * 1000;
  const NINETY_DAYS = 90 * 24 * 3600 * 1000;

  // v5.1.3 记忆过期衰减：90 天未使用的记忆自动降级 importance
  for (const entry of memoryCache) {
    if (entry.type === 'rule') continue; // rule 受保护
    const unusedDays = now - entry.lastUsedAt;
    if (unusedDays > NINETY_DAYS && entry.importance > 1) {
      entry.importance = Math.max(1, entry.importance - 2);
      if (db) db.saveMemory(entry);
    }
  }

  // 计算综合评分
  const scored = memoryCache
    .map((entry) => {
      const recencyBonus = (now - entry.lastUsedAt) < SEVEN_DAYS ? 5 : 0;
      const agePenalty = (now - entry.createdAt) > NINETY_DAYS ? 3 : 0;
      const score = entry.importance * 2 + entry.useCount * 3 + recencyBonus - agePenalty;
      return { entry, score };
    })
    // rule 类型受保护
    .filter(s => s.entry.type !== 'rule')
    .sort((a, b) => a.score - b.score);

  const evictCount = Math.max(1, Math.floor(memoryCache.length * 0.2));
  const toEvict = scored.slice(0, evictCount);

  // 从缓存和数据库中移除
  const evictIds = new Set(toEvict.map(s => s.entry.id));
  for (const id of evictIds) {
    if (db) db.deleteMemory(id);
  }
  memoryCache = memoryCache.filter(e => !evictIds.has(e.id));
  state.set('memoryEntries', [...memoryCache]);

  return evictIds.size;
}

// ── 安全扫描 ──

/** 记忆内容安全扫描 */
function scanMemorySecurity(content: string): { safe: boolean; reason: string } {
  // Prompt injection 模式
  const injectionPatterns = [
    /ignore\s+(all\s+)?previous/i,
    /forget\s+(all\s+)?instructions/i,
    /you\s+are\s+now\s+a/i,
    /new\s+system\s*prompt/i,
    /override\s+(your|the)\s+/i,
    /disregard\s+(all|any|previous)/i,
  ];
  for (const p of injectionPatterns) {
    if (p.test(content)) return { safe: false, reason: '疑似 prompt injection 攻击' };
  }

  // 敏感信息模式
  const secretPatterns = [
    /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
    /sk-[a-zA-Z0-9]{20,}/,
    /ghp_[a-zA-Z0-9]{36}/,
    /AKIA[A-Z0-9]{16}/,
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,  // 信用卡号
  ];
  for (const p of secretPatterns) {
    if (p.test(content)) return { safe: false, reason: '疑似包含敏感信息（密钥/密码/信用卡号）' };
  }

  // 不可见字符
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/.test(content)) {
    return { safe: false, reason: '包含不可见 Unicode 字符' };
  }

  return { safe: true, reason: '' };
}

// ── 记忆替换（根据 old_text 子串匹配）──

export async function replaceMemoryByContent(
  target: 'memory' | 'user',
  oldText: string,
  newContent: string
): Promise<{ success: boolean; message: string }> {
  if (!oldText || oldText.length < 2) {
    return { success: false, message: 'old_text 不能为空且至少 2 个字符' };
  }
  if (!newContent || newContent.length < 2) {
    return { success: false, message: 'new_content 不能为空且至少 2 个字符' };
  }

  // 安全扫描
  const securityCheck = scanMemorySecurity(newContent);
  if (!securityCheck.safe) {
    return { success: false, message: `新内容被安全规则拦截: ${securityCheck.reason}` };
  }

  // 匹配
  const matches = memoryCache.filter(e => {
    if (target === 'user') {
      return (e.type === 'preference' || e.type === 'fact') && e.content.includes(oldText);
    }
    return e.content.includes(oldText);
  });

  if (matches.length === 0) {
    return { success: false, message: `未找到包含 "${oldText.slice(0, 50)}" 的记忆` };
  }
  if (matches.length > 1) {
    return { success: false, message: `匹配到 ${matches.length} 条记忆，请使用更精确的 old_text` };
  }

  await updateMemory(matches[0].id, { content: newContent.trim() });
  logMemory('替换记忆', `${matches[0].id}: ${oldText.slice(0, 30)} → ${newContent.slice(0, 30)}`);
  return { success: true, message: `已替换记忆: ${matches[0].id}` };
}

// ── 记忆删除（根据 old_text 子串匹配）──

export async function removeMemoryByContent(
  target: 'memory' | 'user',
  oldText: string
): Promise<{ success: boolean; message: string }> {
  if (!oldText || oldText.length < 2) {
    return { success: false, message: 'old_text 不能为空且至少 2 个字符' };
  }

  const matches = memoryCache.filter(e => {
    if (target === 'user') {
      return (e.type === 'preference' || e.type === 'fact') && e.content.includes(oldText);
    }
    return e.content.includes(oldText);
  });

  if (matches.length === 0) {
    return { success: false, message: `未找到包含 "${oldText.slice(0, 50)}" 的记忆` };
  }
  if (matches.length > 1) {
    return { success: false, message: `匹配到 ${matches.length} 条记忆，请使用更精确的 old_text` };
  }

  await deleteMemory(matches[0].id);
  logMemory('删除记忆', `${matches[0].id}: ${oldText.slice(0, 50)}`);
  return { success: true, message: `已删除记忆: ${matches[0].id}` };
}

// ── 记忆更新 ──

export async function updateMemory(id: string, updates: Partial<MemoryEntry>): Promise<void> {
  const idx = memoryCache.findIndex(e => e.id === id);
  if (idx === -1) return;

  memoryCache[idx] = { ...memoryCache[idx], ...updates, updatedAt: Date.now() };
  state.set('memoryEntries', [...memoryCache]);

  const db = state.get<ChatDB | null>(KEYS.DB);
  if (db) await db.saveMemory(memoryCache[idx]);

  // 更新向量
  if (embeddingModel && (updates.content || updates.type || updates.tags)) {
    try {
      const colId = getMemoryCollectionId();
      if (colId) {
        const embedding = await embedMemoryEntry(memoryCache[idx], embeddingModel);
        memoryCache[idx].embedding = embedding;
        await updateMemoryVector(memoryCache[idx], embedding, colId);
        if (db) await db.saveMemory(memoryCache[idx]);
      }
    } catch (err) {
      logWarn('向量更新失败', (err as Error).message);
    }
  }
}

// ── 记忆删除 ──

export async function deleteMemory(id: string): Promise<void> {
  memoryCache = memoryCache.filter(e => e.id !== id);
  state.set('memoryEntries', [...memoryCache]);

  const db = state.get<ChatDB | null>(KEYS.DB);
  if (db) await db.deleteMemory(id);

  // 删除向量
  if (embeddingModel) {
    try {
      const colId = getMemoryCollectionId();
      if (colId) await deleteMemoryVector(id, colId);
    } catch (err) {
      logWarn('向量删除失败', (err as Error).message);
    }
  }

  logMemory(`删除`, id);
}

// ── 清空所有记忆 ──

export async function clearAllMemories(): Promise<void> {
  memoryCache = [];
  state.set('memoryEntries', []);

  const db = state.get<ChatDB | null>(KEYS.DB);
  if (db) await db.clearAllMemories();

  // 清空向量集合
  if (embeddingModel) {
    try {
      await initMemoryVectorStore();
      const { id: colId } = await getOrCreateMemoryCollection(embeddingModel);
      const { getMemoryVectorStore } = await import('./vector-memory.js');
      const vs = getMemoryVectorStore();
      if (vs) {
        await vs.deleteCollection(colId);
        // 重新创建空集合
        const { setMemoryCollectionId } = await import('./vector-memory.js');
        setMemoryCollectionId(null);
        await getOrCreateMemoryCollection(embeddingModel);
      }
    } catch (err) {
      logWarn('向量集合清空失败', (err as Error).message);
    }
  }
}

// ── 标记记忆被使用 ──

export async function markMemoryUsed(id: string): Promise<void> {
  const entry = memoryCache.find(e => e.id === id);
  if (!entry) return;

  entry.useCount++;
  entry.lastUsedAt = Date.now();

  const db = state.get<ChatDB | null>(KEYS.DB);
  if (db) await db.saveMemory(entry);
}

// ── 构建记忆上下文（注入 system prompt）──

export function buildMemoryContext(memories: MemorySearchResult[]): string {
  if (memories.length === 0) return '';

  const grouped: Record<string, MemorySearchResult[]> = {};
  for (const m of memories) {
    if (!grouped[m.type]) grouped[m.type] = [];
    grouped[m.type].push(m);
  }

  let context = '';

  // 规则类：强制约束，放在最前面
  if (grouped['rule']) {
    context += '【必须严格遵守的规则】\n以下规则是用户明确要求的，必须无条件执行：\n';
    for (const item of grouped['rule']) {
      context += `  - ${item.content}\n`;
    }
    context += '\n';
    delete grouped['rule'];
  }

  // 偏好类：用户偏好
  if (grouped['preference']) {
    context += '【用户偏好】\n在回答时请遵循以下偏好：\n';
    for (const item of grouped['preference']) {
      context += `  - ${item.content}\n`;
    }
    context += '\n';
    delete grouped['preference'];
  }

  // 事实类：参考信息
  if (grouped['fact']) {
    context += '【关于用户的参考信息】\n以下信息供参考，与当前对话无关时可忽略：\n';
    for (const item of grouped['fact']) {
      context += `  - ${item.content}\n`;
    }
    context += '\n';
  }

  context += '请自然地利用以上信息，不要生硬地列举。';

  return context;
}

// ── 自动提取记忆（会话结束时调用）──

export async function extractMemoriesFromConversation(
  messages: Array<{ role: string; content: string }>,
  sessionTitle?: string
): Promise<number> {
  if (!memoryEnabled) return 0;
  if (messages.length < 3) return 0;

  const api = state.get<OllamaAPI>(KEYS.API);
  const model = state.get<string>('_defaultModel', '');
  if (!api || !model) return 0;

  const recentMessages = messages.slice(-20);
  const conversationText = recentMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `[${m.role === 'user' ? '用户' : 'AI'}]: ${m.content}`)
    .join('\n\n');

  const extractPrompt = `你是一个记忆提取系统。请分析以下对话，提取值得长期记住的关键信息。

对话内容：
${conversationText.slice(0, 4000)}

请以 JSON 格式返回提取结果（不要输出其他内容）：

\`\`\`json
{
  "entries": [
    {
      "type": "fact",
      "content": "用户正在开发一个 Electron 桌面应用",
      "importance": 7,
      "tags": ["项目", "Electron", "开发"]
    }
  ]
}
\`\`\`

记忆类型说明（自动提取仅支持以下两种）：
- fact: 关于用户的具体事实（项目信息、技术栈、工作内容、个人背景）
- preference: 用户明确表达的偏好（喜欢某种输出格式、编码风格等）

⚠️ 严禁自动提取的类型：
- rule（规则）: 规则只能由用户手动添加，绝对不要自动提取规则

提取标准（极其严格）：
1. 只提取用户**明确陈述**的、有长期价值的信息，不要猜测或推断
2. 必须是**跨会话有用**的信息——如果只是本次对话的临时内容，不要提取
3. 每条记忆精炼简洁，不超过 50 字
4. importance 1-10，只有真正重要的才给 7+
5. tags 2-5 个关键词，用于检索匹配
6. 最多提取 3 条，宁缺毋滥

以下内容**不要提取**（常见错误）：
- 对话中的临时任务描述（如"帮我写个函数"）
- AI 的回复或建议内容
- 泛泛的表述（如"用户喜欢编程"、"用户是开发者"）
- 一次性的查询或请求
- 用户没有明确表达的隐含偏好
- 任何可以简单从对话上下文推断的信息

如果对话中没有真正值得跨会话记住的信息，返回 {"entries": []}`;

  try {
    const response = await api.chat({
      model,
      messages: [{ role: 'user', content: extractPrompt }],
      stream: false,
      think: false,
      options: { num_ctx: 8192, temperature: 0.1 }
    });

    const content = (response as { message?: { content?: string } })?.message?.content || '';
    const jsonMatch = content.match(new RegExp('```json\\s*([\\s\\S]*?)\\s*```')) || content.match(/\{[\s\S]*"entries"[\s\S]*\}/);

    if (!jsonMatch) return 0;

    const parsed: MemoryExtractionResult = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    if (!parsed.entries?.length) return 0;

    let count = 0;
    const currentSession = state.get(KEYS.CURRENT_SESSION);
    for (const entry of parsed.entries) {
      if (!entry.content || entry.content.length < 5) continue;
      const validType = entry.type === 'fact' || entry.type === 'preference' ? entry.type : 'fact';
      // 自动提取仅允许 fact 和 preference
      if (entry.type === 'rule') {
        logDebug('跳过自动提取的规则类型', entry.content.slice(0, 40));
        continue;
      }
      await addMemory({
        type: validType,
        content: entry.content,
        importance: Math.min(10, Math.max(1, entry.importance || 5)),
        tags: entry.tags || [],
        source: '自动提取',
        sessionId: currentSession?.id
      });
      count++;
    }

    if (count > 0) logMemory(`自动提取 ${count} 条`);
    return count;
  } catch (err) {
    logWarn('记忆自动提取失败', (err as Error).message);
    return 0;
  }
}

// ── 工具函数 ──

function extractTags(text: string): string[] {
  const words = text
    .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
  return [...new Set(words)].slice(0, 5);
}

function simpleSimilarity(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/));
  const bWords = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of aWords) {
    if (bWords.has(w)) intersection++;
  }
  const union = aWords.size + bWords.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
