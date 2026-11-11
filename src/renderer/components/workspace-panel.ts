/**
 * Workspace Panel — 右侧工作空间面板
 * 包含命令行和文件两个 Tab
 */

import { logInfo, logError, logDebug } from '../services/log-service.js';
import { escapeHtml, formatSize } from '../utils/utils.js';
import { addToolResultHighlighting } from './chat-area.js';
import { getEnabledToolDefinitions } from '../services/tool-registry.js';
import { getWorkspaceDirPath as getSharedWorkspaceDirPath, setWorkspaceDirPath } from '../services/workspace-state.js';

// ── 工具卡片类型 ──
interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: string;
  timestamp: number;
}

// ── 状态 ──
interface TerminalSession {
  id: string;
  title: string;
  lines: TerminalLine[];
  running: boolean;
  autoScroll: boolean;
}

interface TerminalLine {
  type: 'stdout' | 'stderr' | 'system';
  text: string;
}

interface FileNode {
  name: string;
  type: 'file' | 'directory';
  size: number | null;
  modified: string;
  expanded?: boolean;
  children?: FileNode[];
  loaded?: boolean;
}

let panelVisible = true; // 常驻显示，不可关闭
let activeTab: 'terminal' | 'tools' | 'files' = 'tools';
let terminal: TerminalSession | null = null; // 唯一终端
let workspaceDir = '';
let currentFileDir = '';
let fileTree: FileNode[] = [];
let previewFile: { name: string; content: string; path: string } | null = null;
let _counter = 0;
/** P0-2: 终端增量渲染 — 记录已渲染行数，避免全量重建 */
let _termRenderedCount = 0;
/** 终端容器 DOM 缓存，避免重复 querySelector */
let _termContainer: HTMLElement | null = null;

// ── 空闲状态轮转贴士 ──
const IDLE_TIPS = [
  '💡 可以让我读取文件、搜索代码、执行命令',
  '💡 试试说"帮我看看这个目录里有什么"',
  '💡 我可以联网搜索并抓取网页内容',
  '💡 支持 Git 操作：状态查看、提交、分支管理',
  '💡 我能记住你说过的重要信息，跨会话保留',
  '💡 上传图片让我分析，支持 Vision 模型',
  '💡 说"搜索..."我会自动联网查找最新信息',
  '💡 我会从成功经验中学习，越用越聪明',
  '💡 可以让我对比文件差异、批量替换文本',
  '💡 支持浏览器控制，帮你操作网页',
];
let tipIndex = Math.floor(Math.random() * IDLE_TIPS.length);
let tipTimer: ReturnType<typeof setInterval> | null = null;

/** 清空工具卡片（供外部调用） */
export function clearToolCardsExternal(): void {
  toolCards = [];
  if (activeTab === 'tools') renderToolCalls();
  updateToolsHint();
}

/** 清空终端（供外部调用） */
export function clearTerminalExternal(): void {
  if (terminal) {
    terminal.lines = [];
    terminal.running = false;
  }
  currentAiCommand = null;
  _termRenderedCount = 0; // P0-2: 重置增量计数器
  if (_termContainer) _termContainer.innerHTML = '';
  if (activeTab === 'terminal') renderTerminal();
  updateStopBtnState();
  updateHint();
}

/** 工具调用卡片列表 */
let toolCards: ToolCallRecord[] = [];

/** 当前正在运行的 AI 命令（用于用户手动终止时通知 AI） */
let currentAiCommand: string | null = null;


function genId(): string {
  return `ws_${Date.now()}_${++_counter}`;
}

// ── ANSI 颜色处理 ──
const ANSI_COLORS: Record<string, string> = {
  '30': '#666', '31': '#ff6b68', '32': '#5fb55f', '33': '#f5a742',
  '34': '#6db5f5', '35': '#d381d3', '36': '#38c9c9', '37': '#ccc',
  '90': '#888', '91': '#ff8a8a', '92': '#7ed97e', '93': '#ffd580',
  '94': '#8ec8ff', '95': '#e8a0e8', '96': '#5ee8e8', '97': '#fff',
};


function ansiToHtml(raw: string): string {
  // P1-2: 正则批量替换 ANSI，代替逐字遍历
  let text = escapeHtml(raw);
  
  // 处理 \r 进度覆盖：删除 \r 前到上一换行之间的内容
  text = text.replace(/\r(?!\n)/g, (match, offset) => {
    const prevNewline = text.lastIndexOf('\n', offset);
    return prevNewline >= 0 ? '\n' : '';
  });

  // 批量替换 ANSI 序列为 span（连续同色合并）
  let result = '';
  let i = 0;
  const seqRe = /\x1b\[([\d;]*)m/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = seqRe.exec(text)) !== null) {
    // 输出序列之前的文本
    result += text.slice(lastIndex, match.index);
    const codes = match[1].split(';');
    
    // 关闭之前的 span（如果有）
    // 简化：每个颜色序列独立包裹，不复用 span
    // 查找对应的文本片段：从当前位置到下一个 ANSI 序列或文本末尾
    const nextSeq = seqRe.exec(text);
    const contentStart = match.index + match[0].length;
    const contentEnd = nextSeq ? nextSeq.index : text.length;
    seqRe.lastIndex = nextSeq ? nextSeq.index : contentEnd; // 回退

    const content = text.slice(contentStart, contentEnd);
    if (!content) { lastIndex = contentEnd; continue; }

    let color = '';
    let bold = false;
    for (const code of codes) {
      if (code === '1') bold = true;
      else if (code === '0' || code === '') { /* reset */ }
      else if (ANSI_COLORS[code]) color = ANSI_COLORS[code];
    }

    if (color || bold) {
      const style = [color ? `color:${color}` : '', bold ? 'font-weight:bold' : ''].filter(Boolean).join(';');
      result += `<span style="${style}">${content}</span>`;
    } else {
      result += content;
    }
    lastIndex = contentEnd;
  }
  result += text.slice(lastIndex);
  return result;
}

