/**
 * VectorStore - 向量存储与相似度检索
 *
 * 优化：IVF 倒排索引
 * - 小数据集 (N < MIN_IVF_SIZE)：自动降级为暴力搜索
 * - 大数据集：K-Means 聚类 + nprobe 近邻搜索
 * - 索引在 addVectors() 后自动构建，持久化到 IndexedDB
 */

const MIN_IVF_SIZE = 200;   // 低于此数量不建索引，直接暴力搜
const DEFAULT_K = 20;       // 聚类中心数上限
const DEFAULT_NPROBE = 5;   // 搜索时探测的聚类数（覆盖 ~25% 数据）
const KMEANS_ITERS = 10;    // K-Means 迭代次数

export class VectorStore {
    constructor(dbName = 'metona-ollama-vectors') {
        this.dbName = dbName;
        this.db = null;

        // 内存索引缓存 { colId → { centroids, invertedLists, version } }
        this._indexCache = new Map();

        // 向量内存缓存 { colId → Map<vecId, vectorData> }
        this._vectorCache = new Map();
    }

    async init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 2);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => { this.db = req.result; resolve(); };
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
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

    _tx(store, mode = 'readonly') {
        return this.db.transaction(store, mode).objectStore(store);
    }

    // ═══════════════════════════════════════════
    // 集合管理
    // ═══════════════════════════════════════════

    async createCollection(name, embeddingModel = '') {
        const col = {
            id: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name, embeddingModel,
            docCount: 0, chunkCount: 0,
            createdAt: Date.now(), updatedAt: Date.now()
        };
        return new Promise((resolve, reject) => {
            const req = this._tx('collections', 'readwrite').put(col);
            req.onsuccess = () => resolve(col);
            req.onerror = () => reject(req.error);
        });
    }

    async getCollections() {
        return new Promise((resolve, reject) => {
            const req = this._tx('collections').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async getCollection(id) {
        return new Promise((resolve, reject) => {
            const req = this._tx('collections').get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async updateCollection(col) {
        col.updatedAt = Date.now();
        return new Promise((resolve, reject) => {
            const req = this._tx('collections', 'readwrite').put(col);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async deleteCollection(colId) {
        const vectors = await this.getVectorsByCollection(colId);
        await new Promise((resolve, reject) => {
            const tx = this.db.transaction(['vectors', 'collections', 'indexes'], 'readwrite');
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

    // ═══════════════════════════════════════════
    // 向量操作
    // ═══════════════════════════════════════════

    async addVectors(items) {
        if (items.length === 0) return;

        await new Promise((resolve, reject) => {
            const tx = this.db.transaction('vectors', 'readwrite');
            const store = tx.objectStore('vectors');
            for (const item of items) store.put(item);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        // 更新内存缓存
        const colId = items[0].collectionId;
        if (!this._vectorCache.has(colId)) {
            this._vectorCache.set(colId, new Map());
        }
        const cache = this._vectorCache.get(colId);
        for (const item of items) cache.set(item.id, item);

        // 标记索引需重建
        this._indexCache.delete(colId);
    }

    async getVectorsByCollection(colId) {
        if (this._vectorCache.has(colId)) {
            return Array.from(this._vectorCache.get(colId).values());
        }

        const vectors = await new Promise((resolve, reject) => {
            const idx = this._tx('vectors').index('collectionId');
            const req = idx.getAll(colId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });

        const cache = new Map();
        for (const v of vectors) cache.set(v.id, v);
        this._vectorCache.set(colId, cache);

        return vectors;
    }

    async deleteVectorsByCollection(colId) {
        const vectors = await this.getVectorsByCollection(colId);
        await new Promise((resolve, reject) => {
            const tx = this.db.transaction('vectors', 'readwrite');
            const store = tx.objectStore('vectors');
            for (const v of vectors) store.delete(v.id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        this._indexCache.delete(colId);
        this._vectorCache.delete(colId);
    }

    async deleteVectorsByDocument(colId, docId) {
        const vectors = await this.getVectorsByCollection(colId);
        const docVectors = vectors.filter(v => v.docId === docId);
        await new Promise((resolve, reject) => {
            const tx = this.db.transaction('vectors', 'readwrite');
            const store = tx.objectStore('vectors');
            for (const v of docVectors) store.delete(v.id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        if (this._vectorCache.has(colId)) {
            const cache = this._vectorCache.get(colId);
            for (const v of docVectors) cache.delete(v.id);
        }
        this._indexCache.delete(colId);
    }

    // ═══════════════════════════════════════════
    // 搜索：自动选择暴力 / IVF
    // ═══════════════════════════════════════════

    async search(colId, queryEmbedding, topK = 5) {
        const vectors = await this.getVectorsByCollection(colId);
        if (vectors.length === 0) return [];

        // 小数据集 → 暴力搜索
        if (vectors.length < MIN_IVF_SIZE) {
            return this._bruteForceSearch(vectors, queryEmbedding, topK);
        }

        // 大数据集 → IVF 搜索
        const index = await this._getIndex(colId, vectors);
        if (!index) {
            return this._bruteForceSearch(vectors, queryEmbedding, topK);
        }

        return this._ivfSearch(vectors, index, queryEmbedding, topK);
    }

    _bruteForceSearch(vectors, queryEmbedding, topK) {
        return vectors
            .map(v => ({ ...v, score: VectorStore.cosineSimilarity(queryEmbedding, v.embedding) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    _ivfSearch(vectors, index, queryEmbedding, topK) {
        const { centroids, invertedLists } = index;

        // 1. 找最近的 nprobe 个聚类中心
        const clusterScores = centroids.map((c, i) => ({
            id: i,
            score: VectorStore.cosineSimilarity(queryEmbedding, c)
        }));
        clusterScores.sort((a, b) => b.score - a.score);

        const nprobe = Math.min(DEFAULT_NPROBE, centroids.length);
        const targetClusters = clusterScores.slice(0, nprobe);

        // 2. 收集候选向量 ID
        const candidateIds = new Set();
        for (const { id: clusterId } of targetClusters) {
            const list = invertedLists.get(clusterId);
            if (list) for (const id of list) candidateIds.add(id);
        }

        // 3. 候选向量构建快速查找（避免逐个 find）
        const vectorMap = new Map();
        for (const v of vectors) vectorMap.set(v.id, v);

        const candidates = [];
        for (const id of candidateIds) {
            const v = vectorMap.get(id);
            if (v) candidates.push(v);
        }

        return candidates
            .map(v => ({ ...v, score: VectorStore.cosineSimilarity(queryEmbedding, v.embedding) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    // ═══════════════════════════════════════════
    // IVF 索引
    // ═══════════════════════════════════════════

    async _getIndex(colId, vectors) {
        // 内存缓存
        if (this._indexCache.has(colId)) {
            const cached = this._indexCache.get(colId);
            if (cached.version === this._indexVersion(vectors)) {
                return cached;
            }
        }

        // IndexedDB 缓存
        const saved = await new Promise((resolve, reject) => {
            const req = this._tx('indexes').get(colId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });

        if (saved && saved.version === this._indexVersion(vectors)) {
            // 反序列化 invertedLists（IndexedDB 不存 Map，存的是对象）
            if (!(saved.invertedLists instanceof Map)) {
                saved.invertedLists = new Map(Object.entries(saved.invertedLists || {}));
            }
            this._indexCache.set(colId, saved);
            return saved;
        }

        // 重建
        console.log(`[VectorStore] 构建 IVF 索引: ${colId} (${vectors.length} 向量)`);
        const index = this._buildIVFIndex(vectors);
        index.collectionId = colId;
        index.version = this._indexVersion(vectors);

        // 持久化（Map → 普通对象）
        const toSave = {
            collectionId: index.collectionId,
            version: index.version,
            centroids: index.centroids,
            invertedLists: Object.fromEntries(index.invertedLists)
        };
        await new Promise((resolve, reject) => {
            const req = this._tx('indexes', 'readwrite').put(toSave);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });

        this._indexCache.set(colId, index);
        return index;
    }

    _indexVersion(vectors) {
        if (vectors.length === 0) return '0';
        return `${vectors.length}_${vectors[0]?.id || ''}_${vectors[vectors.length - 1]?.id || ''}`;
    }

    /**
     * K-Means 聚类构建 IVF 索引
     */
    _buildIVFIndex(vectors) {
        const N = vectors.length;
        const dim = vectors[0].embedding.length;

        const K = Math.max(2, Math.min(DEFAULT_K, Math.floor(N / 10)));

        // 1. K-Means++ 初始化
        const centroids = this._kmeansPPInit(vectors, K, dim);

        // 2. K-Means 迭代
        const assignments = new Array(N);
        for (let iter = 0; iter < KMEANS_ITERS; iter++) {
            // E-step
            for (let i = 0; i < N; i++) {
                let bestCluster = 0;
                let bestScore = -Infinity;
                for (let k = 0; k < K; k++) {
                    const score = VectorStore.cosineSimilarity(vectors[i].embedding, centroids[k]);
                    if (score > bestScore) {
                        bestScore = score;
                        bestCluster = k;
                    }
                }
                assignments[i] = bestCluster;
            }

            // M-step
            const newCentroids = Array.from({ length: K }, () => new Array(dim).fill(0));
            const counts = new Array(K).fill(0);

            for (let i = 0; i < N; i++) {
                const k = assignments[i];
                counts[k]++;
                const emb = vectors[i].embedding;
                for (let d = 0; d < dim; d++) {
                    newCentroids[k][d] += emb[d];
                }
            }

            for (let k = 0; k < K; k++) {
                if (counts[k] > 0) {
                    for (let d = 0; d < dim; d++) {
                        newCentroids[k][d] /= counts[k];
                    }
                    this._normalize(newCentroids[k]);
                } else {
                    const randIdx = Math.floor(Math.random() * N);
                    newCentroids[k] = [...vectors[randIdx].embedding];
                }
            }

            // 收敛检测
            let converged = true;
            for (let k = 0; k < K; k++) {
                if (VectorStore.cosineSimilarity(centroids[k], newCentroids[k]) < 0.999) {
                    converged = false;
                    break;
                }
            }

            for (let k = 0; k < K; k++) {
                centroids[k] = newCentroids[k];
            }

            if (converged) break;
        }

        // 3. 构建倒排链表
        const invertedLists = new Map();
        for (let i = 0; i < N; i++) {
            const k = assignments[i];
            if (!invertedLists.has(k)) invertedLists.set(k, []);
            invertedLists.get(k).push(vectors[i].id);
        }

        return { centroids, invertedLists };
    }

    /**
     * K-Means++ 初始化
     */
    _kmeansPPInit(vectors, K, dim) {
        const centroids = [];
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
                if (r <= 0) {
                    centroids.push([...vectors[i].embedding]);
                    break;
                }
            }
        }
        return centroids;
    }

    /** 归一化向量（in-place） */
    _normalize(vec) {
        let norm = 0;
        for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }

    // ═══════════════════════════════════════════
    // 工具
    // ═══════════════════════════════════════════

    static cosineSimilarity(a, b) {
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
