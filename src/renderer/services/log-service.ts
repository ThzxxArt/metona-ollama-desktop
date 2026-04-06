/**
 * LogService - 实时日志面板服务
 * 收集应用内所有事件，渲染到左侧日志面板
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
  logBodyEl = document.querySelector('#logPanelBody')!;
  logPanelEl = document.querySelector('#logPanel')!;

  const btnToggle = document.querySelector('#btnToggleLog')!;
  const btnClose = document.querySelector('#btnCloseLog')!;
  const btnClear = document.querySelector('#btnClearLog')!;

  btnToggle.addEventListener('click', () => {
    const visible = logPanelEl!.style.display !== 'none';
    logPanelEl!.style.display = visible ? 'none' : '';
    document.querySelector('#mainWrap')!.classList.toggle('log-open', !visible);
  });

  btnClose.addEventListener('click', () => {
    logPanelEl!.style.display = 'none';
    document.querySelector('#mainWrap')!.classList.remove('log-open');
  });

  btnClear.addEventListener('click', () => {
    logs = [];
    if (logBodyEl) logBodyEl.innerHTML = '';
  });

  logBodyEl.addEventListener('scroll', () => {
    const el = logBodyEl!;
    autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  });
}

function genId(): string {
  return `log_${++idCounter}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function addLog(level: LogLevel, message: string, detail?: string, icon?: string): void {
  const entry: LogEntry = {
    id: genId(),
    time: Date.now(),
    level,
    icon: icon || LEVEL_ICONS[level] || '•',
    message,
    detail,
  };

  logs.push(entry);
  if (logs.length > MAX_LOGS) {
    const removed = logs.splice(0, logs.length - MAX_LOGS);
    for (const r of removed) {
      const el = document.getElementById(r.id);
      if (el) el.remove();
    }
  }

  appendLogDOM(entry);
}

function appendLogDOM(entry: LogEntry): void {
  if (!logBodyEl) return;

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
  logBodyEl.appendChild(div);

  if (autoScroll) {
    logBodyEl.scrollTop = logBodyEl.scrollHeight;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 便捷方法 ──

export function logInfo(msg: string, detail?: string): void {
  addLog('info', msg, detail);
}

export function logSuccess(msg: string, detail?: string): void {
  addLog('success', msg, detail);
}

export function logWarn(msg: string, detail?: string): void {
  addLog('warn', msg, detail);
}

export function logError(msg: string, detail?: string): void {
  addLog('error', msg, detail);
}

export function logDebug(msg: string, detail?: string): void {
  addLog('debug', msg, detail);
}

export function logToolStart(name: string, args: string): void {
  addLog('tool', `工具调用: ${name}`, args);
}

export function logToolResult(name: string, success: boolean, summary?: string): void {
  addLog(
    success ? 'success' : 'error',
    `工具完成: ${name}`,
    summary,
    success ? '✅' : '❌'
  );
}

export function logThink(thinking: string): void {
  const preview = thinking.length > 200 ? thinking.slice(-200) + '...' : thinking;
  addLog('think', '模型思考中', preview);
}

export function logStream(msg: string): void {
  addLog('stream', msg);
}

export function logAgentLoop(iteration: number, maxLoops: number): void {
  addLog('info', `Agent Loop #${iteration}/${maxLoops}`);
}

export function logModelResponse(contentLen: number, toolCalls: number): void {
  addLog('stream', `模型响应: ${contentLen} 字符, ${toolCalls} 个工具调用`);
}
