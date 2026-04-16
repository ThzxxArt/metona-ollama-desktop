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

// 导出：获取向量搜索结果（供 UI 使用）
export function getVectorSearchResults(query: string): MemorySearchResult[] {
  return vectorSearchCache.get(query) || [];
}

// 关键词搜索
function searchMemoriesByKeyword(query: string, limit: number): MemorySearchResult[] {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/[\s,，。！？、；：""''（）\[\]{}<>`~@#$%^&*+=|\\/.]+/).filter(w => w.length > 1);

  const scored = memoryCache.map(entry => {
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

    return { ...entry, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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

  // 检查重复（内容相似度 > 80% 则跳过）
  const existing = memoryCache.find(e => {
    if (e.type !== data.type) return false;
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
      logWarn('向量存储失败', (err as Error).message);
    }
  }

  return entry;
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

  let context = '【关于用户的重要信息】\n';
  context += '以下是你之前记住的关于用户的信息，在回答时请参考：\n\n';

  for (const [type, items] of Object.entries(grouped)) {
    const typeName = TYPE_NAMES[type] || type;
    context += `— ${typeName} —\n`;
    for (const item of items) {
      context += `  • ${item.content}\n`;
    }
    context += '\n';
  }

  context += '请自然地利用这些信息，不要生硬地列举。如果信息与当前对话无关，忽略即可。';

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

记忆类型说明：
- fact: 关于用户的事实（项目、身份、背景、习惯）
- preference: 用户偏好（语言风格、输出格式、技术栈偏好）
- rule: 用户要求遵守的规则（编码规范、输出要求）

提取规则：
1. 只提取真正有价值、值得跨会话记住的信息
2. 每条记忆精炼简洁，不超过 50 字
3. importance 1-10，5 为普通，8+ 为必须记住
4. tags 2-5 个关键词，用于检索匹配
5. 最多提取 5 条，宁缺毋滥
6. 如果对话中没有值得记住的信息，返回 {"entries": []}`;

  try {
    const response = await api.chat({
      model,
      messages: [{ role: 'user', content: extractPrompt }],
      stream: false,
      think: false,
      options: { num_ctx: 8192, temperature: 0.1 }
    });

    const content = (response as { message?: { content?: string } })?.message?.content || '';
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*"entries"[\s\S]*\}/);

    if (!jsonMatch) return 0;

    const parsed: MemoryExtractionResult = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    if (!parsed.entries?.length) return 0;

    let count = 0;
    const currentSession = state.get(KEYS.CURRENT_SESSION);
    for (const entry of parsed.entries) {
      if (!entry.content || entry.content.length < 5) continue;
      const validType = (['fact', 'preference', 'rule'] as const).includes(entry.type as any) ? entry.type : 'fact';
      await addMemory({
        type: validType as any,
        content: entry.content,
        importance: Math.min(10, Math.max(1, entry.importance || 5)),
        tags: entry.tags || [],
        source: sessionTitle || '自动提取',
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