// ── 初始化 ──
export async function initWorkspacePanel(): Promise<void> {
  // ── 强制重置默认页签：Electron 窗口关闭再打开时渲染进程未销毁，
  //     模块级 activeTab 可能保留上次用户手动切换的值
  activeTab = 'tools';
  renderPanel();

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) {
    logDebug('非桌面环境，跳过工作空间面板初始化');
    return;
  }

  // 获取工作空间目录
  try {
    const dirInfo = await bridge.workspace.getDir();
    workspaceDir = dirInfo.dir;
    setWorkspaceDirPath(workspaceDir);
    currentFileDir = workspaceDir;
    logInfo('工作空间目录', workspaceDir);
  } catch (err) {
    logError('获取工作空间目录失败', (err as Error).message);
  }

  // 监听进程输出
  bridge.workspace.onOutput((data) => {
    logDebug('工作空间收到输出', `ID: ${data.id} | ${data.type} | ${data.data.length}字节`);
    appendTerminalOutput(data.id, data.type, data.data);
  });

  bridge.workspace.onExit((data) => {
    logDebug('工作空间收到退出', `ID: ${data.id} | code: ${data.code}`);
    handleProcessExit(data.id, data.code);
  });

  // 监听 AI 命令实时输出，流式推送到终端面板
  bridge.workspace.onCmdOutput((data) => {
    appendToolStreamOutput(data.command, data.type, data.data);
  });

  // 监听 AI 命令执行完毕
  bridge.workspace.onCmdDone((data) => {
    logDebug('工作空间 AI 命令完成', `command: ${data.command.slice(0, 50)} | exitCode: ${data.exitCode}`);
    handleToolDone(data.command, data.exitCode);
  });

  // 绑定 UI 事件
  bindEvents();

  // ── 监听工作空间目录变更（来自设置面板）──
  window.addEventListener('workspaceDirChanged', ((e: CustomEvent) => {
    const newDir = e.detail?.dir;
    if (newDir && newDir !== workspaceDir) {
      workspaceDir = newDir;
      setWorkspaceDirPath(newDir);
      currentFileDir = newDir;
      logInfo('工作空间目录已刷新', newDir);
      // 如果当前在文件页签，立即重新加载
      if (activeTab === 'files') {
        loadFiles(newDir);
      }
      // 刷新终端空闲状态中的目录显示
      if (activeTab === 'terminal') {
        renderTerminal();
      }
      // 刷新文件页签（即使不在当前 tab，下次切过去就是新路径）
      renderPanel();
    }
  }) as EventListener);

  // 创建唯一终端
  terminal = {
    id: genId(),
    title: '终端',
    lines: [],
    running: false,
    autoScroll: true
  };

  logInfo('工作空间面板已初始化');

  // 首次渲染：显示空闲状态
  renderPanel();
}

function bindEvents(): void {
  // Tab 切换
  document.querySelector('#wsTabTerminal')?.addEventListener('click', () => switchTab('terminal'));
  document.querySelector('#wsTabTools')?.addEventListener('click', () => switchTab('tools'));
  document.querySelector('#wsTabFiles')?.addEventListener('click', () => switchTab('files'));

  // 停止按钮
  document.querySelector('#wsStopBtn')?.addEventListener('click', killCurrentProcess);

  // 清空按钮
  document.querySelector('#wsClearBtn')?.addEventListener('click', clearTerminal);

  // 工具清空按钮
  document.querySelector('#wsToolsClearBtn')?.addEventListener('click', clearToolCards);

  // 文件刷新
  document.querySelector('#wsFileRefreshBtn')?.addEventListener('click', () => {
    loadFiles(currentFileDir || workspaceDir);
  });

  // 文件返回上级
  document.querySelector('#wsFileUpBtn')?.addEventListener('click', () => {
    if (currentFileDir && currentFileDir !== workspaceDir) {
      const parent = currentFileDir.replace(/[/\\][^/\\]+$/, '');
      loadFiles(parent);
    }
  });

  // 关闭预览
  document.querySelector('#wsPreviewClose')?.addEventListener('click', () => {
    previewFile = null;
    renderPanel();
  });
}

// ── 面板控制 ──（常驻显示，无需切换）
function switchTab(tab: 'terminal' | 'tools' | 'files'): void {
  activeTab = tab;
  renderPanel();

  if (tab === 'files') {
    loadFiles(currentFileDir || workspaceDir);
  }
}

// ── 终端管理 ──
function getActiveSession(): TerminalSession | undefined {
  return terminal ?? undefined;
}

