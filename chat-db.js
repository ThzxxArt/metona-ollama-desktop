/**
 * ChatDB - IndexedDB 封装层
 *
 * 用于持久化聊天历史记录和设置
 * 使用 IndexedDB 而非 localStorage，原因：
 * 1. 支持存储更大的数据（如 base64 图片）
 * 2. 异步操作不阻塞主线程
 * 3. 支持事务和索引查询
 */

export class ChatDB {
    constructor(dbName = 'metona-ollama', version = 1) {
        this.dbName = dbName;
        this.version = version;
        this.db = null;
    }

    /**
     * 初始化数据库
     * 创建 object stores 和索引
     */
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => {
                console.error('[ChatDB] 数据库打开失败:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('[ChatDB] 数据库已连接');
                resolve();
            };

            // 数据库升级/创建回调
            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // 会话存储
                if (!db.objectStoreNames.contains('sessions')) {
                    const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' });
                    sessionStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    sessionStore.createIndex('model', 'model', { unique: false });
                    console.log('[ChatDB] 创建 sessions 存储');
                }

                // 设置存储
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                    console.log('[ChatDB] 创建 settings 存储');
                }
            };
        });
    }

    /**
     * 确保数据库已连接
     */
    _ensureDB() {
        if (!this.db) throw new Error('数据库未初始化，请先调用 init()');
    }

    /**
     * 获取事务
     */
    _tx(storeName, mode = 'readonly') {
        this._ensureDB();
        const tx = this.db.transaction(storeName, mode);
        return tx.objectStore(storeName);
    }

    // ═══════════════════════════════════════════════════════════════
    // 会话 CRUD
    // ═══════════════════════════════════════════════════════════════

    /** 保存/更新会话 */
    async saveSession(session) {
        return new Promise((resolve, reject) => {
            const store = this._tx('sessions', 'readwrite');
            const request = store.put(session);
            request.onsuccess = () => resolve(session.id);
            request.onerror = () => reject(request.error);
        });
    }

    /** 获取单个会话 */
    async getSession(id) {
        return new Promise((resolve, reject) => {
            const store = this._tx('sessions');
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /** 获取所有会话 */
    async getAllSessions() {
        return new Promise((resolve, reject) => {
            const store = this._tx('sessions');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /** 删除会话 */
    async deleteSession(id) {
        return new Promise((resolve, reject) => {
            const store = this._tx('sessions', 'readwrite');
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /** 清空所有会话 */
    async clearAll() {
        return new Promise((resolve, reject) => {
            const store = this._tx('sessions', 'readwrite');
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /** 批量保存会话（单事务，原子性） */
    async importSessions(sessions) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sessions', 'readwrite');
            const store = tx.objectStore('sessions');
            let imported = 0;
            let skipped = 0;

            tx.oncomplete = () => resolve({ imported, skipped });
            tx.onerror = () => reject(tx.error);

            // 先检查每个 ID 是否已存在，再 put
            for (const session of sessions) {
                if (!session.id || !Array.isArray(session.messages)) {
                    skipped++;
                    continue;
                }
                const getRequest = store.get(session.id);
                getRequest.onsuccess = () => {
                    if (getRequest.result) {
                        skipped++;
                    } else {
                        store.put(session);
                        imported++;
                    }
                };
            }
        });
    }

    /** 按时间范围查询会话 */
    async getSessionsByTimeRange(startTime, endTime) {
        return new Promise((resolve, reject) => {
            const store = this._tx('sessions');
            const index = store.index('updatedAt');
            const range = IDBKeyRange.bound(startTime, endTime);
            const request = index.getAll(range);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // 设置 CRUD
    // ═══════════════════════════════════════════════════════════════

    /** 保存设置 */
    async saveSetting(key, value) {
        return new Promise((resolve, reject) => {
            const store = this._tx('settings', 'readwrite');
            const request = store.put({ key, value });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /** 获取设置 */
    async getSetting(key, defaultValue = null) {
        return new Promise((resolve, reject) => {
            const store = this._tx('settings');
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result ? request.result.value : defaultValue);
            request.onerror = () => reject(request.error);
        });
    }
}
