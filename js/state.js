/**
 * State - 轻量级响应式状态管理
 *
 * 优化点：
 * 1. 结构化浅比较：对象按 key 数量 + 逐 key 严格比较，数组按长度 + 逐元素
 * 2. update()：函数式更新，自动比较
 * 3. setIn()：路径式嵌套更新，沿途浅拷贝确保引用变化
 * 4. batch()：批量更新，合并通知
 */

// ── 结构化浅比较 ──
function shallowEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return false;

    // 数组：长度 + 逐元素
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    // 混合类型
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    // 对象：key 数量 + 逐 key
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || a[key] !== b[key]) return false;
    }
    return true;
}

class AppState {
    constructor() {
        this._state = {};
        this._listeners = new Map();
        this._batching = false;
        this._batchQueue = null;
    }

    /**
     * 设置状态值，使用结构化浅比较判断变更
     */
    set(key, value) {
        const old = this._state[key];
        this._state[key] = value;

        if (!shallowEqual(old, value)) {
            if (this._batching) {
                this._batchQueue.add(key);
            } else {
                this._notify(key, value, old);
            }
        }
    }

    /**
     * 函数式更新：基于当前值计算新值，自动比较
     *
     * state.update('currentSession', session => ({
     *     ...session,
     *     messages: [...session.messages, newMsg],
     *     updatedAt: Date.now()
     * }));
     */
    update(key, updater) {
        const old = this._state[key];
        const value = updater(old);
        this._state[key] = value;

        if (!shallowEqual(old, value)) {
            if (this._batching) {
                this._batchQueue.add(key);
            } else {
                this._notify(key, value, old);
            }
        }
    }

    /**
     * 路径式嵌套更新：按 path 更新嵌套属性，沿途浅拷贝确保引用变化
     *
     * state.setIn('currentSession', ['messages', 0, 'content'], '新内容');
     */
    setIn(key, path, value) {
        if (!path || path.length === 0) {
            this.set(key, value);
            return;
        }

        const old = this._state[key];
        if (old == null || typeof old !== 'object') {
            console.warn(`[State] setIn 失败: ${key} 不是对象`);
            return;
        }

        const newRoot = Array.isArray(old) ? [...old] : { ...old };
        let current = newRoot;

        for (let i = 0; i < path.length - 1; i++) {
            const segment = path[i];
            const next = current[segment];
            if (next == null || typeof next !== 'object') {
                const isIndex = typeof path[i + 1] === 'number';
                current[segment] = isIndex ? [] : {};
            } else {
                current[segment] = Array.isArray(next) ? [...next] : { ...next };
            }
            current = current[segment];
        }

        current[path[path.length - 1]] = value;

        this._state[key] = newRoot;
        if (!shallowEqual(old, newRoot)) {
            if (this._batching) {
                this._batchQueue.add(key);
            } else {
                this._notify(key, newRoot, old);
            }
        }
    }

    /**
     * 批量更新：合并多次 set 为一次通知
     *
     * state.batch(() => {
     *     state.set('isStreaming', false);
     *     state.update('currentSession', s => ({ ...s, updatedAt: Date.now() }));
     * });
     */
    batch(fn) {
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

    _notify(key, value, old) {
        if (!this._listeners.has(key)) return;
        for (const cb of this._listeners.get(key)) {
            try { cb(value, old); } catch (e) {
                console.error(`[State] 监听器错误 (${key}):`, e);
            }
        }
    }

    /**
     * 获取状态值
     */
    get(key, defaultValue = undefined) {
        return key in this._state ? this._state[key] : defaultValue;
    }

    /**
     * 订阅状态变更
     * @returns {function} 取消订阅函数
     */
    on(key, callback) {
        if (!this._listeners.has(key)) {
            this._listeners.set(key, new Set());
        }
        this._listeners.get(key).add(callback);
        return () => this._listeners.get(key)?.delete(callback);
    }

    /**
     * 批量设置初始状态
     */
    init(initial) {
        Object.assign(this._state, initial);
    }
}

// 单例
export const state = new AppState();

export const KEYS = {
    DB: 'db',
    API: 'api',
    CURRENT_SESSION: 'currentSession',
    IS_STREAMING: 'isStreaming',
    IS_HISTORY_VIEW: 'isHistoryView',
    PENDING_IMAGES: 'pendingImages',
    ABORT_CONTROLLER: 'abortController',
    SYSTEM_PROMPT: 'systemPrompt',
    SYSTEM_PROMPT_ENABLED: 'systemPromptEnabled',
    NUM_CTX: 'numCtx',
    HISTORY_PAGE: 'historyPage',
    HISTORY_SEARCH: 'historySearchQuery',
};