/** AI Tool Calling 实时输出 → 流式追加到活跃终端 */
function appendToolStreamOutput(command: string, type: 'stdout' | 'stderr', data: string): void {
  const session = getActiveSession();
  if (!session) return;

  // 首次输出时显示命令头
  if (!currentAiCommand) {
    currentAiCommand = command;
    session.running = true;
    session.lines.push({ type: 'system', text: `$ ${command} (AI)` });
    updateHint();
    updateStopBtnState();
  }

  // 流式追加输出（按行分割，保留最后一行用于后续追加）
  const lines = data.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i < lines.length - 1 || line) {
      const cleanLine = line.replace(/\r/g, '');
      if (cleanLine) session.lines.push({ type, text: cleanLine });
    }
  }

  // P1-3: 限制最大行数，但保留系统消息（命令头/退出状态等）
  if (session.lines.length > 3000) {
    const systemLines = session.lines.filter(l => l.type === 'system');
    const otherLines = session.lines.filter(l => l.type !== 'system');
    session.lines = [...systemLines.slice(-10), ...otherLines.slice(-1990)];
  }

  renderTerminal();
}

/** AI Tool Calling 命令执行完毕 */
function handleToolDone(command: string, exitCode: number | null): void {
  const session = getActiveSession();
  if (!session) return;

  // 显示退出状态
  const exitMsg = exitCode === 0 ? '✓ AI 命令执行成功' : `✗ AI 命令退出 (code: ${exitCode})`;
  session.lines.push({ type: 'system', text: exitMsg });

  session.running = false;
  currentAiCommand = null;

  renderTerminal();
  updateStopBtnState();
  updateHint();

  // 命令结束后，如果没有其他正在运行的工具，切到工具页签看结果
  const hasRunningTools = toolCards.some(c => c.status === 'running' && c.name !== 'run_command');
  if (!hasRunningTools && toolCards.length > 0) {
    setTimeout(() => switchToTab('tools'), 600);
  }
}

function appendTerminalOutput(sessionId: string, type: 'stdout' | 'stderr', data: string): void {
  if (!terminal || terminal.id !== sessionId) {
    logDebug('工作空间输出丢失', `未匹配终端: ${sessionId}`);
    return;
  }
  const session = terminal;

  // 按行分割，处理 \r 进度更新
  const lines = data.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i < lines.length - 1 || line) {
      // 处理 \r 覆盖（进度条效果）
      if (line.includes('\r') && !line.endsWith('\n')) {
        const parts = line.split('\r');
        const lastPart = parts[parts.length - 1];
        if (session.lines.length > 0 && session.lines[session.lines.length - 1].type !== 'system') {
          session.lines[session.lines.length - 1] = { type, text: lastPart };
        } else {
          session.lines.push({ type, text: lastPart });
        }
      } else {
        const cleanLine = line.replace(/\r/g, '');
        if (cleanLine) session.lines.push({ type, text: cleanLine });
      }
    }
  }

  // P1-3: 限制最大行数，保留系统消息
  if (session.lines.length > 3000) {
    const systemLines = session.lines.filter(l => l.type === 'system');
    const otherLines = session.lines.filter(l => l.type !== 'system');
    session.lines = [...systemLines.slice(-10), ...otherLines.slice(-1990)];
  }

  renderTerminal();
}

function handleProcessExit(sessionId: string, code: number | null): void {
  if (!terminal || terminal.id !== sessionId) {
    logDebug('工作空间退出信号丢失', `未匹配终端: ${sessionId}`);
    return;
  }
  const session = terminal;

  session.running = false;
  const exitMsg = code === 0 ? '✓ 进程正常退出' : `✗ 进程退出 (code: ${code})`;
  session.lines.push({ type: 'system', text: exitMsg });
  logInfo('工作空间进程退出', `ID: ${sessionId} | code: ${code}`);

  renderTerminal();

  // 更新停止按钮状态
  updateStopBtnState();
}

function killCurrentProcess(): void {
  const session = getActiveSession();
  if (!session) return;

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) return;

  // 终止用户终端进程（如果有）
  if (session.running) {
    bridge.workspace.kill(session.id);
  }

  // 终止当前 AI 命令
  bridge.workspace.cmdKill();

  const cmd = currentAiCommand;
  session.lines.push({ type: 'system', text: '■ 命令已手动终止' });
  session.running = false;
  currentAiCommand = null;

  renderTerminal();
  updateStopBtnState();
  updateHint();
}

function clearTerminal(): void {
  const session = getActiveSession();
  if (!session) return;
  session.lines = [];
  // 命令仍在运行时保留状态，并给用户明确提示，避免终端变成空白。
  if (session.running || currentAiCommand) {
    session.lines.push({ type: 'system', text: '■ 终端已清空，命令仍在运行…' });
  }
  _termRenderedCount = 0; // P0-2: 重置增量计数器
  if (_termContainer) _termContainer.innerHTML = '';
  renderTerminal();
}

// ── 文件浏览器 ──
async function loadFiles(dirPath: string): Promise<void> {
  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) return;

  try {
    const result = await bridge.workspace.listDir(dirPath);
    if (result.success && result.entries) {
      currentFileDir = dirPath;
      fileTree = result.entries.map(e => ({
        name: e.name,
        type: e.type,
        size: e.size,
        modified: e.modified
      }));
    }
  } catch (err) {
    logError('加载目录失败', (err as Error).message);
  }

  renderPanel();
}

async function openFile(filePath: string, fileName: string): Promise<void> {
  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) return;

  try {
    const result = await bridge.workspace.readFile(filePath);
    if (result.success && result.content !== undefined) {
      previewFile = { name: fileName, content: result.content, path: filePath };
      renderPanel();
    }
  } catch (err) {
    logError('读取文件失败', (err as Error).message);
  }
}

