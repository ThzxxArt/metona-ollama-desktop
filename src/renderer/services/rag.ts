/**
 * RAG - 检索增强生成管线
 */

import { state, KEYS } from '../state/state.js';
import { VectorStore } from './vector-store.js';
import { chunkText, createChunkMetadata } from './document-processor.js';
import type { OllamaAPI, SearchResult, VectorItem } from '../types.js';

let vectorStore: VectorStore | null = null;

export async function initVectorStore(): Promise<VectorStore> {
  if (vectorStore) return vectorStore;
  vectorStore = new VectorStore();
  await vectorStore.init();
  return vectorStore;
}

export function getVectorStore(): VectorStore | null {
  return vectorStore;
}

export async function embedText(text: string, model: string): Promise<number[]> {
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) throw new Error('Ollama API 未连接');

  const result = await api.embed(model, text);
  if (result.embedding) return result.embedding;
  if (result.embeddings && result.embeddings[0]) return result.embeddings[0];
  throw new Error('嵌入向量返回格式异常');
}

export async function embedBatch(texts: string[], model: string, onProgress?: (done: number, total: number) => void): Promise<number[][]> {
  const results: number[][] = [];
  const batchSize = 5;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await Promise.all(batch.map(t => embedText(t, model)));
    results.push(...embeddings);
    if (onProgress) onProgress(Math.min(i + batchSize, texts.length), texts.length);
  }
  return results;
}

export async function addDocumentToKB(
  colId: string, filename: string, content: string, embedModel: string,
  onProgress?: (done: number, total: number, msg: string) => void
): Promise<{ docId: string; chunkCount: number }> {
  const vs = await initVectorStore();

  const textChunks = chunkText(content);
  if (textChunks.length === 0) throw new Error('文档内容为空，无法处理');

  const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  if (onProgress) onProgress(0, textChunks.length, '正在生成向量...');
  const embeddings = await embedBatch(textChunks, embedModel, (done, total) => {
    if (onProgress) onProgress(done, total, '正在生成向量...');
  });

  const vectors: VectorItem[] = textChunks.map((chunk, i) => {
    const meta = createChunkMetadata(chunk, i, docId, filename);
    return {
      ...meta,
      collectionId: colId,
      embedding: embeddings[i]
    };
  });

  if (onProgress) onProgress(textChunks.length, textChunks.length, '正在保存...');
  await vs.addVectors(vectors);

  const col = await vs.getCollection(colId);
  if (col) {
    col.docCount = (col.docCount || 0) + 1;
    col.chunkCount = (col.chunkCount || 0) + textChunks.length;
    col.embeddingModel = embedModel;
    await vs.updateCollection(col);
  }

  return { docId, chunkCount: textChunks.length };
}

export async function removeDocumentFromKB(colId: string, docId: string): Promise<void> {
  const vs = await initVectorStore();
  const allVectors = await vs.getVectorsByCollection(colId);
  const docVectors = allVectors.filter(v => v.docId === docId);

  await vs.deleteVectorsByDocument(colId, docId);

  const col = await vs.getCollection(colId);
  if (col) {
    col.chunkCount = Math.max(0, (col.chunkCount || 0) - docVectors.length);
    col.docCount = Math.max(0, (col.docCount || 0) - 1);
    await vs.updateCollection(col);
  }
}

export async function getDocumentsInCollection(colId: string): Promise<Array<{ docId: string; filename: string; chunkCount: number }>> {
  const vs = await initVectorStore();
  const vectors = await vs.getVectorsByCollection(colId);
  const docMap = new Map<string, { docId: string; filename: string; chunkCount: number }>();
  for (const v of vectors) {
    if (!docMap.has(v.docId)) {
      docMap.set(v.docId, { docId: v.docId, filename: v.filename, chunkCount: 0 });
    }
    docMap.get(v.docId)!.chunkCount++;
  }
  return Array.from(docMap.values());
}

export async function retrieveContext(query: string, colId: string, topK = 5): Promise<{ context: string; results: SearchResult[] }> {
  const vs = await initVectorStore();
  const col = await vs.getCollection(colId);
  if (!col) throw new Error('知识库集合不存在');

  const embedModel = col.embeddingModel;
  if (!embedModel) throw new Error('未配置嵌入模型');

  const queryEmbedding = await embedText(query, embedModel);
  const results = await vs.search(colId, queryEmbedding, topK);
  if (results.length === 0) return { context: '', results: [] };

  const contextParts = results.map((r, i) =>
    `[来源 ${i + 1}: ${r.filename}]\n${r.text}`
  );
  const context = contextParts.join('\n\n---\n\n');

  return { context, results };
}

export function buildRagSystemPrompt(context: string, originalSystemPrompt = ''): string {
  const ragPrompt = `你是一个知识库问答助手。以下是检索到的相关文档片段，请基于这些内容回答用户的问题。如果检索到的内容无法回答问题，请如实说明。

=== 检索到的相关内容 ===
${context}
=== 内容结束 ===

请基于以上内容回答用户的问题。引用时请注明来源编号（如"来源 1"）。`;

  if (originalSystemPrompt) {
    return originalSystemPrompt + '\n\n' + ragPrompt;
  }
  return ragPrompt;
}
