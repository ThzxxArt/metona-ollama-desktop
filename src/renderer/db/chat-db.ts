/**
 * ChatDB - IndexedDB 封装层
 */

import type { ChatSession } from '../types.js';

export class ChatDB {
  private dbName: string;
  private version: number;
  private db: IDBDatabase | null = null;

  constructor(dbName = 'metona-ollama', version = 1) {
    this.dbName = dbName;
    this.version = version;
  }

  async init(): Promise<void> {
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
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('sessions')) {
          const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' });
          sessionStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          sessionStore.createIndex('model', 'model', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  }

  private _ensureDB(): void {
    if (!this.db) throw new Error('数据库未初始化，请先调用 init()');
  }

  private _tx(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
    this._ensureDB();
    const tx = this.db!.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  async saveSession(session: ChatSession): Promise<string> {
    return new Promise((resolve, reject) => {
      const store = this._tx('sessions', 'readwrite');
      const request = store.put(session);
      request.onsuccess = () => resolve(session.id);
      request.onerror = () => reject(request.error);
    });
  }

  async getSession(id: string): Promise<ChatSession | null> {
    return new Promise((resolve, reject) => {
      const store = this._tx('sessions');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllSessions(): Promise<ChatSession[]> {
    return new Promise((resolve, reject) => {
      const store = this._tx('sessions');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteSession(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this._tx('sessions', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clearAll(): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this._tx('sessions', 'readwrite');
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async importSessions(sessions: ChatSession[]): Promise<{ imported: number; skipped: number }> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      let imported = 0;
      let skipped = 0;

      tx.oncomplete = () => resolve({ imported, skipped });
      tx.onerror = () => reject(tx.error);

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

  async getSessionsByTimeRange(startTime: number, endTime: number): Promise<ChatSession[]> {
    return new Promise((resolve, reject) => {
      const store = this._tx('sessions');
      const index = store.index('updatedAt');
      const range = IDBKeyRange.bound(startTime, endTime);
      const request = index.getAll(range);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async saveSetting(key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this._tx('settings', 'readwrite');
      const request = store.put({ key, value });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getSetting<T = unknown>(key: string, defaultValue: T | null = null): Promise<T> {
    return new Promise((resolve, reject) => {
      const store = this._tx('settings');
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : defaultValue);
      request.onerror = () => reject(request.error);
    });
  }
}