function navigateToDir(dirName: string): void {
  const newPath = currentFileDir + '/' + dirName;
  loadFiles(newPath.replace(/\/+/g, '/'));
}

// ── 渲染 ──
export function renderPanel(): void {
  const panel = document.querySelector('#workspacePanel') as HTMLElement;
  if (!panel) return;

  const termTab = document.querySelector('#wsTabTerminal') as HTMLElement;
  const toolsTab = document.querySelector('#wsTabTools') as HTMLElement;
  const filesTab = document.querySelector('#wsTabFiles') as HTMLElement;

  if (termTab) termTab.classList.toggle('active', activeTab === 'terminal');
  if (toolsTab) toolsTab.classList.toggle('active', activeTab === 'tools');
  if (filesTab) filesTab.classList.toggle('active', activeTab === 'files');

  const termContent = document.querySelector('#wsTerminalContent') as HTMLElement;
  const toolsContent = document.querySelector('#wsToolsContent') as HTMLElement;
  const filesContent = document.querySelector('#wsFilesContent') as HTMLElement;

  if (termContent) termContent.style.display = activeTab === 'terminal' ? '' : 'none';
  if (toolsContent) toolsContent.style.display = activeTab === 'tools' ? '' : 'none';
  if (filesContent) filesContent.style.display = activeTab === 'files' ? '' : 'none';

  if (activeTab === 'terminal') {
    renderTerminal();
  } else if (activeTab === 'tools') {
    renderToolCalls();
  } else {
    renderFileList();
  }

  updateStopBtnState();
}

function renderTerminal(): void {
  if (!_termContainer) _termContainer = document.querySelector('#wsTermOutput') as HTMLElement;
  const container = _termContainer;
  if (!container) return;

  const session = getActiveSession();
  if (!session) {
    container.innerHTML = '<div class="ws-term-placeholder">无终端会话</div>';
    _termRenderedCount = 0;
    return;
  }

  // 空闲状态：显示 Logo + 信息 + 贴士
  if (session.lines.length === 0 && !session.running) {
    _termRenderedCount = 0;
    renderIdleState(container);
    startTipRotation(container);
    return;
  }

  // 有内容时停止贴士轮转
  stopTipRotation();

  // ── P0-2: 终端增量渲染 — 只追加新行，不重建已有 DOM ──
  // 检测重置（行数骤减说明被清空）
  if (_termRenderedCount > session.lines.length) {
    container.innerHTML = '';
    _termRenderedCount = 0;
  }

  // 从 idle 状态切换到有内容时，清空 idle DOM
  // idle 状态用 position:absolute 覆盖在内容上方，不清空会同时显示
  if (_termRenderedCount === 0 && container.querySelector('.ws-idle-state')) {
    container.innerHTML = '';
  }

  // 增量追加新行
  const fragment = document.createDocumentFragment();
  for (let i = _termRenderedCount; i < session.lines.length; i++) {
    const line = session.lines[i];
    const div = document.createElement('div');
    div.className = `ws-term-line ws-term-${line.type}`;
    div.innerHTML = ansiToHtml(line.text); // P1-2: ANSI 颜色，正则批量替换
    fragment.appendChild(div);
  }
  if (fragment.childNodes.length > 0) {
    container.appendChild(fragment);
    _termRenderedCount = session.lines.length;
  }

  // 行数超限时清理旧 DOM 节点并同步计数
  if (container.children.length > 3000) {
    const excess = container.children.length - 2000;
    for (let i = 0; i < excess && container.firstChild; i++) {
      container.removeChild(container.firstChild);
    }
    _termRenderedCount = 2000;
  }

  // 自动滚动到底部
  if (session.autoScroll) {
    container.scrollTop = container.scrollHeight;
  }

  // 监听滚动事件（只绑定一次）
  if (!container.dataset.scrollBound) {
    container.dataset.scrollBound = '1';
    container.addEventListener('scroll', () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
      session.autoScroll = atBottom;
    });
  }
}

/** 渲染空闲状态 */
function renderIdleState(container: HTMLElement): void {
  const tip = IDLE_TIPS[tipIndex];
  const dirDisplay = workspaceDir
    ? workspaceDir.replace(/.*[/\\]/, '~/.')
    : '未设置';

  // 截取目录最后一段
  const shortDir = workspaceDir
    ? '...' + workspaceDir.slice(-30)
    : '未设置';

  container.innerHTML = `
    <div class="ws-idle-state">
      <div class="ws-idle-logo">
        <pre class="ws-idle-ascii">   ╭───────╮
   │ ◕  ◕ │
   │   ▽   │
   ╰─┬───┬─╯
    ╱│   │╲
   ╱ │   │ ╲
  🦙 Metona</pre>
      </div>
      <div class="ws-idle-info">
        <div class="ws-idle-info-row">
          <span class="ws-idle-label">工作空间</span>
          <span class="ws-idle-value" title="${escapeHtml(workspaceDir)}">${escapeHtml(shortDir)}</span>
        </div>
      </div>
      <div class="ws-idle-divider"></div>
      <div class="ws-idle-tip" id="wsIdleTip">${escapeHtml(tip)}</div>
    </div>
  `;

  // 重置滚动
  container.scrollTop = 0;
}

