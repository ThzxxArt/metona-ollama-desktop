/**
 * State - 轻量级响应式状态管理
 */

import type { StateKey, ChatSession, ChatDB, OllamaAPI } from '../types.js';

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || (a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}

type Listener = (value: unknown, old: unknown) => void;

class AppState {
  private _state: Record<string, unknown> = {};
  private _listeners = new Map<string, Set<Listener>>();
  private _batching = false;
  private _batchQueue: Set<string> | null = null;

  set(key: string, value: unknown): void {
    const old = this._state[key];
    this._state[key] = value;
    if (!shallowEqual(old, value)) {
      if (this._batching) {
        this._batchQueue!.add(key);
      } else {
        this._notify(key, value, old);
      }
    }
  }

  update(key: string, updater: (old: unknown) => unknown): void {
    const old = this._state[key];
    const value = updater(old);
    this._state[key] = value;
    if (!shallowEqual(old, value)) {
      if (this._batching) {
        this._batchQueue!.add(key);
      } else {
        this._notify(key, value, old);
      }
    }
  }

  setIn(key: string, path: (string | number)[], value: unknown): void {
    if (!path || path.length === 0) {
      this.set(key, value);
      return;
    }
    const old = this._state[key];
    if (old == null || typeof old !== 'object') {
      return;
    }
    const newRoot = Array.isArray(old) ? [...(old as unknown[])] : { ...(old as Record<string, unknown>) };
    let current: Record<string, unknown> = newRoot as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
      const segment = path[i];
      const next = current[segment as string];
      if (next == null || typeof next !== 'object') {
        const isIndex = typeof path[i + 1] === 'number';
        current[segment as string] = isIndex ? [] : {};
      } else {
        current[segment as string] = Array.isArray(next) ? [...next] : { ...(next as Record<string, unknown>) };
      }
      current = current[segment as string] as Record<string, unknown>;
    }
    current[path[path.length - 1] as string] = value;
    this._state[key] = newRoot;
    if (!shallowEqual(old, newRoot)) {
      if (this._batching) {
        this._batchQueue!.add(key);
      } else {
        this._notify(key, newRoot, old);
      }
    }
  }

  batch(fn: () => void): void {
    this._batching = true;
    this._batchQueue = new Set();
    try {
      fn();
    } finally {
      const keys = this._batchQueue;
      this._batching = false;
      this._batchQueue = null;
      for (const k of keys) {
        this._notify(k, this._state[k], undefined);
      }
    }
  }

  private _notify(key: string, value: unknown, old: unknown): void {
    if (!this._listeners.has(key)) return;
    for (const cb of this._listeners.get(key)!) {
      try { cb(value, old); } catch (e) {
      }
    }
  }

  get<T = unknown>(key: string, defaultValue?: T): T {
    return (key in this._state ? this._state[key] : defaultValue) as T;
  }

  on(key: string, callback: Listener): () => void {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Set());
    }
    this._listeners.get(key)!.add(callback);
    return () => this._listeners.get(key)?.delete(callback);
  }

  init(initial: Record<string, unknown>): void {
    Object.assign(this._state, initial);
  }
}

export const state = new AppState();

export const KEYS = {
  DB: 'db',
  API: 'api',
  CURRENT_SESSION: 'currentSession',
  IS_STREAMING: 'isStreaming',
  IS_HISTORY_VIEW: 'isHistoryView',
  PENDING_IMAGES: 'pendingImages',
  ABORT_CONTROLLER: 'abortController',
  NUM_CTX: 'numCtx',
  HISTORY_PAGE: 'historyPage',
  HISTORY_SEARCH: 'historySearchQuery',
} as const;
