/**
 * LogService - 实时日志面板服务
 * 收集应用内所有事件，渲染到左侧日志面板
 * 全程 try-catch，任何情况下不阻塞主流程
 */

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug' | 'tool' | 'think' | 'stream';

export interface LogEntry {
  id: string;
  time: number;
  level: LogLevel;
  icon: string;
  message: string;
  detail?: string;
}

let logBodyEl: HTMLElement | null = null;
let logPanelEl: HTMLElement | null = null;
const MAX_LOGS = 500;
let logs: LogEntry[] = [];
let autoScroll = true;
let idCounter = 0;
let renderQueued = false;
const pendingEntries: LogEntry[] = [];
let panelInitialized = false;
/** initLogPanel 前的日志暂存区 */
const earlyBuffer: LogEntry[] = [];

const LEVEL_ICONS: Record<LogLevel, string> = {
  info: 'ℹ️',
  success: '✅',
  warn: '⚠️',
  error: '❌',
  debug: '🔍',
  tool: '🔧',
  think: '🤔',
  stream: '📡',
};

export function initLogPanel(): void {
  try {
    logBodyEl = document.querySelector('#logPanelBody')!;
    logPanelEl = document.querySelector('#logPanel')!;

    logBodyEl.addEventListener('scroll', () => {
      try {
        const el = logBodyEl!;
        autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      } catch { /* ignore */ }
    });

    // ── 关键修复：flush initLogPanel 前缓冲的日志 ──
    panelInitialized = true;
    if (earlyBuffer.length > 0 && logBodyEl) {
      const frag = document.createDocumentFragment();
      for (const entry of earlyBuffer) {
        const div = document.createElement('div');
        div.className = `log-entry log-${entry.level}`;
        div.id = entry.id;
        let html = `<span class="log-time">${formatTime(entry.time)}</span>`;
        html += `<span class="log-icon">${entry.icon}</span>`;
        html += `<span class="log-msg">${escapeHtml(entry.message)}</span>`;
        if (entry.detail) {
          html += `<pre class="log-detail">${escapeHtml(entry.detail)}</pre>`;
        }
        div.innerHTML = html;
        frag.appendChild(div);
      }
      logBodyEl.appendChild(frag);
      earlyBuffer.length = 0;
      if (autoScroll) logBodyEl.scrollTop = logBodyEl.scrollHeight;
    }
  } catch { /* ignore */ }
}

function genId(): string {
  return `log_${++idCounter}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 批量渲染队列 — 使用 rAF 避免阻塞主线程 */
function flushPending(): void {
  if (!logBodyEl || pendingEntries.length === 0) return;
  renderQueued = false;

  try {
    const frag = document.createDocumentFragment();
    const toRender = pendingEntries.splice(0, pendingEntries.length);

    for (const entry of toRender) {
      const div = document.createElement('div');
      div.className = `log-entry log-${entry.level}`;
      div.id = entry.id;

      let html = `<span class="log-time">${formatTime(entry.time)}</span>`;
      html += `<span class="log-icon">${entry.icon}</span>`;
      html += `<span class="log-msg">${escapeHtml(entry.message)}</span>`;
      if (entry.detail) {
        html += `<pre class="log-detail">${escapeHtml(entry.detail)}</pre>`;
      }
      div.innerHTML = html;
      frag.appendChild(div);
    }

    logBodyEl.appendChild(frag);

    // 清理超出的旧 DOM 节点
    while (logBodyEl.children.length > MAX_LOGS) {
      logBodyEl.removeChild(logBodyEl.firstChild!);
    }

    if (autoScroll) {
      logBodyEl.scrollTop = logBodyEl.scrollHeight;
    }
  } catch { /* 绝不抛出 */ }
}

/** 核心日志方法 — 永远不阻塞调用方 */
export function addLog(level: LogLevel, message: string, detail?: string, icon?: string): void {
  try {
    const entry: LogEntry = {
      id: genId(),
      time: Date.now(),
      level,
      icon: icon || LEVEL_ICONS[level] || '•',
      message,
      detail,
    };

    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);

    // initLogPanel 之前：暂存到 earlyBuffer
    if (!panelInitialized) {
      earlyBuffer.push(entry);
      return;
    }

    pendingEntries.push(entry);
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(flushPending);
    }
  } catch { /* 绝不抛出 */ }
}

// ── 便捷方法（全部安全包装）──

export function logInfo(msg: string, detail?: string): void { addLog('info', msg, detail); }
export function logSuccess(msg: string, detail?: string): void { addLog('success', msg, detail); }
export function logWarn(msg: string, detail?: string): void { addLog('warn', msg, detail); }
export function logError(msg: string, detail?: string): void { addLog('error', msg, detail); }
export function logDebug(msg: string, detail?: string): void { addLog('debug', msg, detail); }

export function logToolStart(name: string, args: string): void {
  addLog('tool', `▶ ${name}`, args);
}

export function logToolResult(name: string, success: boolean, summary?: string): void {
  addLog(success ? 'success' : 'error', `◀ ${name} ${success ? '✓' : '✗'}`, summary, success ? '✅' : '❌');
}

export function logThink(thinking: string): void {
  const preview = thinking.length > 200 ? thinking.slice(-200) + '...' : thinking;
  addLog('think', '思考中', preview);
}

export function logStream(msg: string): void { addLog('stream', msg); }
export function logAgentLoop(iteration: number, maxLoops: number): void { addLog('info', `Loop #${iteration}/${maxLoops}`); }
export function logModelResponse(contentLen: number, toolCalls: number): void { addLog('stream', `响应: ${contentLen}字, ${toolCalls}工具`); }
export function logConnection(status: string, detail?: string): void { addLog(status === 'connected' ? 'success' : 'warn', `连接: ${status}`, detail); }
export function logModel(name: string, action: string): void { addLog('info', `模型: ${action}`, name); }
export function logSession(action: string, detail?: string): void { addLog('info', `会话: ${action}`, detail); }
export function logMemory(action: string, detail?: string): void { addLog('debug', `记忆: ${action}`, detail); }
export function logRAG(action: string, detail?: string): void { addLog('info', `RAG: ${action}`, detail); }
export function logSetting(key: string, value: string): void { addLog('debug', `设置: ${key}`, value); }
export function logInit(msg: string): void { addLog('info', `初始化: ${msg}`); }