/** 启动贴士轮转 */
function startTipRotation(container: HTMLElement): void {
  if (tipTimer) return;
  tipTimer = setInterval(() => {
    // 只在空闲状态时轮转
    const session = getActiveSession();
    if (!session || session.lines.length > 0 || session.running) {
      stopTipRotation();
      return;
    }
    tipIndex = (tipIndex + 1) % IDLE_TIPS.length;
    const tipEl = container.querySelector('#wsIdleTip');
    if (tipEl) {
      tipEl.classList.add('fading');
      setTimeout(() => {
        tipEl.textContent = IDLE_TIPS[tipIndex];
        tipEl.classList.remove('fading');
      }, 300);
    }
  }, 6000);
}

/** 停止贴士轮转 */
function stopTipRotation(): void {
  if (tipTimer) {
    clearInterval(tipTimer);
    tipTimer = null;
  }
}

function renderFileList(): void {
  const container = document.querySelector('#wsFileList') as HTMLElement;
  if (!container) return;

  // 更新路径显示
  const pathDisplay = document.querySelector('#wsFilePath') as HTMLElement;
  if (pathDisplay) {
    const relPath = currentFileDir.replace(workspaceDir, '~');
    pathDisplay.textContent = relPath || '~';
    pathDisplay.title = currentFileDir;
  }

  if (fileTree.length === 0) {
    const relDir = currentFileDir.replace(workspaceDir, '~') || '~';
    container.innerHTML = `
      <div class="ws-idle-state">
        <div class="ws-idle-icon ws-idle-icon-lg">📂</div>
        <div class="ws-idle-desc">${escapeHtml(relDir)}</div>
        <div class="ws-idle-divider"></div>
        <div class="ws-idle-hint">空目录 · AI 创建的文件会出现在这里</div>
      </div>
    `;
    return;
  }

  container.innerHTML = fileTree.map(entry => {
    const icon = entry.type === 'directory' ? '📁' : getFileIcon(entry.name);
    const size = entry.size !== null ? formatSize(entry.size) : '';
    const fullPath = (currentFileDir + '/' + entry.name).replace(/\/+/g, '/');

    return `<div class="ws-file-item" data-name="${escapeHtml(entry.name)}" data-type="${entry.type}" data-path="${escapeHtml(fullPath)}">
      <span class="ws-file-icon">${icon}</span>
      <span class="ws-file-name">${escapeHtml(entry.name)}</span>
      <span class="ws-file-size">${size}</span>
    </div>`;
  }).join('');

  // 绑定点击事件
  container.querySelectorAll('.ws-file-item').forEach(item => {
    item.addEventListener('click', () => {
      const el = item as HTMLElement;
      const type = el.dataset.type;
      const name = el.dataset.name!;
      const filePath = el.dataset.path!;

      if (type === 'directory') {
        navigateToDir(name);
      } else {
        openFile(filePath, name);
      }
    });

    item.addEventListener('dblclick', () => {
      const el = item as HTMLElement;
      if (el.dataset.type === 'directory') {
        navigateToDir(el.dataset.name!);
      }
    });
  });

  // 渲染预览
  renderPreview();
}

function renderPreview(): void {
  const previewContainer = document.querySelector('#wsPreview') as HTMLElement;
  if (!previewContainer) return;

  if (!previewFile) {
    previewContainer.style.display = 'none';
    return;
  }

  previewContainer.style.display = '';
  const previewTitle = document.querySelector('#wsPreviewTitle') as HTMLElement;
  const previewContent = document.querySelector('#wsPreviewContent') as HTMLElement;

  if (previewTitle) previewTitle.textContent = previewFile.name;

  if (previewContent) {
    const escaped = escapeHtml(previewFile.content);
    const lines = escaped.split('\n');
    const numbered = lines.map((line, i) =>
      `<span class="ws-preview-line"><span class="ws-line-num">${i + 1}</span>${line}</span>`
    ).join('\n');
    previewContent.innerHTML = `<pre class="ws-preview-pre">${numbered}</pre>`;
  }
}

function updateStopBtnState(): void {
  const stopBtn = document.querySelector('#wsStopBtn') as HTMLButtonElement;
  if (!stopBtn) return;
  const running = currentAiCommand !== null;
  stopBtn.disabled = !running;
  stopBtn.classList.toggle('active', running);
}

function updateHint(): void {
  const hint = document.querySelector('#wsTermHint') as HTMLElement;
  if (!hint) return;
  if (currentAiCommand) {
    hint.textContent = `⏳ AI 正在执行: ${currentAiCommand.slice(0, 40)}${currentAiCommand.length > 40 ? '...' : ''}`;
    hint.classList.add('running');
  } else {
    hint.textContent = '等待 AI 执行命令...';
    hint.classList.remove('running');
  }
}

// ── 工具函数 ──
function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const iconMap: Record<string, string> = {
    ts: '🔷', js: '🟡', json: '📋', md: '📝', txt: '📄',
    py: '🐍', rs: '🦀', go: '🔵', java: '☕', c: '📄', cpp: '📄',
    html: '🌐', css: '🎨', svg: '🖼️', png: '🖼️', jpg: '🖼️', gif: '🖼️',
    sh: '⚡', bat: '⚡', yaml: '⚙️', yml: '⚙️', toml: '⚙️',
    xml: '📋', csv: '📊', zip: '📦', tar: '📦', gz: '📦',
  };
  return iconMap[ext] || '📄';
}

