/**
 * Workspace Panel — 右侧工作空间面板
 * 包含命令行和文件两个 Tab
 */

import { logInfo, logError, logDebug } from '../services/log-service.js';

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
let activeTab: 'terminal' | 'files' = 'terminal';
let terminalSessions: TerminalSession[] = [];
let activeTerminalId = '';
let workspaceDir = '';
let currentFileDir = '';
let fileTree: FileNode[] = [];
let previewFile: { name: string; content: string; path: string } | null = null;
let _counter = 0;

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ansiToHtml(raw: string): string {
  // 先转义 HTML
  let text = escapeHtml(raw);

  // 处理 ANSI 转义序列
  // \x1b[XXm 颜色, \x1b[0m 重置, \x1b[1m 加粗, \x1b[K 清除行尾
  let result = '';
  let openSpan = false;
  let i = 0;

  while (i < text.length) {
    // 匹配 \x1b[...m 或 \x1b[...K
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i + 2);
      const endK = text.indexOf('K', i + 2);
      const seqEnd = end !== -1 && (endK === -1 || end < endK) ? end : endK;

      if (seqEnd !== -1 && seqEnd - i < 20) {
        const codes = text.substring(i + 2, seqEnd).split(';');

        // 忽略 \x1b[K (清除行)
        if (text[seqEnd] === 'K') {
          i = seqEnd + 1;
          continue;
        }

        if (openSpan) {
          result += '</span>';
          openSpan = false;
        }

        // 检查是否有颜色代码
        let color = '';
        let bold = false;
        for (const code of codes) {
          if (code === '0' || code === '') {
            // reset
          } else if (code === '1') {
            bold = true;
          } else if (ANSI_COLORS[code]) {
            color = ANSI_COLORS[code];
          }
        }

        if (color || bold) {
          const styles: string[] = [];
          if (color) styles.push(`color:${color}`);
          if (bold) styles.push('font-weight:bold');
          result += `<span style="${styles.join(';')}">`;
          openSpan = true;
        }

        i = seqEnd + 1;
        continue;
      }
    }

    // 处理回车符（ollama pull 等用 \r 更新进度）
    if (text[i] === '\r' && text[i + 1] !== '\n') {
      // \r 后面不是 \n → 进度更新，忽略之前的内容
      // 找到上一个 \n 或开头
      const lastNewline = result.lastIndexOf('\n');
      if (lastNewline !== -1) {
        result = result.substring(0, lastNewline + 1);
      } else {
        // 清除当前行（通过移除到最后一个 <span> 之后的内容太复杂，简化处理）
        const spanStart = result.lastIndexOf('><');
        if (spanStart !== -1) {
          // 不处理，保留
        }
      }
      i++;
      continue;
    }

    result += text[i];
    i++;
  }

  if (openSpan) result += '</span>';
  return result;
}

// ── 初始化 ──
export async function initWorkspacePanel(): Promise<void> {
  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) {
    logDebug('非桌面环境，跳过工作空间面板初始化');
    return;
  }

  // 获取工作空间目录
  try {
    const dirInfo = await bridge.workspace.getDir();
    workspaceDir = dirInfo.dir;
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

  // 绑定 UI 事件
  bindEvents();

  // 创建默认终端
  createTerminalSession('终端 1');

  logInfo('工作空间面板已初始化');
}

function bindEvents(): void {
  // Tab 切换
  document.querySelector('#wsTabTerminal')?.addEventListener('click', () => switchTab('terminal'));
  document.querySelector('#wsTabFiles')?.addEventListener('click', () => switchTab('files'));

  // 终端输入
  const termInput = document.querySelector('#wsTermInput') as HTMLInputElement;
  termInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = termInput.value.trim();
      if (cmd) {
        executeCommand(cmd);
        termInput.value = '';
      }
    }
  });

  // 执行按钮
  document.querySelector('#wsExecBtn')?.addEventListener('click', () => {
    const cmd = termInput?.value.trim();
    if (cmd) {
      executeCommand(cmd);
      termInput.value = '';
    }
  });

  // 停止按钮
  document.querySelector('#wsStopBtn')?.addEventListener('click', killCurrentProcess);

  // 清空按钮
  document.querySelector('#wsClearBtn')?.addEventListener('click', clearTerminal);

  // 新建终端 Tab
  document.querySelector('#wsNewTabBtn')?.addEventListener('click', () => {
    const num = terminalSessions.length + 1;
    createTerminalSession(`终端 ${num}`);
  });

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
function switchTab(tab: 'terminal' | 'files'): void {
  activeTab = tab;
  renderPanel();

  if (tab === 'files') {
    loadFiles(currentFileDir || workspaceDir);
  }
}

// ── 终端管理 ──
function createTerminalSession(title: string): string {
  const session: TerminalSession = {
    id: genId(),
    title,
    lines: [],
    running: false,
    autoScroll: true
  };
  terminalSessions.push(session);
  activeTerminalId = session.id;
  renderPanel();
  return session.id;
}

function getActiveSession(): TerminalSession | undefined {
  return terminalSessions.find(s => s.id === activeTerminalId);
}

function executeCommand(command: string): void {
  const session = getActiveSession();
  if (!session) {
    logError('工作空间执行失败', '无活跃终端会话');
    return;
  }

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) {
    logError('工作空间执行失败', '非桌面环境');
    return;
  }

  // 显示命令
  session.lines.push({ type: 'system', text: `$ ${command}` });
  session.running = true;
  session.autoScroll = true;

  renderTerminal();

  const cwd = currentFileDir || workspaceDir;
  logInfo('工作空间执行命令', `ID: ${session.id} | ${command.slice(0, 100)} | cwd: ${cwd}`);
  bridge.workspace.exec({ id: session.id, command, cwd });
}

