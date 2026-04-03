/**
 * State - 轻量级响应式状态管理
 * 使用发布-订阅模式，状态变更时通知所有订阅者
 */

class AppState {
    constructor() {
        this._state = {};
        this._listeners = new Map(); // key → Set<callback>
    }

    /**
     * 设置状态值并通知订阅者
     * @param {string} key - 状态键名
     * @param {*} value - 状态值
     */
    set(key, value) {
        const old = this._state[key];
        this._state[key] = value;
        if (old !== value && this._listeners.has(key)) {
            for (const cb of this._listeners.get(key)) {
                try { cb(value, old); } catch (e) { console.error(`[State] 监听器错误 (${key}):`, e); }
            }
        }
    }

    /**
     * 获取状态值
     * @param {string} key - 状态键名
     * @param {*} [defaultValue] - 默认值
     * @returns {*}
     */
    get(key, defaultValue = undefined) {
        return key in this._state ? this._state[key] : defaultValue;
    }

    /**
     * 订阅状态变更
     * @param {string} key - 状态键名
     * @param {function} callback - 回调函数 (newValue, oldValue) => void
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
     * @param {Object} initial - 初始状态对象
     */
    init(initial) {
        Object.assign(this._state, initial);
    }
}

// 单例
export const state = new AppState();

// ── 状态键名常量 ──
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