// ── 工具调用管理 ──

/** 是否有命令正在终端中执行 */
function isTerminalBusy(): boolean {
  return currentAiCommand !== null || (terminal?.running ?? false);
}

/** 添加工具调用卡片（由外部调用） */
export function addToolCard(tc: ToolCallRecord): void {
  toolCards.push(tc);

  // ── 立即追加 DOM 节点，不等待全量渲染 ──
  if (activeTab === 'tools') {
    appendToolCardDOM(tc);
  }

  const isPending = tc.status === 'pending';
  if (tc.name === 'run_command') {
    // run_command：始终切到终端
    switchToTab('terminal');
  } else if (!isTerminalBusy() && !isPending) {
    // 终端空闲且非 pending 时才切到工具页签
    // pending 卡片不切换 tab（准备中不应打断当前视图）
    switchToTab('tools');
  }
  updateToolsHint();
}

/** 工具开始执行：将 pending 卡片升级为 running，或新增 running 卡片 */
export function startToolCard(tc: ToolCallRecord): void {
  // 查找是否有同名 pending 卡片（由 onToolCallPrepare 提前创建）
  const pendingIdx = toolCards.findIndex(
    c => c.name === tc.name && c.status === 'pending'
  );
  if (pendingIdx !== -1) {
    // 升级 pending → running，增量更新 DOM
    toolCards[pendingIdx] = tc;
    if (activeTab === 'tools') {
      updateToolCardDOM(tc);
    }
  } else {
    // 没有提前创建的 pending 卡片，走正常追加流程
    addToolCard(tc);
  }
  updateToolsHint();
}

/** 更新工具调用卡片状态（由外部调用）—— 增量更新 DOM，不触发全量重绘 */
export function updateToolCard(tc: ToolCallRecord): void {
  // 找到最后一个同名且 running/pending 的卡片（pending 被 onToolCallStart 更新为 running）
  for (let i = toolCards.length - 1; i >= 0; i--) {
    if (toolCards[i].name === tc.name && (toolCards[i].status === 'running' || toolCards[i].status === 'pending')) {
      toolCards[i] = tc;
      break;
    }
  }

  // 增量更新 DOM：只替换这一个卡片的 DOM 节点，保留其他卡片不动
  if (activeTab === 'tools') {
    updateToolCardDOM(tc);
  }
  updateToolsHint();
}

/** 将单个工具卡片追加到 #wsToolsOutput DOM 容器 */
function appendToolCardDOM(tc: ToolCallRecord): void {
  const container = document.querySelector('#wsToolsOutput') as HTMLElement;
  if (!container) return;

  // 首次添加卡片时清除空闲状态占位
  if (container.querySelector('.ws-idle-state')) {
    container.innerHTML = '';
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderToolCard(tc);
  const card = wrapper.firstElementChild as HTMLElement;
  if (card) {
    card.dataset.toolName = tc.name;
    container.appendChild(card);
    addToolResultHighlighting(card);
  }
  // 始终滚到底部
  scrollToolsToBottom(container);
}

/** 增量更新工具卡片 DOM 节点（找到 pending/running 状态的卡片并替换） */
function updateToolCardDOM(tc: ToolCallRecord): void {
  const container = document.querySelector('#wsToolsOutput') as HTMLElement;
  if (!container) return;

  // P1-R4 修复：同名工具并发执行时 querySelector 只返回第一个匹配，可能更新到错误的卡片。
  // 改为 querySelectorAll 查找所有同名 pending/running 卡片，取最后一个（最新的那个）更新。
  // 这与 updateToolCard 函数（行 839-853）在 JS 数组层面反向遍历找最后一个 running/pending 的逻辑一致。
  const escapedName = escapeAttr(tc.name);
  const allRunningCards = Array.from(container.querySelectorAll(
    `.tool-call-card[data-tool-name="${escapedName}"].tool-call-running,` +
    `.tool-call-card[data-tool-name="${escapedName}"].tool-call-pending`
  )) as HTMLElement[];
  const runningCard = allRunningCards.length > 0 ? allRunningCards[allRunningCards.length - 1] : null;

  if (runningCard) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderToolCard(tc);
    const newCard = wrapper.firstElementChild as HTMLElement;
    if (newCard) {
      newCard.dataset.toolName = tc.name;
      runningCard.replaceWith(newCard);
      addToolResultHighlighting(newCard);
      // 卡片内容变化后可能变高（如出现执行结果），跟随滚动
      scrollToolsToBottom(container);
    }
  } else {
    // running 卡片不在 DOM 中（可能是 tab 切换后再切回或其他边缘情况）
    // 回退：追加新卡片
    appendToolCardDOM(tc);
  }
}

/** 工具页签滚动到底部（双重 rAF 保证布局完成） */
function scrollToolsToBottom(container: HTMLElement): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  });
}

