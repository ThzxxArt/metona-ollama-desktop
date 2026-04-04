/**
 * RAG - 检索增强生成管线
 *
 * 查询 → 嵌入 → 向量检索 → 构造上下文 → 注入 prompt
 */

import { state, KEYS } from './state.js';
import { VectorStore } from './vector-store.js';
import { chunkText, createChunkMetadata } from './document-processor.js';
import { showToast } from './components/toast.js';

let vectorStore = null;

/**
 * 初始化向量存储
 */
export async function initVectorStore() {
    if (vectorStore) return vectorStore;
    vectorStore = new VectorStore();
    await vectorStore.init();
    return vectorStore;
}

/**
 * 获取向量存储实例
 */
export function getVectorStore() {
    return vectorStore;
}

/**
 * 使用 Ollama 生成文本嵌入向量
 * @param {string} text
 * @param {string} model - 嵌入模型名称
 * @returns {number[]}
 */
export async function embedText(text, model) {
    const api = state.get(KEYS.API);
    if (!api) throw new Error('Ollama API 未连接');

    const result = await api.embed(model, text);
    // /api/embed 返回 { embedding: [...] } 或 { embeddings: [[...]] }
    if (result.embedding) return result.embedding;
    if (result.embeddings && result.embeddings[0]) return result.embeddings[0];
    throw new Error('嵌入向量返回格式异常');
}

/**
 * 批量嵌入（分批处理，避免超时）
 * @param {string[]} texts
 * @param {string} model
 * @param {function} onProgress - (done, total) => void
 * @returns {number[][]}
 */
export async function embedBatch(texts, model, onProgress) {
    const results = [];
    const batchSize = 5;
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const embeddings = await Promise.all(batch.map(t => embedText(t, model)));
        results.push(...embeddings);
        if (onProgress) onProgress(Math.min(i + batchSize, texts.length), texts.length);
    }
    return results;
}

/**
 * 向知识库集合添加文档
 * @param {string} colId - 集合 ID
 * @param {string} filename - 文件名
 * @param {string} content - 文件内容
 * @param {string} embedModel - 嵌入模型
 * @param {function} onProgress
 */
export async function addDocumentToKB(colId, filename, content, embedModel, onProgress) {
    const vs = await initVectorStore();

    // 1. 分块
    const textChunks = chunkText(content);
    if (textChunks.length === 0) throw new Error('文档内容为空，无法处理');

    // 2. 生成文档 ID
    const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // 3. 生成嵌入向量
    if (onProgress) onProgress(0, textChunks.length, '正在生成向量...');
    const embeddings = await embedBatch(textChunks, embedModel, (done, total) => {
        if (onProgress) onProgress(done, total, '正在生成向量...');
    });

    // 4. 构造向量数据
    const vectors = textChunks.map((chunk, i) => {
        const meta = createChunkMetadata(chunk, i, docId, filename);
        return {
            ...meta,
            collectionId: colId,
            embedding: embeddings[i]
        };
    });

    // 5. 存储
    if (onProgress) onProgress(textChunks.length, textChunks.length, '正在保存...');
    await vs.addVectors(vectors);

    // 6. 更新集合统计
    const col = await vs.getCollection(colId);
    if (col) {
        col.docCount = (col.docCount || 0) + 1;
        col.chunkCount = (col.chunkCount || 0) + textChunks.length;
        col.embeddingModel = embedModel;
        await vs.updateCollection(col);
    }

    return { docId, chunkCount: textChunks.length };
}

/**
 * 从知识库删除文档
 */
export async function removeDocumentFromKB(colId, docId) {
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

/**
 * 获取集合中的文档列表（去重）
 */
export async function getDocumentsInCollection(colId) {
    const vs = await initVectorStore();
    const vectors = await vs.getVectorsByCollection(colId);
    const docMap = new Map();
    for (const v of vectors) {
        if (!docMap.has(v.docId)) {
            docMap.set(v.docId, {
                docId: v.docId,
                filename: v.filename,
                chunkCount: 0
            });
        }
        docMap.get(v.docId).chunkCount++;
    }
    return Array.from(docMap.values());
}

/**
 * RAG 检索：查询 → 嵌入 → 相似度搜索 → 返回上下文文本
 * @param {string} query - 用户查询
 * @param {string} colId - 集合 ID
 * @param {number} topK - 返回最相关的 K 条
 * @returns {{ context: string, results: Array }}
 */
export async function retrieveContext(query, colId, topK = 5) {
    const vs = await initVectorStore();
    const col = await vs.getCollection(colId);
    if (!col) throw new Error('知识库集合不存在');

    const embedModel = col.embeddingModel;
    if (!embedModel) throw new Error('未配置嵌入模型');

    // 嵌入查询
    const queryEmbedding = await embedText(query, embedModel);

    // 向量检索
    const results = await vs.search(colId, queryEmbedding, topK);
    if (results.length === 0) return { context: '', results: [] };

    // 构造上下文
    const contextParts = results.map((r, i) =>
        `[来源 ${i + 1}: ${r.filename}]\n${r.text}`
    );
    const context = contextParts.join('\n\n---\n\n');

    return { context, results };
}

/**
 * 构造 RAG 增强的系统提示词
 */
export function buildRagSystemPrompt(context, originalSystemPrompt = '') {
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
