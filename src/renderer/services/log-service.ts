/**
 * LogService - 实时日志面板服务
 * 收集应用内所有事件，渲染到左侧日志面板
 * 全程 try-catch，任何情况下不阻塞主流程
 */

import { escapeHtml } from '../utils/utils.js';

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

    // 导出日志按钮
    document.querySelector('#btnExportLog')?.addEventListener('click', exportLog);

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
export function addLog(level: LogLevel, message: string, detail?: string, icon?: string, customId?: string): void {
  try {
    const entry: LogEntry = {
      id: customId || genId(),
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

/** 本轮流式开始：同步创建新进度条目到日志底部（不删旧，日志就是完整记录） */
export function resetStreamProgress(): void {
  if (!logBodyEl) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry log-stream log-stream-progress';
  entry.innerHTML = `<span class="log-time">${formatTime(Date.now())}</span><span class="log-icon">📡</span><span class="log-msg">⏳ 等待模型响应… 0s</span>`;
  logBodyEl.appendChild(entry);
}

/** 更新**最新**一条流式进度日志（原地更新消息，不改变 DOM 位置和时间戳） */
export function logStreamProgress(msg: string): void {
  const all = logBodyEl?.querySelectorAll?.('.log-stream-progress');
  if (all && all.length > 0) {
    const latest = all[all.length - 1] as HTMLElement;
    const msgSpan = latest.querySelector('.log-msg');
    if (msgSpan) msgSpan.textContent = msg;
  }
}

/** 视频提取进度：创建初始条目 */
export function resetVideoProgress(fileName: string): void {
  if (!logBodyEl) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry log-info log-video-progress';
  entry.innerHTML = `<span class="log-time">${formatTime(Date.now())}</span><span class="log-icon">🎬</span><span class="log-msg">开始提取视频帧: ${escapeHtml(fileName)}</span><pre class="log-detail">0 帧</pre>`;
  logBodyEl.appendChild(entry);
}

/** 更新视频提取进度（原地更新，不新增条目） */
export function updateVideoProgress(current: number): void {
  const all = logBodyEl?.querySelectorAll?.('.log-video-progress');
  if (all && all.length > 0) {
    const latest = all[all.length - 1] as HTMLElement;
    const detail = latest.querySelector('.log-detail');
    if (detail) detail.textContent = `${current} 帧`;
  }
}

export function logAgentLoop(iteration: number, maxLoops: number): void { addLog('info', `Loop #${iteration}/${maxLoops}`); }
export function logModelResponse(contentLen: number, toolCalls: number): void { addLog('stream', `响应: ${contentLen}字, ${toolCalls}工具`); }
export function logConnection(status: string, detail?: string): void { addLog(status === 'connected' ? 'success' : 'warn', `连接: ${status}`, detail); }
export function logModel(name: string, action: string): void { addLog('info', `模型: ${action}`, name); }
export function logSession(action: string, detail?: string): void { addLog('info', `会话: ${action}`, detail); }
export function logMemory(action: string, detail?: string): void { addLog('debug', `记忆: ${action}`, detail); }
export function logRAG(action: string, detail?: string): void { addLog('info', `向量: ${action}`, detail); }
export function logSetting(key: string, value: string): void { addLog('debug', `设置: ${key}`, value); }
export function logInit(msg: string): void { addLog('info', `初始化: ${msg}`); }

/** 获取当前所有日志条目（供导出使用） */
export function getLogs(): LogEntry[] {
  return [...logs];
}

/** 导出执行日志为 TXT 文件 */
async function exportLog(): Promise<void> {
  if (logs.length === 0) {
    return;
  }

  const fmtTime = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };

  const lines = logs.map(e => {
    let line = `[${fmtTime(e.time)}] ${e.level.toUpperCase()} ${e.icon} ${e.message}`;
    if (e.detail) line += `\n  ${e.detail}`;
    return line;
  });

  const header = `Metona Ollama Desktop — 执行日志\n导出时间: ${fmtTime(Date.now())}\n日志条数: ${logs.length}\n${'═'.repeat(60)}\n\n`;
  const content = header + lines.join('\n');

  try {
    const bridge = window.metonaDesktop;
    if (bridge) {
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const filePath = await bridge.dialog.saveFile({
        defaultPath: `metona-log-${ts}.txt`,
        filters: [{ name: '文本文件', extensions: ['txt'] }]
      });
      if (!filePath) return;
      await bridge.fs.writeFile(filePath, content, 'utf-8');
    } else {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `metona-log-${Date.now()}.txt`;
      a.click();
    }
  } catch { /* ignore */ }
}