/** CSS.escape 回退（兼容旧 Electron） */
function escapeAttr(value: string): string {
  try { return CSS.escape(value); } catch { return value.replace(/["\\]/g, '\\$&'); }
}

function clearToolCards(): void {
  toolCards = [];
  if (activeTab === 'tools') {
    renderToolCalls();
  }
  updateToolsHint();
}

function updateToolsHint(): void {
  const hint = document.querySelector('#wsToolsHint') as HTMLElement;
  if (!hint) return;
  if (toolCards.length === 0) {
    hint.textContent = '等待工具调用...';
    hint.classList.remove('running');
    return;
  }

  const byStatus: Record<string, string[]> = {};
  for (const tc of toolCards) {
    const name = getToolDisplayName(tc.name);
    if (!byStatus[tc.status]) byStatus[tc.status] = [];
    byStatus[tc.status].push(name);
  }

  const parts: string[] = [];
  const order = ['pending', 'running', 'success', 'error', 'cancelled'];
  const icons: Record<string, string> = {
    pending: '📝', running: '🔄', success: '✅', error: '❌', cancelled: '🚫'
  };
  for (const s of order) {
    if (byStatus[s]?.length) {
      parts.push(`${icons[s] || ''} ${byStatus[s].join(', ')}`);
    }
  }

  hint.textContent = parts.join('  ·  ');
  hint.classList.toggle('running', !!(byStatus.pending || byStatus.running));
}

function renderToolCalls(): void {
  const container = document.querySelector('#wsToolsOutput') as HTMLElement;
  if (!container) return;

  if (toolCards.length === 0) {
    container.innerHTML = `
      <div class="ws-idle-state">
        <div class="ws-idle-icon-grid">
          <div class="ws-idle-icon-item" title="文件系统"><span>📄</span><small>文件</small></div>
          <div class="ws-idle-icon-item" title="系统命令"><span>💻</span><small>命令</small></div>
          <div class="ws-idle-icon-item" title="联网搜索"><span>🔍</span><small>搜索</small></div>
          <div class="ws-idle-icon-item" title="浏览器"><span>🌐</span><small>浏览器</small></div>
          <div class="ws-idle-icon-item" title="Git"><span>🔖</span><small>Git</small></div>
          <div class="ws-idle-icon-item" title="记忆"><span>🧠</span><small>记忆</small></div>
          <div class="ws-idle-icon-item" title="技能"><span>🎯</span><small>技能</small></div>
          <div class="ws-idle-icon-item" title="子代理"><span>🤖</span><small>代理</small></div>
        </div>
        <div class="ws-idle-divider"></div>
        <div class="ws-idle-desc">AI 对话中自动调用工具，结果在此展示</div>
        <div class="ws-idle-hint">共 ${getEnabledToolDefinitions().length} 个内置工具 · MCP 动态扩展</div>
      </div>
    `;
    return;
  }

  let html = '';
  for (const tc of toolCards) {
    html += renderToolCard(tc);
  }
  container.innerHTML = html;
  scrollToolsToBottom(container);
}

function getToolDisplayName(name: string): string {
  const names: Record<string, string> = {
    read_file: '读取文件', write_file: '写入文件', list_directory: '列出目录',
    search_files: '搜索文件', delete_file: '删除文件', run_command: '执行命令',
    file_transfer: '复制/移动', web_fetch: '网页抓取',
    edit_file: '编辑文件', download_file: '下载文件',
    git: 'Git 操作', compress: '压缩/解压', web_search: '联网搜索',
    memory: '记忆管理', diff: '文件差异',
    session: '会话读取', spawn_task: '子代理委派',
    browser: '浏览器控制',
  };
  return names[name] || name;
}

function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    read_file: '📄', write_file: '✏️', list_directory: '📁',
    search_files: '🔍', delete_file: '🗑️', run_command: '💻',
    file_transfer: '📦', web_fetch: '🌐',
    edit_file: '✂️', download_file: '⬇️',
    git: '🔖', compress: '🗜️', web_search: '🔍',
    memory: '🧠', diff: '🔍',
    session: '📖', spawn_task: '🤖',
    browser: '🌐',
  };
  return icons[name] || '🔧';
}

function renderToolCard(tc: ToolCallRecord): string {
  const icon = getToolIcon(tc.name);
  const name = getToolDisplayName(tc.name);
  const statusClass = tc.status === 'running' ? 'tool-call-running'
    : tc.status === 'pending' ? 'tool-call-pending'
    : tc.status === 'error' ? 'tool-call-error'
    : tc.status === 'success' ? 'tool-call-success'
    : tc.status === 'cancelled' ? 'tool-call-cancelled'
    : '';
  const statusLabels: Record<string, string> = {
    pending: '📝 准备中…', running: '🔄 执行中', success: '✅ 完成', error: '❌ 失败', cancelled: '🚫 已取消'
  };
  const status = statusLabels[tc.status] || tc.status;
  const args = tc.arguments || {};

  let paramsHtml = '';
  if (args.path) paramsHtml += `<div class="tool-param">路径: <code>${escapeHtml(String(args.path))}</code></div>`;
  if (args.command) paramsHtml += `<div class="tool-param">命令: <code>${escapeHtml(String(args.command))}</code></div>`;
  if (args.query) paramsHtml += `<div class="tool-param">查询: <code>${escapeHtml(String(args.query))}</code></div>`;
  if (args.url) paramsHtml += `<div class="tool-param">URL: <code>${escapeHtml(String(args.url))}</code></div>`;
  if (args.source) paramsHtml += `<div class="tool-param">源: <code>${escapeHtml(String(args.source))}</code></div>`;
  if (args.destination) paramsHtml += `<div class="tool-param">目标: <code>${escapeHtml(String(args.destination))}</code></div>`;
  if (args.selector) paramsHtml += `<div class="tool-param">选择器: <code>${escapeHtml(String(args.selector))}</code></div>`;
  if (args.action) paramsHtml += `<div class="tool-param">操作: <code>${escapeHtml(String(args.action))}</code></div>`;

  let resultHtml = '';
  if (tc.result) {
    const r = tc.result as Record<string, unknown>;
    if (r.success) {
      if (tc.name === 'run_command') {
        const stdout = String(r.stdout || '').slice(0, 500);
        const stderr = String(r.stderr || '').slice(0, 300);
        if (stdout) resultHtml += `<pre class="tool-result-content">${escapeHtml(stdout)}${String(r.stdout || '').length > 500 ? '\n...' : ''}</pre>`;
        if (stderr) resultHtml += `<pre class="tool-result-content tool-result-stderr">${escapeHtml(stderr)}</pre>`;
        resultHtml += `<div class="tool-result-meta">exit: ${r.exitCode || 0}</div>`;
      } else if (tc.name === 'web_search' && r.results) {
        const results = r.results as Array<{ title: string; url: string }>;
        resultHtml = results.slice(0, 5).map((item, i) =>
          `<div class="tool-result-entry">[${i + 1}] ${escapeHtml(item.title)}<br><code>${escapeHtml(item.url)}</code></div>`
        ).join('');
        resultHtml += `<div class="tool-result-meta">共 ${r.total || results.length} 条结果</div>`;
      } else if (tc.name === 'read_file' && r.content) {
        const content = String(r.content);
        const lines = content.split('\n');
        const preview = lines.slice(0, 15).join('\n');
        resultHtml = `<pre class="tool-result-content">${escapeHtml(preview)}${lines.length > 15 ? `\n... (共 ${lines.length} 行)` : ''}</pre>`;
      } else if (tc.name === 'list_directory' && r.entries) {
        const entries = r.entries as Array<{ name: string; type: string }>;
        resultHtml = entries.slice(0, 20).map(e =>
          `<div class="tool-result-entry">${e.type === 'directory' ? '📁' : '📄'} ${escapeHtml(e.name)}</div>`
        ).join('');
        if (entries.length > 20) resultHtml += `<div class="tool-result-entry">... 共 ${entries.length} 项</div>`;
      } else if (tc.name === 'write_file') {
        resultHtml = `<div class="tool-result-entry">✅ 已写入 ${escapeHtml(String(r.path || ''))}</div>`;
      } else if (tc.name === 'delete_file') {
        if (r.batch) {
          resultHtml = `<div class="tool-result-entry">✅ 批量删除 ${r.successCount}/${r.totalPaths} 个路径</div>`;
          if (Array.isArray(r.results)) {
            for (const res of r.results) {
              resultHtml += `<div class="tool-result-entry">${res.success ? '✅' : '❌'} ${escapeHtml(String(res.path || ''))}${res.success ? '' : ' — ' + escapeHtml(String(res.error || ''))}</div>`;
            }
          }
        } else {
          resultHtml = `<div class="tool-result-entry">✅ 已删除 ${escapeHtml(String(r.path || ''))}</div>`;
        }
      } else if (tc.name === 'file_transfer') {
        resultHtml = `<div class="tool-result-entry">✅ ${escapeHtml(String(r.source || ''))} → ${escapeHtml(String(r.destination || ''))}</div>`;
      } else {
        // P2-1: 通用成功显示，统一截断到 500 字符
        const maxResultChars = 500;
        const raw = JSON.stringify(r);
        const summary = raw.length > maxResultChars ? raw.slice(0, maxResultChars) : raw;
        resultHtml = `<pre class="tool-result-content">${escapeHtml(summary)}${raw.length > maxResultChars ? `\n... (${raw.length - maxResultChars} 字符已截断)` : ''}</pre>`;
      }
    } else {
      resultHtml = `<div class="tool-result-error">${escapeHtml(String(r.error || '未知错误'))}</div>`;
    }
  }

  return `<div class="tool-call-card ${statusClass}" data-tool-name="${escapeHtml(tc.name)}">
    <div class="tool-call-header">
      <span class="tool-call-icon">${icon}</span>
      <span class="tool-call-name">${escapeHtml(name)}</span>
      <span class="tool-call-status">${status}</span>
    </div>
    ${paramsHtml ? `<div class="tool-call-params">${paramsHtml}</div>` : ''}
    ${resultHtml ? `<div class="tool-call-result">${resultHtml}</div>` : ''}
  </div>`;
}

// ── 外部调用接口 ──

/** 获取工作空间目录 */
export function getWorkspaceDirPath(): string {
  return getSharedWorkspaceDirPath();
}

/** 外部自动切换 tab */
export function switchToTab(tab: 'terminal' | 'tools' | 'files'): void {
  activeTab = tab;
  renderPanel();
}

/** 检查工作空间是否有 pending 或 running 的工具卡片 */
export function hasActiveCards(): boolean {
  return toolCards.some(c => c.status === 'pending' || c.status === 'running');
}

/** 在工具页签显示工作提示（AI 正在处理中，但还没有具体的工具调用） */
export function showWorkingHint(text: string): void {
  // 只在工具页签空闲时显示提示，避免覆盖已有的工具卡片
  if (hasActiveCards()) return;
  if (activeTab !== 'tools') return;
  const hint = document.querySelector('#wsToolsHint') as HTMLElement;
  if (hint) {
    hint.textContent = text;
    hint.classList.add('running');
  }
}

/** 清除工作提示，恢复显示 updateToolsHint */
export function clearWorkingHint(): void {
  updateToolsHint();
}