function appendTerminalOutput(sessionId: string, type: 'stdout' | 'stderr', data: string): void {
  const session = terminalSessions.find(s => s.id === sessionId);
  if (!session) {
    logDebug('工作空间输出丢失', `未找到会话: ${sessionId}`);
    return;
  }

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

  // 限制最大行数
  if (session.lines.length > 3000) {
    session.lines = session.lines.slice(-2000);
  }

  renderTerminal();
}

function handleProcessExit(sessionId: string, code: number | null): void {
  const session = terminalSessions.find(s => s.id === sessionId);
  if (!session) {
    logDebug('工作空间退出信号丢失', `未找到会话: ${sessionId}`);
    return;
  }

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
  if (!session || !session.running) return;

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) return;

  bridge.workspace.kill(session.id);
  session.lines.push({ type: 'system', text: '■ 已发送终止信号' });
  renderTerminal();
}

function clearTerminal(): void {
  const session = getActiveSession();
  if (!session) return;
  session.lines = [];
  renderTerminal();
}

function closeTerminalTab(sessionId: string): void {
  if (terminalSessions.length <= 1) return; // 至少保留一个

  const session = terminalSessions.find(s => s.id === sessionId);
  if (session?.running) {
    window.metonaDesktop?.workspace.kill(sessionId);
  }

  terminalSessions = terminalSessions.filter(s => s.id !== sessionId);
  if (activeTerminalId === sessionId) {
    activeTerminalId = terminalSessions[0].id;
  }
  renderPanel();
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
  const filesTab = document.querySelector('#wsTabFiles') as HTMLElement;

  if (termTab) {
    termTab.classList.toggle('active', activeTab === 'terminal');
  }
  if (filesTab) {
    filesTab.classList.toggle('active', activeTab === 'files');
  }

  const termContent = document.querySelector('#wsTerminalContent') as HTMLElement;
  const filesContent = document.querySelector('#wsFilesContent') as HTMLElement;

  if (termContent) termContent.style.display = activeTab === 'terminal' ? '' : 'none';
  if (filesContent) filesContent.style.display = activeTab === 'files' ? '' : 'none';

  if (activeTab === 'terminal') {
    renderTerminal();
    renderTerminalTabs();
  } else {
    renderFileList();
  }

  updateStopBtnState();
}

function renderTerminal(): void {
  const container = document.querySelector('#wsTermOutput') as HTMLElement;
  if (!container) return;

  const session = getActiveSession();
  if (!session) {
    container.innerHTML = '<div class="ws-term-placeholder">无终端会话</div>';
    return;
  }

  // 使用 DocumentFragment 优化渲染
  const fragment = document.createDocumentFragment();
  const wrapper = document.createElement('div');

  for (const line of session.lines) {
    const div = document.createElement('div');
    div.className = `ws-term-line ws-term-${line.type}`;
    div.innerHTML = ansiToHtml(line.text);
    wrapper.appendChild(div);
  }

  container.innerHTML = wrapper.innerHTML;

  // 自动滚动到底部
  if (session.autoScroll) {
    container.scrollTop = container.scrollHeight;
  }

  // 监听滚动事件
  container.onscroll = () => {
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    session.autoScroll = atBottom;
  };
}

function renderTerminalTabs(): void {
  const tabBar = document.querySelector('#wsTermTabBar') as HTMLElement;
  if (!tabBar) return;

  tabBar.innerHTML = terminalSessions.map(s => {
    const active = s.id === activeTerminalId;
    const running = s.running ? ' ●' : '';
    const closeBtn = terminalSessions.length > 1
      ? `<button class="ws-tab-close" data-close="${s.id}" title="关闭">✕</button>`
      : '';
    return `<div class="ws-tab ${active ? 'active' : ''}" data-session="${s.id}">
      <span class="ws-tab-title">${escapeHtml(s.title)}${running}</span>
      ${closeBtn}
    </div>`;
  }).join('');

  // 绑定 tab 点击事件
  tabBar.querySelectorAll('.ws-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const closeBtn = target.closest('.ws-tab-close') as HTMLElement;
      if (closeBtn) {
        e.stopPropagation();
        closeTerminalTab(closeBtn.dataset.close!);
        return;
      }
      const sessionId = (tab as HTMLElement).dataset.session;
      if (sessionId) {
        activeTerminalId = sessionId;
        renderPanel();
      }
    });
  });
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
    container.innerHTML = '<div class="ws-file-empty">空目录</div>';
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
  const session = getActiveSession();
  const running = session?.running || false;
  stopBtn.disabled = !running;
  stopBtn.classList.toggle('active', running);
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── 外部调用接口 ──

/** 从聊天区域调用：在工作空间执行命令 */
export function execInWorkspace(command: string): void {
  // 切换到终端 tab
  activeTab = 'terminal';

  // 使用当前活跃终端或创建新的
  const session = getActiveSession();
  if (session?.running) {
    // 当前终端有进程在跑，新建一个
    const num = terminalSessions.length + 1;
    createTerminalSession(`终端 ${num}`);
  }

  renderPanel();
  executeCommand(command);
}

/** 获取工作空间目录 */
export function getWorkspaceDirPath(): string {
  return workspaceDir;
}

/** 设置工作空间目录 */
export async function setWorkspaceDirPath(dir: string): Promise<boolean> {
  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) return false;

  const result = await bridge.workspace.setDir(dir);
  if (result.success && result.dir) {
    workspaceDir = result.dir;
    currentFileDir = workspaceDir;
    logInfo('工作空间目录已更新', workspaceDir);
    return true;
  }
  return false;
}
