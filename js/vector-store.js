/**
 * VectorStore - 向量存储与相似度检索
 *
 * 基于 IndexedDB 持久化，支持余弦相似度搜索
 */

export class VectorStore {
    constructor(dbName = 'metona-ollama-vectors') {
        this.dbName = dbName;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
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
            };
        });
    }

    _tx(store, mode = 'readonly') {
        return this.db.transaction(store, mode).objectStore(store);
    }

    // ── 集合管理 ──

    async createCollection(name, embeddingModel = '') {
        const col = {
            id: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            embeddingModel,
            docCount: 0,
            chunkCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now()
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
        // 删除集合下所有向量
        const vectors = await this.getVectorsByCollection(colId);
        const store = this._tx('vectors', 'readwrite');
        for (const v of vectors) store.delete(v.id);
        return new Promise((resolve, reject) => {
            const req = this._tx('collections', 'readwrite').delete(colId);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    // ── 向量操作 ──

    async addVectors(items) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('vectors', 'readwrite');
            const store = tx.objectStore('vectors');
            for (const item of items) store.put(item);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async getVectorsByCollection(colId) {
        return new Promise((resolve, reject) => {
            const idx = this._tx('vectors').index('collectionId');
            const req = idx.getAll(colId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async deleteVectorsByCollection(colId) {
        const vectors = await this.getVectorsByCollection(colId);
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('vectors', 'readwrite');
            const store = tx.objectStore('vectors');
            for (const v of vectors) store.delete(v.id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async deleteVectorsByDocument(colId, docId) {
        const vectors = await this.getVectorsByCollection(colId);
        const docVectors = vectors.filter(v => v.docId === docId);
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('vectors', 'readwrite');
            const store = tx.objectStore('vectors');
            for (const v of docVectors) store.delete(v.id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // ── 相似度检索 ──

    async search(colId, queryEmbedding, topK = 5) {
        const vectors = await this.getVectorsByCollection(colId);
        if (vectors.length === 0) return [];

        return vectors
            .map(v => ({
                ...v,
                score: VectorStore.cosineSimilarity(queryEmbedding, v.embedding)
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    /**
     * 余弦相似度
     */
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
