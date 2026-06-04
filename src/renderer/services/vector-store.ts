/**
 * VectorStore - 向量存储与相似度检索
 */

import type { VectorCollection, VectorItem, SearchResult } from '../types.js';
import { logRAG, logDebug } from './log-service.js';

const MIN_IVF_SIZE = 200;
const DEFAULT_K = 20;
const DEFAULT_NPROBE = 5;
const KMEANS_ITERS = 10;

interface IVFIndex {
  centroids: number[][];
  invertedLists: Map<number, string[]>;
  collectionId?: string;
  version?: string;
}

export class VectorStore {
  private dbName: string;
  private db: IDBDatabase | null = null;
  private _indexCache = new Map<string, IVFIndex>();
  private _vectorCache = new Map<string, Map<string, VectorItem>>();

  constructor(dbName = 'metona-ollama-vectors') {
    this.dbName = dbName;
  }

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { this.db = req.result; logDebug('向量数据库已连接'); resolve(); };
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('vectors')) {
          const store = db.createObjectStore('vectors', { keyPath: 'id' });
          store.createIndex('collectionId', 'collectionId', { unique: false });
        }
        if (!db.objectStoreNames.contains('collections')) {
          db.createObjectStore('collections', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('indexes')) {
          db.createObjectStore('indexes', { keyPath: 'collectionId' });
        }
      };
    });
  }

  private _tx(store: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
    return this.db!.transaction(store, mode).objectStore(store);
  }

  async createCollection(name: string, embeddingModel = ''): Promise<VectorCollection> {
    const col: VectorCollection = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name, embeddingModel,
      docCount: 0, chunkCount: 0,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    return new Promise((resolve, reject) => {
      const req = this._tx('collections', 'readwrite').put(col);
      req.onsuccess = () => { logRAG(`创建集合: ${name}`, col.id); resolve(col); };
      req.onerror = () => reject(req.error);
    });
  }

  async getCollections(): Promise<VectorCollection[]> {
    return new Promise((resolve, reject) => {
      const req = this._tx('collections').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getCollection(id: string): Promise<VectorCollection | null> {
    return new Promise((resolve, reject) => {
      const req = this._tx('collections').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async updateCollection(col: VectorCollection): Promise<void> {
    col.updatedAt = Date.now();
    return new Promise((resolve, reject) => {
      const req = this._tx('collections', 'readwrite').put(col);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async deleteCollection(colId: string): Promise<void> {
    const vectors = await this.getVectorsByCollection(colId);
    logRAG(`删除集合`, `${colId} (${vectors.length} 向量)`);
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(['vectors', 'collections', 'indexes'], 'readwrite');
      const vStore = tx.objectStore('vectors');
      for (const v of vectors) vStore.delete(v.id);
      tx.objectStore('collections').delete(colId);
      tx.objectStore('indexes').delete(colId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    this._indexCache.delete(colId);
    this._vectorCache.delete(colId);
  }

  async addVectors(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;
    const colId = items[0].collectionId;
    logDebug(`写入向量`, `${colId}: ${items.length} 条`);
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('vectors', 'readwrite');
      const store = tx.objectStore('vectors');
      for (const item of items) store.put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (!this._vectorCache.has(colId)) {
      this._vectorCache.set(colId, new Map());
    }
    const cache = this._vectorCache.get(colId)!;
    for (const item of items) cache.set(item.id, item);
    this._indexCache.delete(colId);
  }

  async getVectorsByCollection(colId: string): Promise<VectorItem[]> {
    if (this._vectorCache.has(colId)) {
      return Array.from(this._vectorCache.get(colId)!.values());
    }
    const vectors = await new Promise<VectorItem[]>((resolve, reject) => {
      const idx = this._tx('vectors').index('collectionId');
      const req = idx.getAll(colId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const cache = new Map<string, VectorItem>();
    for (const v of vectors) cache.set(v.id, v);
    this._vectorCache.set(colId, cache);
    return vectors;
  }

  async deleteVectorsByDocument(colId: string, docId: string): Promise<void> {
    const vectors = await this.getVectorsByCollection(colId);
    const docVectors = vectors.filter(v => v.docId === docId);
    logDebug(`删除文档向量`, `${docId}: ${docVectors.length} 条`);
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('vectors', 'readwrite');
      const store = tx.objectStore('vectors');
      for (const v of docVectors) store.delete(v.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (this._vectorCache.has(colId)) {
      const cache = this._vectorCache.get(colId)!;
      for (const v of docVectors) cache.delete(v.id);
    }
    this._indexCache.delete(colId);
  }

  async search(colId: string, queryEmbedding: number[], topK = 5): Promise<SearchResult[]> {
    const vectors = await this.getVectorsByCollection(colId);
    if (vectors.length === 0) return [];

    let results: SearchResult[];
    if (vectors.length < MIN_IVF_SIZE) {
      results = this._bruteForceSearch(vectors, queryEmbedding, topK);
    } else {
      const index = await this._getIndex(colId, vectors);
      results = index ? this._ivfSearch(vectors, index, queryEmbedding, topK) : this._bruteForceSearch(vectors, queryEmbedding, topK);
    }
    logDebug(`向量搜索`, `${colId}: ${vectors.length} 向量中检索到 ${results.length} 个结果`);
    return results;
  }

  private _bruteForceSearch(vectors: VectorItem[], queryEmbedding: number[], topK: number): SearchResult[] {
    return vectors
      .map(v => ({ ...v, score: VectorStore.cosineSimilarity(queryEmbedding, v.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private _ivfSearch(vectors: VectorItem[], index: IVFIndex, queryEmbedding: number[], topK: number): SearchResult[] {
    const { centroids, invertedLists } = index;
    const clusterScores = centroids.map((c, i) => ({
      id: i,
      score: VectorStore.cosineSimilarity(queryEmbedding, c)
    }));
    clusterScores.sort((a, b) => b.score - a.score);

    const nprobe = Math.min(DEFAULT_NPROBE, centroids.length);
    const targetClusters = clusterScores.slice(0, nprobe);

    const candidateIds = new Set<string>();
    for (const { id: clusterId } of targetClusters) {
      const list = invertedLists.get(clusterId);
      if (list) for (const id of list) candidateIds.add(id);
    }

    const vectorMap = new Map<string, VectorItem>();
    for (const v of vectors) vectorMap.set(v.id, v);

    const candidates: VectorItem[] = [];
    for (const id of candidateIds) {
      const v = vectorMap.get(id);
      if (v) candidates.push(v);
    }

    return candidates
      .map(v => ({ ...v, score: VectorStore.cosineSimilarity(queryEmbedding, v.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private async _getIndex(colId: string, vectors: VectorItem[]): Promise<IVFIndex | null> {
    if (this._indexCache.has(colId)) {
      const cached = this._indexCache.get(colId)!;
      if (cached.version === this._indexVersion(vectors)) return cached;
    }

    const saved = await new Promise<IVFIndex & { invertedListsObj?: Record<string, string[]> } | null>((resolve, reject) => {
      const req = this._tx('indexes').get(colId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });

    if (saved && saved.version === this._indexVersion(vectors)) {
      if (!(saved.invertedLists instanceof Map)) {
        saved.invertedLists = new Map(Object.entries(saved.invertedListsObj || {}).map(([k, v]) => [parseInt(k), v as string[]]));
      }
      this._indexCache.set(colId, saved);
      return saved;
    }

    const index = this._buildIVFIndex(vectors);
    index.collectionId = colId;
    index.version = this._indexVersion(vectors);

    const toSave = {
      collectionId: index.collectionId,
      version: index.version,
      centroids: index.centroids,
      invertedListsObj: Object.fromEntries(index.invertedLists)
    };
    await new Promise<void>((resolve, reject) => {
      const req = this._tx('indexes', 'readwrite').put(toSave);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    this._indexCache.set(colId, index);
    return index;
  }

  private _indexVersion(vectors: VectorItem[]): string {
    if (vectors.length === 0) return '0';
    return `${vectors.length}_${vectors[0]?.id || ''}_${vectors[vectors.length - 1]?.id || ''}`;
  }

  private _buildIVFIndex(vectors: VectorItem[]): IVFIndex {
    const N = vectors.length;
    const dim = vectors[0].embedding.length;
    const K = Math.max(2, Math.min(DEFAULT_K, Math.floor(N / 10)));

    const centroids = this._kmeansPPInit(vectors, K, dim);
    const assignments = new Array<number>(N);

    for (let iter = 0; iter < KMEANS_ITERS; iter++) {
      for (let i = 0; i < N; i++) {
        let bestCluster = 0;
        let bestScore = -Infinity;
        for (let k = 0; k < K; k++) {
          const score = VectorStore.cosineSimilarity(vectors[i].embedding, centroids[k]);
          if (score > bestScore) { bestScore = score; bestCluster = k; }
        }
        assignments[i] = bestCluster;
      }

      const newCentroids = Array.from({ length: K }, () => new Array<number>(dim).fill(0));
      const counts = new Array<number>(K).fill(0);

      for (let i = 0; i < N; i++) {
        const k = assignments[i];
        counts[k]++;
        const emb = vectors[i].embedding;
        for (let d = 0; d < dim; d++) newCentroids[k][d] += emb[d];
      }

      for (let k = 0; k < K; k++) {
        if (counts[k] > 0) {
          for (let d = 0; d < dim; d++) newCentroids[k][d] /= counts[k];
          this._normalize(newCentroids[k]);
        } else {
          newCentroids[k] = [...vectors[Math.floor(Math.random() * N)].embedding];
        }
      }

      let converged = true;
      for (let k = 0; k < K; k++) {
        if (VectorStore.cosineSimilarity(centroids[k], newCentroids[k]) < 0.999) {
          converged = false;
          break;
        }
      }

      for (let k = 0; k < K; k++) centroids[k] = newCentroids[k];
      if (converged) break;
    }

    const invertedLists = new Map<number, string[]>();
    for (let i = 0; i < N; i++) {
      const k = assignments[i];
      if (!invertedLists.has(k)) invertedLists.set(k, []);
      invertedLists.get(k)!.push(vectors[i].id);
    }

    return { centroids, invertedLists };
  }

  private _kmeansPPInit(vectors: VectorItem[], K: number, dim: number): number[][] {
    const centroids: number[][] = [];
    const first = Math.floor(Math.random() * vectors.length);
    centroids.push([...vectors[first].embedding]);

    for (let k = 1; k < K; k++) {
      const dists = vectors.map(v => {
        let minDist = Infinity;
        for (const c of centroids) {
          const sim = VectorStore.cosineSimilarity(v.embedding, c);
          const dist = 1 - sim;
          if (dist < minDist) minDist = dist;
        }
        return minDist;
      });

      const total = dists.reduce((s, d) => s + d, 0);
      if (total === 0) {
        centroids.push([...vectors[Math.floor(Math.random() * vectors.length)].embedding]);
        continue;
      }

      let r = Math.random() * total;
      for (let i = 0; i < vectors.length; i++) {
        r -= dists[i];
        if (r <= 0) { centroids.push([...vectors[i].embedding]); break; }
      }
    }
    return centroids;
  }

  private _normalize(vec: number[]): void {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }

  static cosineSimilarity(a: number[], b: number[]): number {
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
}
