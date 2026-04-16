/**
 * VectorMemory - 记忆向量存储与检索
 * 替代原 rag.ts，专为记忆系统提供向量能力
 */

import { state, KEYS } from '../state/state.js';
import { VectorStore } from './vector-store.js';
import { logMemory, logDebug, logError } from './log-service.js';
import type { MemoryEntry, OllamaAPI, VectorItem, SearchResult } from '../types.js';

const MEMORY_COLLECTION_NAME = '记忆向量索引';

let vectorStore: VectorStore | null = null;
let memoryCollectionId: string | null = null;

// ── 初始化 ──

export async function initMemoryVectorStore(): Promise<VectorStore> {
  if (vectorStore) return vectorStore;
  vectorStore = new VectorStore();
  await vectorStore.init();
  logDebug('记忆向量存储已初始化');
  return vectorStore;
}

export function getMemoryVectorStore(): VectorStore | null {
  return vectorStore;
}

// ── 集合管理 ──

export async function getOrCreateMemoryCollection(embedModel: string): Promise<{ id: string; isNew: boolean }> {
  const vs = await initMemoryVectorStore();

  // 如果已有缓存的集合ID，验证它是否存在
  if (memoryCollectionId) {
    const existing = await vs.getCollection(memoryCollectionId);
    if (existing) {
      if (existing.embeddingModel !== embedModel) {
        existing.embeddingModel = embedModel;
        await vs.updateCollection(existing);
      }
      return { id: memoryCollectionId, isNew: false };
    }
    memoryCollectionId = null;
  }

  // 搜索现有集合
  const collections = await vs.getCollections();
  const found = collections.find(c => c.name === MEMORY_COLLECTION_NAME);
  if (found) {
    memoryCollectionId = found.id;
    if (found.embeddingModel !== embedModel) {
      found.embeddingModel = embedModel;
      await vs.updateCollection(found);
    }
    return { id: found.id, isNew: false };
  }

  // 创建新集合
  const col = await vs.createCollection(MEMORY_COLLECTION_NAME, embedModel);
  memoryCollectionId = col.id;
  logMemory('创建记忆向量集合', col.id);
  return { id: col.id, isNew: true };
}

export function getMemoryCollectionId(): string | null {
  return memoryCollectionId;
}

export function setMemoryCollectionId(id: string | null): void {
  memoryCollectionId = id;
}

// ── 文本嵌入 ──

export async function embedText(text: string, model: string): Promise<number[]> {
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) throw new Error('Ollama API 未连接');

  const result = await api.embed(model, text);
  if (result.embedding) return result.embedding;
  if (result.embeddings && result.embeddings[0]) return result.embeddings[0];
  throw new Error('嵌入向量返回格式异常');
}

// ── 为记忆条目生成向量 ──

export async function embedMemoryEntry(entry: MemoryEntry, model: string): Promise<number[]> {
  const text = `[${entry.type}] ${entry.content} ${entry.tags.join(' ')}`;
  return embedText(text, model);
}

// ── 添加记忆向量 ──

export async function addMemoryVector(entry: MemoryEntry, embedding: number[], colId: string): Promise<void> {
  const vs = await initMemoryVectorStore();
  const item: VectorItem = {
    id: `vec_${entry.id}`,
    collectionId: colId,
    docId: entry.id,
    filename: entry.type,
    chunkIndex: 0,
    text: entry.content,
    charCount: entry.content.length,
    embedding
  };
  await vs.addVectors([item]);
}

// ── 更新记忆向量 ──

export async function updateMemoryVector(entry: MemoryEntry, embedding: number[], colId: string): Promise<void> {
  // 先删除旧的，再添加新的
  await deleteMemoryVector(entry.id, colId);
  await addMemoryVector(entry, embedding, colId);
}

// ── 删除记忆向量 ──

export async function deleteMemoryVector(entryId: string, colId: string): Promise<void> {
  const vs = await initMemoryVectorStore();
  await vs.deleteVectorsByDocument(colId, entryId);
}

// ── 向量搜索记忆 ──

export async function searchMemoriesByVector(query: string, colId: string, topK = 8): Promise<SearchResult[]> {
  const vs = await initMemoryVectorStore();
  const col = await vs.getCollection(colId);
  if (!col || !col.embeddingModel) return [];

  const queryEmbedding = await embedText(query, col.embeddingModel);
  const results = await vs.search(colId, queryEmbedding, topK);
  return results;
}

// ── 重新索引所有记忆 ──

export async function reindexAllMemories(
  entries: MemoryEntry[],
  embedModel: string,
  colId: string,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const vs = await initMemoryVectorStore();

  // 清空集合中的旧向量
  const oldVectors = await vs.getVectorsByCollection(colId);
  if (oldVectors.length > 0) {
    await vs.deleteCollection(colId);
    const col = await vs.createCollection(MEMORY_COLLECTION_NAME, embedModel);
    memoryCollectionId = col.id;
    colId = col.id;
  }

  logMemory(`开始重新索引: ${entries.length} 条记忆`);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      const embedding = await embedMemoryEntry(entry, embedModel);
      await addMemoryVector(entry, embedding, colId);
    } catch (err) {
      logError(`索引记忆失败: ${entry.id}`, (err as Error).message);
    }
    if (onProgress) onProgress(i + 1, entries.length);
  }

  logMemory(`重新索引完成: ${entries.length} 条`);
}
