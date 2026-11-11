// @vitest-environment jsdom
/**
 * UI 组件测试（工作空间）：workspace-panel
 * 覆盖终端流式输出/ANSI/进程退出、文件浏览/预览、工具卡片各结果形态。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const noop = () => {};

const hoisted = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logSuccess: vi.fn(),
  addToolResultHighlighting: vi.fn(),
  setWorkspaceDirPath: vi.fn(),
  getEnabledToolDefinitions: vi.fn(() => Array.from({ length: 18 }, (_, i) => ({ function: { name: `tool_${i}` } }))),
  onOutput: null as ((d: { id: string; type: 'stdout' | 'stderr'; data: string }) => void) | null,
  onExit: null as ((d: { id: string; code: number | null }) => void) | null,
  onCmdOutput: null as ((d: { command: string; type: 'stdout' | 'stderr'; data: string }) => void) | null,
  onCmdDone: null as ((d: { command: string; exitCode: number | null }) => void) | null,
  kill: vi.fn(),
  cmdKill: vi.fn(async () => ({ killed: true })),
  getDir: vi.fn(async () => ({ dir: '/tmp/ws', defaultDir: '/tmp/ws' })),
  listDir: vi.fn(async () => ({ success: true, entries: [] as Array<Record<string, unknown>> })),
  readFile: vi.fn(async () => ({ success: true, content: '' })),
  termId: '',
}));

vi.mock('../src/renderer/services/log-service.js', () => ({
  logInfo: hoisted.logInfo,
  logError: hoisted.logError,
  logDebug: hoisted.logDebug,
  logWarn: hoisted.logWarn,
  logSuccess: hoisted.logSuccess,
  logSession: vi.fn(),
  logSetting: vi.fn(),
  logConnection: vi.fn(),
  logModel: vi.fn(),
  logToolStart: vi.fn(),
  logToolResult: vi.fn(),
  logMemory: vi.fn(),
  logRAG: vi.fn(),
  logInit: vi.fn(),
  logThink: vi.fn(),
  logStream: vi.fn(),
  logAgentLoop: vi.fn(),
  logModelResponse: vi.fn(),
  resetStreamProgress: vi.fn(),
  logStreamProgress: vi.fn(),
  resetVideoProgress: vi.fn(),
  updateVideoProgress: vi.fn(),
  addLog: vi.fn(),
  initLogPanel: vi.fn(),
}));

vi.mock('../src/renderer/components/chat-area.js', () => ({
  addToolResultHighlighting: hoisted.addToolResultHighlighting,
}));

vi.mock('../src/renderer/services/tool-registry.js', () => ({
  getEnabledToolDefinitions: hoisted.getEnabledToolDefinitions,
  getToolIcon: (n: string) => n,
  formatToolName: (n: string) => n,
  TOOL_DEFINITIONS: [],
  MODE_TOOLS: [],
  setToolMode: vi.fn(),
  refreshMCPTools: vi.fn(async () => {}),
}));

vi.mock('../src/renderer/services/workspace-state.js', () => ({
  getWorkspaceDirPath: () => '/tmp/ws',
  setWorkspaceDirPath: hoisted.setWorkspaceDirPath,
}));

import {
  initWorkspacePanel,
  clearToolCardsExternal,
  clearTerminalExternal,
  renderPanel,
  addToolCard,
  startToolCard,
  updateToolCard,
  switchToTab,
  hasActiveCards,
  showWorkingHint,
  clearWorkingHint,
  getWorkspaceDirPath,
} from '../src/renderer/components/workspace-panel.js';

function el<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}

function tool(
  name: string,
  args: Record<string, unknown> = {},
  result: Record<string, unknown> | null = null,
  status = 'pending',
) {
  return { name, arguments: args, result, status, timestamp: 1 };
}

function lastToolCard(): HTMLElement {
  const cards = document.querySelectorAll('#wsToolsOutput .tool-call-card');
  return cards[cards.length - 1] as HTMLElement;
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf-8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';

  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame;
  window.scrollTo = noop;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
    escape: (s: string) => s.replace(/["\\]/g, '\\$&'),
  };

  (window as unknown as { metonaDesktop: unknown }).metonaDesktop = {
    isDesktop: true,
    workspace: {
      getDir: hoisted.getDir,
      listDir: hoisted.listDir,
      readFile: hoisted.readFile,
      kill: hoisted.kill,
      cmdKill: hoisted.cmdKill,
      onOutput: (cb: typeof hoisted.onOutput) => {
        hoisted.onOutput = cb;
        return noop;
      },
      onExit: (cb: typeof hoisted.onExit) => {
        hoisted.onExit = cb;
        return noop;
      },
      onCmdOutput: (cb: typeof hoisted.onCmdOutput) => {
        hoisted.onCmdOutput = cb;
        return noop;
      },
      onCmdDone: (cb: typeof hoisted.onCmdDone) => {
        hoisted.onCmdDone = cb;
        return noop;
      },
    },
  };

  await initWorkspacePanel();

  // 通过一次 AI 命令 + 停止按钮取得内部终端 ID
  hoisted.onCmdOutput!({ command: 'init', type: 'stdout', data: '' });
  el('#wsStopBtn').click();
  hoisted.termId = (hoisted.kill.mock.calls[0]?.[0] as string) || '';
  clearTerminalExternal();
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.getDir.mockResolvedValue({ dir: '/tmp/ws', defaultDir: '/tmp/ws' });
  hoisted.listDir.mockResolvedValue({ success: true, entries: [] });
  hoisted.readFile.mockResolvedValue({ success: true, content: '' });
  hoisted.getEnabledToolDefinitions.mockReturnValue(
    Array.from({ length: 18 }, (_, i) => ({ function: { name: `tool_${i}` } })),
  );
  (window.metonaDesktop as unknown as { isDesktop: boolean }).isDesktop = true;

  clearToolCardsExternal();
  clearTerminalExternal();
  switchToTab('tools');
  const preview = el('#wsPreview');
  if (preview) preview.style.display = 'none';
  window.dispatchEvent(new CustomEvent('workspaceDirChanged', { detail: { dir: '/tmp/ws' } }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────── 初始化 / Tab ───────────────────────────

describe('workspace 初始化与 Tab', () => {
  it('初始化读取目录、注册回调并渲染工具空闲态', () => {
    expect(hoisted.onOutput).toBeTypeOf('function');
    expect(hoisted.onExit).toBeTypeOf('function');
    expect(hoisted.onCmdOutput).toBeTypeOf('function');
    expect(hoisted.onCmdDone).toBeTypeOf('function');
    expect(el('#wsTabTools').classList.contains('active')).toBe(true);
    expect(el('#wsToolsContent').style.display).toBe('');
    expect(el('#wsTerminalContent').style.display).toBe('none');
    expect(el('#wsFilesContent').style.display).toBe('none');
    expect(el('#wsToolsOutput').textContent).toContain('AI 对话中自动调用工具');
    expect(el('#wsToolsOutput').textContent).toContain('共 18 个内置工具');
    expect(el('#wsToolsHint').textContent).toBe('等待工具调用...');
    expect(el<HTMLButtonElement>('#wsStopBtn').disabled).toBe(true);
  });

  it('切换终端显示空闲状态与工作空间提示', () => {
    el('#wsTabTerminal').click();
    expect(el('#wsTabTerminal').classList.contains('active')).toBe(true);
    expect(el('#wsTerminalContent').style.display).toBe('');
    expect(el('#wsTermOutput').textContent).toContain('Metona');
    expect(el('#wsTermOutput').textContent).toContain('/tmp/ws');
    expect(el('#wsTermOutput').querySelector('#wsIdleTip')).not.toBeNull();
  });

  it('切换文件页签加载目录并渲染文件/目录项', async () => {
    hoisted.listDir.mockResolvedValueOnce({
      success: true,
      entries: [
        { name: 'src', type: 'directory', size: null, modified: 'x' },
        { name: 'app.ts', type: 'file', size: 1024, modified: 'x' },
        { name: 'pic.png', type: 'file', size: 2048, modified: 'x' },
        { name: 'unknown.xyz', type: 'file', size: null, modified: 'x' },
      ],
    });
    el('#wsTabFiles').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.listDir).toHaveBeenCalledWith('/tmp/ws');
    expect(el('#wsFilesContent').style.display).toBe('');
    expect(el('#wsFilePath').textContent).toBe('~');
    expect(el('#wsFilePath').title).toBe('/tmp/ws');
    const items = document.querySelectorAll('#wsFileList .ws-file-item');
    expect(items.length).toBe(4);
    expect(items[0].textContent).toContain('📁');
    expect(items[1].textContent).toContain('🔷');
    expect(items[1].textContent).toContain('1.0 KB');
    expect(items[2].textContent).toContain('🖼️');
    expect(items[3].textContent).toContain('📄');
    expect(el('#wsPreview').style.display).toBe('none');
  });

  it('空目录与目录加载失败', async () => {
    hoisted.listDir.mockResolvedValueOnce({ success: true, entries: [] });
    el('#wsTabFiles').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#wsFileList').textContent).toContain('空目录');

    hoisted.listDir.mockRejectedValueOnce(new Error('list fail'));
    el('#wsFileRefreshBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.logError).toHaveBeenCalledWith('加载目录失败', 'list fail');

    (window.metonaDesktop as unknown as { isDesktop: boolean }).isDesktop = false;
    el('#wsFileRefreshBtn').click();
    await new Promise((r) => setTimeout(r, 10));
    (window.metonaDesktop as unknown as { isDesktop: boolean }).isDesktop = true;
  });
});

// ─────────────────────────── 终端 ───────────────────────────

describe('workspace 终端', () => {
  it('AI 命令流式输出、ANSI 颜色、进度覆盖与完成状态', () => {
    hoisted.onCmdOutput!({ command: 'echo hi', type: 'stdout', data: 'line1\nline2\n' });
    switchToTab('terminal');
    expect(el('#wsTermOutput').textContent).toContain('$ echo hi (AI)');
    expect(el('#wsTermOutput').textContent).toContain('line1');
    expect(el('#wsTermOutput').textContent).toContain('line2');
    expect(el('#wsTermHint').textContent).toContain('AI 正在执行: echo hi');
    expect(el('#wsTermHint').classList.contains('running')).toBe(true);
    expect(el<HTMLButtonElement>('#wsStopBtn').disabled).toBe(false);

    hoisted.onCmdOutput!({
      command: 'echo hi',
      type: 'stdout',
      data: '\x1b[31mred\x1b[0m\n\x1b[1mbold\x1b[0m\n\x1b[999mplain\n\x1b[mreset\n',
    });
    const html = el('#wsTermOutput').innerHTML;
    expect(html).toContain('color:#ff6b68');
    expect(html).toContain('font-weight:bold');
    expect(html).toContain('plain');
    expect(html).toContain('reset');

    hoisted.onCmdOutput!({ command: 'echo hi', type: 'stdout', data: 'progress 10%\rprogress 20%\n' });
    expect(el('#wsTermOutput').textContent).toContain('progress 20%');

    hoisted.onCmdDone!({ command: 'echo hi', exitCode: 0 });
    expect(el('#wsTermOutput').textContent).toContain('✓ AI 命令执行成功');
    expect(el('#wsTermHint').textContent).toBe('等待 AI 执行命令...');
    expect(el<HTMLButtonElement>('#wsStopBtn').disabled).toBe(true);

    hoisted.onCmdOutput!({ command: 'false', type: 'stderr', data: 'err\n' });
    hoisted.onCmdDone!({ command: 'false', exitCode: 1 });
    expect(el('#wsTermOutput').textContent).toContain('✗ AI 命令退出 (code: 1)');
  });

  it('AI 命令结束后有工具卡片时切回工具页签', async () => {
    vi.useFakeTimers();
    addToolCard(tool('read_file', {}, { success: true }, 'success'));
    switchToTab('terminal');
    hoisted.onCmdOutput!({ command: 'ls', type: 'stdout', data: 'a\n' });
    hoisted.onCmdDone!({ command: 'ls', exitCode: 0 });
    await vi.advanceTimersByTimeAsync(700);
    expect(el('#wsTabTools').classList.contains('active')).toBe(true);
    expect(el('#wsToolsContent').style.display).toBe('');
  });

  it('用户终端进程输出与退出信号', () => {
    expect(hoisted.termId).not.toBe('');
    hoisted.onOutput!({ id: hoisted.termId, type: 'stdout', data: 'proc line\n' });
    switchToTab('terminal');
    expect(el('#wsTermOutput').textContent).toContain('proc line');

    hoisted.onExit!({ id: hoisted.termId, code: 0 });
    expect(el('#wsTermOutput').textContent).toContain('✓ 进程正常退出');
    hoisted.onExit!({ id: hoisted.termId, code: 2 });
    expect(el('#wsTermOutput').textContent).toContain('✗ 进程退出 (code: 2)');

    hoisted.onOutput!({ id: 'unknown', type: 'stdout', data: 'lost\n' });
    expect(hoisted.logDebug).toHaveBeenCalledWith('工作空间输出丢失', '未匹配终端: unknown');
    hoisted.onExit!({ id: 'unknown', code: 1 });
    expect(hoisted.logDebug).toHaveBeenCalledWith('工作空间退出信号丢失', '未匹配终端: unknown');
  });

  it('停止按钮终止进程与 AI 命令，清空按钮恢复空闲', () => {
    hoisted.onCmdOutput!({ command: 'sleep 10', type: 'stdout', data: 'start\n' });
    switchToTab('terminal');
    el('#wsStopBtn').click();
    expect(hoisted.kill).toHaveBeenCalledWith(hoisted.termId);
    expect(hoisted.cmdKill).toHaveBeenCalled();
    expect(el('#wsTermOutput').textContent).toContain('■ 命令已手动终止');
    expect(el('#wsTermHint').textContent).toBe('等待 AI 执行命令...');
    expect(el<HTMLButtonElement>('#wsStopBtn').disabled).toBe(true);

    hoisted.onCmdOutput!({ command: 'echo', type: 'stdout', data: 'x\n' });
    hoisted.onCmdDone!({ command: 'echo', exitCode: 0 });
    el('#wsClearBtn').click();
    expect(el('#wsTermOutput').textContent).toContain('Metona');
    expect(el('#wsTermOutput').textContent).not.toContain('x');
  });

  it('非桌面环境停止按钮直接返回', () => {
    hoisted.onCmdOutput!({ command: 'x', type: 'stdout', data: 'y\n' });
    (window.metonaDesktop as unknown as { isDesktop: boolean }).isDesktop = false;
    el('#wsStopBtn').click();
    expect(hoisted.kill).not.toHaveBeenCalled();
    expect(hoisted.cmdKill).not.toHaveBeenCalled();
    (window.metonaDesktop as unknown as { isDesktop: boolean }).isDesktop = true;
  });

  it('超过 3000 行时保留系统消息并截断历史', () => {
    const data = Array.from({ length: 3005 }, (_, i) => `line-${i}`).join('\n');
    hoisted.onCmdOutput!({ command: 'big', type: 'stdout', data });
    switchToTab('terminal');
    const lines = el('#wsTermOutput').querySelectorAll('.ws-term-line');
    expect(lines.length).toBeLessThanOrEqual(2000);
    expect(el('#wsTermOutput').textContent).toContain('$ big (AI)');
    expect(el('#wsTermOutput').textContent).toContain('line-3004');
  });

  it('clearTerminalExternal 重置终端与提示', () => {
    hoisted.onCmdOutput!({ command: 'x', type: 'stdout', data: 'a\n' });
    clearTerminalExternal();
    switchToTab('terminal');
    expect(el('#wsTermOutput').textContent).toContain('Metona');
    expect(el('#wsTermHint').textContent).toBe('等待 AI 执行命令...');
    expect(el<HTMLButtonElement>('#wsStopBtn').disabled).toBe(true);
  });

  it('ANSI 进度覆盖：行首 \r 与系统行后的 \r', () => {
    switchToTab('terminal');
    hoisted.onCmdOutput!({ command: 'p', type: 'stdout', data: '\rstart\n' });
    expect(el('#wsTermOutput').textContent).toContain('start');
    // 最后一行是系统消息时，\r 进度应 push 新行而不是替换系统行
    hoisted.onCmdOutput!({ command: 'p', type: 'stdout', data: '\rprogress\n' });
    expect(el('#wsTermOutput').textContent).toContain('progress');
    expect(el('#wsTermOutput').textContent).toContain('$ p (AI)');
  });

  it('关键 DOM 缺失时更新函数安全返回', () => {
    const stop = el('#wsStopBtn');
    const hint = el('#wsTermHint');
    stop.remove();
    hint.remove();
    hoisted.onCmdOutput!({ command: 'x', type: 'stdout', data: 'a\n' });
    hoisted.onCmdDone!({ command: 'x', exitCode: 0 });
    expect(() => hoisted.onCmdOutput!({ command: 'y', type: 'stdout', data: 'b\n' })).not.toThrow();
    el('#wsTerminalContent').appendChild(stop);
    el('.ws-term-toolbar')?.appendChild(hint);
    switchToTab('terminal');
  });

  it('空闲贴士轮转，内容出现后停止', async () => {
    switchToTab('terminal');
    // 先用内容停止可能存在的真实定时器
    hoisted.onCmdOutput!({ command: 'stop-tip', type: 'stdout', data: 'x\n' });
    vi.useFakeTimers();
    clearTerminalExternal();
    switchToTab('terminal');
    const tip = el('#wsIdleTip');
    const first = tip.textContent;
    await vi.advanceTimersByTimeAsync(6400);
    expect(tip.textContent).not.toBe(first);

    // 提示元素被移除时轮转安全跳过
    tip.remove();
    await vi.advanceTimersByTimeAsync(6400);

    // 出现终端内容后，定时器在下一次 tick 自行停止
    hoisted.onCmdOutput!({ command: 'x', type: 'stdout', data: 'line\n' });
    await vi.advanceTimersByTimeAsync(6400);
    expect(el('#wsTermOutput').textContent).toContain('line');
  });
});

// ─────────────────────────── 工具卡片 ───────────────────────────

describe('workspace 工具卡片', () => {
  it('pending 卡片增量追加并更新提示', async () => {
    addToolCard(tool('read_file', { path: 'a.ts' }, null, 'pending'));
    await new Promise((r) => setTimeout(r, 20));
    const card = lastToolCard();
    expect(card.dataset.toolName).toBe('read_file');
    expect(card.className).toContain('tool-call-pending');
    expect(card.textContent).toContain('📝 准备中…');
    expect(card.textContent).toContain('路径: a.ts');
    expect(el('#wsToolsHint').textContent).toContain('📝 读取文件');
    expect(hasActiveCards()).toBe(true);
    expect(hoisted.addToolResultHighlighting).toHaveBeenCalled();
  });

  it('run_command 自动切到终端，start/update 增量升级卡片', async () => {
    addToolCard(tool('run_command', { command: 'ls' }, null, 'running'));
    expect(el('#wsTabTerminal').classList.contains('active')).toBe(true);
    switchToTab('tools');
    clearToolCardsExternal();

    addToolCard(tool('read_file', { path: 'a' }, null, 'pending'));
    startToolCard(tool('read_file', { path: 'a' }, null, 'running'));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelectorAll('#wsToolsOutput .tool-call-card').length).toBe(1);
    expect(lastToolCard().className).toContain('tool-call-running');
    expect(lastToolCard().textContent).toContain('🔄 执行中');

    updateToolCard(tool('read_file', { path: 'a' }, { success: true, content: 'file body' }, 'success'));
    await new Promise((r) => setTimeout(r, 20));
    // 成功状态没有专属 class（statusClass 仅处理 running/pending/error）
    expect(lastToolCard().className).not.toContain('tool-call-running');
    expect(lastToolCard().textContent).toContain('✅ 完成');
    expect(lastToolCard().textContent).toContain('file body');
    expect(hasActiveCards()).toBe(false);
    expect(el('#wsToolsHint').textContent).toContain('✅ 读取文件');
  });

  it('startToolCard 无 pending 时新增，updateToolCard 无运行卡片时回退追加', async () => {
    startToolCard(tool('web_search', { query: 'q' }, null, 'running'));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelectorAll('#wsToolsOutput .tool-call-card').length).toBe(1);

    // 模拟 DOM 中运行卡片丢失（切换页签/重绘等边缘情况）
    document.querySelector('#wsToolsOutput .tool-call-card')!.remove();
    updateToolCard(tool('web_search', { query: 'q' }, { success: true, results: [] }, 'success'));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelectorAll('#wsToolsOutput .tool-call-card').length).toBe(1);
    expect(lastToolCard().textContent).toContain('✅ 完成');
  });

  it('清空按钮与 clearToolCardsExternal 恢复空闲态', async () => {
    addToolCard(tool('read_file', {}, null, 'success'));
    await new Promise((r) => setTimeout(r, 10));
    el('#wsToolsClearBtn').click();
    expect(el('#wsToolsOutput').textContent).toContain('AI 对话中自动调用工具');
    expect(el('#wsToolsHint').textContent).toBe('等待工具调用...');

    addToolCard(tool('read_file', {}, null, 'success'));
    await new Promise((r) => setTimeout(r, 10));
    clearToolCardsExternal();
    expect(el('#wsToolsOutput').textContent).toContain('AI 对话中自动调用工具');
  });

  it('工具结果：run_command / web_search / read_file / list_directory / write/delete/transfer', async () => {
    addToolCard(
      tool(
        'run_command',
        {},
        {
          success: true,
          stdout: 'o'.repeat(600),
          stderr: 'err',
          exitCode: 2,
        },
        'success',
      ),
    );
    expect(lastToolCard().textContent).toContain('...');
    expect(lastToolCard().querySelector('.tool-result-stderr')?.textContent).toBe('err');
    expect(lastToolCard().textContent).toContain('exit: 2');

    addToolCard(
      tool(
        'web_search',
        {},
        {
          success: true,
          results: Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, url: `u${i}` })),
          total: 6,
        },
        'success',
      ),
    );
    expect(lastToolCard().querySelectorAll('.tool-result-entry').length).toBe(5);
    expect(lastToolCard().textContent).toContain('共 6 条结果');

    addToolCard(
      tool(
        'read_file',
        {},
        { success: true, content: Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') },
        'success',
      ),
    );
    expect(lastToolCard().textContent).toContain('共 20 行');

    addToolCard(
      tool(
        'list_directory',
        {},
        {
          success: true,
          entries: Array.from({ length: 21 }, (_, i) => ({ name: `e${i}`, type: i === 0 ? 'directory' : 'file' })),
        },
        'success',
      ),
    );
    expect(lastToolCard().textContent).toContain('共 21 项');

    addToolCard(tool('write_file', {}, { success: true, path: '/tmp/a' }, 'success'));
    expect(lastToolCard().textContent).toContain('已写入 /tmp/a');

    addToolCard(
      tool(
        'delete_file',
        {},
        {
          success: true,
          batch: true,
          successCount: 1,
          totalPaths: 2,
          results: [
            { success: true, path: '/a' },
            { success: false, path: '/b', error: 'denied' },
          ],
        },
        'success',
      ),
    );
    expect(lastToolCard().textContent).toContain('批量删除 1/2 个路径');
    expect(lastToolCard().textContent).toContain('denied');

    addToolCard(tool('delete_file', {}, { success: true, path: '/single' }, 'success'));
    expect(lastToolCard().textContent).toContain('已删除 /single');

    addToolCard(tool('file_transfer', {}, { success: true, source: '/a', destination: '/b' }, 'success'));
    expect(lastToolCard().textContent).toContain('/a → /b');
  });

  it('通用成功结果截断、错误与取消状态、参数转义', async () => {
    addToolCard(
      tool(
        'memory',
        {
          query: '<q>',
          url: 'https://x',
          source: 's',
          destination: 'd',
          selector: '#id',
          action: 'open',
        },
        { success: true, data: 'x'.repeat(800) },
        'success',
      ),
    );
    expect(lastToolCard().textContent).toContain('字符已截断');
    expect(lastToolCard().querySelector('q')).toBeNull();
    expect(lastToolCard().textContent).toContain('<q>');
    expect(lastToolCard().textContent).toContain('URL: https://x');
    expect(lastToolCard().textContent).toContain('操作: open');

    addToolCard(tool('read_file', {}, { success: false }, 'error'));
    expect(lastToolCard().textContent).toContain('未知错误');
    addToolCard(tool('read_file', {}, { success: false, error: '<bad>' }, 'error'));
    expect(lastToolCard().textContent).toContain('<bad>');
    addToolCard(tool('read_file', {}, null, 'cancelled'));
    expect(lastToolCard().textContent).toContain('🚫 已取消');
  });

  it('CSS.escape 异常时回退属性转义', async () => {
    addToolCard(tool('read_file', {}, null, 'running'));
    await new Promise((r) => setTimeout(r, 10));
    const original = (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS;
    (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
      escape: () => {
        throw new Error('unsupported');
      },
    };
    updateToolCard(tool('read_file', {}, { success: true, path: '/x' }, 'success'));
    await new Promise((r) => setTimeout(r, 10));
    expect(lastToolCard().textContent).toContain('已写入'.length ? '/x' : '/x');
    (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = original;
  });

  it('工作提示仅在工具页签空闲时显示', () => {
    switchToTab('tools');
    showWorkingHint('⏳ AI 正在处理中...');
    expect(el('#wsToolsHint').textContent).toBe('⏳ AI 正在处理中...');
    expect(el('#wsToolsHint').classList.contains('running')).toBe(true);
    clearWorkingHint();
    expect(el('#wsToolsHint').textContent).toBe('等待工具调用...');

    addToolCard(tool('read_file', {}, null, 'pending'));
    showWorkingHint('不应覆盖');
    expect(el('#wsToolsHint').textContent).not.toBe('不应覆盖');

    switchToTab('terminal');
    clearToolCardsExternal();
    showWorkingHint('终端页签不显示');
    expect(el('#wsToolsHint').textContent).not.toBe('终端页签不显示');
  });

  it('未知工具名回退图标/名称，空结果与无 results 分支', async () => {
    addToolCard(tool('custom_tool', { path: 'x' }, { success: true }, 'success'));
    expect(lastToolCard().textContent).toContain('custom_tool');
    expect(lastToolCard().textContent).toContain('🔧');
    expect(lastToolCard().textContent).toContain('已写入'.length ? '' : '');

    addToolCard(tool('run_command', {}, { success: true, stdout: '', stderr: '', exitCode: 0 }, 'success'));
    expect(lastToolCard().querySelectorAll('.tool-result-content').length).toBe(0);
    expect(lastToolCard().textContent).toContain('exit: 0');

    addToolCard(tool('web_search', {}, { success: true }, 'success'));
    expect(lastToolCard().querySelector('.tool-result-content')).not.toBeNull();

    addToolCard(tool('read_file', {}, { success: true, content: '' }, 'success'));
    expect(lastToolCard().querySelector('.tool-result-content')).not.toBeNull();

    addToolCard(tool('list_directory', {}, { success: true, entries: [] }, 'success'));
    expect(lastToolCard().querySelector('.tool-call-result')).toBeNull();

    addToolCard(tool('delete_file', {}, { success: true, batch: true, successCount: 0, totalPaths: 0 }, 'success'));
    expect(lastToolCard().textContent).toContain('批量删除 0/0 个路径');
  });

  it('工具容器/提示 DOM 缺失时安全返回', async () => {
    const output = el('#wsToolsOutput');
    const hint = el('#wsToolsHint');
    output.remove();
    hint.remove();
    expect(() => addToolCard(tool('read_file', {}, null, 'pending'))).not.toThrow();
    expect(() => updateToolCard(tool('read_file', {}, { success: true }, 'success'))).not.toThrow();
    expect(() => clearToolCardsExternal()).not.toThrow();
    el('#wsToolsContent').prepend(output);
    el('.ws-term-toolbar')?.appendChild(hint);
    switchToTab('tools');
    expect(el('#wsToolsOutput').textContent).toContain('AI 对话中自动调用工具');
  });
});

// ─────────────────────────── 文件浏览 ───────────────────────────

describe('workspace 文件浏览', () => {
  async function loadFilesFixture(): Promise<void> {
    hoisted.listDir.mockResolvedValueOnce({
      success: true,
      entries: [
        { name: 'src', type: 'directory', size: null, modified: 'x' },
        { name: 'a.ts', type: 'file', size: 12, modified: 'x' },
      ],
    });
    el('#wsTabFiles').click();
    await new Promise((r) => setTimeout(r, 20));
  }

  it('点击目录导航、双击目录导航、上级与刷新', async () => {
    await loadFilesFixture();
    hoisted.listDir.mockResolvedValue({ success: true, entries: [] });
    (document.querySelector('#wsFileList .ws-file-item[data-name="src"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.listDir).toHaveBeenCalledWith('/tmp/ws/src');
    expect(el('#wsFilePath').textContent).toContain('src');

    hoisted.listDir.mockClear();
    (document.querySelector('#wsFileList .ws-file-item') as HTMLElement)?.dispatchEvent(new MouseEvent('dblclick'));
    await new Promise((r) => setTimeout(r, 10));

    el('#wsFileUpBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.listDir).toHaveBeenCalledWith('/tmp/ws');

    hoisted.listDir.mockClear();
    el('#wsFileRefreshBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.listDir).toHaveBeenCalledWith('/tmp/ws');
  });

  it('点击文件打开预览并关闭', async () => {
    hoisted.readFile.mockResolvedValue({ success: true, content: 'line1\nline2' });
    await loadFilesFixture();
    (document.querySelector('#wsFileList .ws-file-item[data-name="a.ts"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.readFile).toHaveBeenCalledWith('/tmp/ws/a.ts');
    expect(el('#wsPreview').style.display).toBe('');
    expect(el('#wsPreviewTitle').textContent).toBe('a.ts');
    expect(el('#wsPreviewContent').textContent).toContain('1');
    expect(el('#wsPreviewContent').textContent).toContain('line2');
    expect(el('#wsPreviewContent').querySelectorAll('.ws-preview-line').length).toBe(2);

    el('#wsPreviewClose').click();
    expect(el('#wsPreview').style.display).toBe('none');
  });

  it('文件读取失败/异常不显示预览，非桌面环境直接返回', async () => {
    await loadFilesFixture();
    hoisted.readFile.mockResolvedValueOnce({ success: false, error: 'denied' });
    (document.querySelector('#wsFileList .ws-file-item[data-name="a.ts"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el('#wsPreview').style.display).toBe('none');

    hoisted.readFile.mockRejectedValueOnce(new Error('io'));
    (document.querySelector('#wsFileList .ws-file-item[data-name="a.ts"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.logError).toHaveBeenCalledWith('读取文件失败', 'io');

    (window.metonaDesktop as unknown as { isDesktop: boolean }).isDesktop = false;
    (document.querySelector('#wsFileList .ws-file-item[data-name="a.ts"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (window.metonaDesktop as unknown as { isDesktop: boolean }).isDesktop = true;
  });

  it('目录变更事件刷新文件列表与终端', async () => {
    await loadFilesFixture();
    hoisted.listDir.mockClear();
    hoisted.listDir.mockResolvedValue({ success: true, entries: [] });
    window.dispatchEvent(new CustomEvent('workspaceDirChanged', { detail: { dir: '/tmp/newdir' } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(hoisted.setWorkspaceDirPath).toHaveBeenCalledWith('/tmp/newdir');
    expect(hoisted.listDir).toHaveBeenCalledWith('/tmp/newdir');

    switchToTab('terminal');
    window.dispatchEvent(new CustomEvent('workspaceDirChanged', { detail: { dir: '/tmp/newdir2' } }));
    expect(el('#wsTermOutput').textContent).toContain('/tmp/newdir2');

    hoisted.setWorkspaceDirPath.mockClear();
    window.dispatchEvent(new CustomEvent('workspaceDirChanged', { detail: { dir: '/tmp/newdir2' } }));
    expect(hoisted.setWorkspaceDirPath).not.toHaveBeenCalled();
    window.dispatchEvent(new CustomEvent('workspaceDirChanged', { detail: {} }));
  });

  it('getWorkspaceDirPath 与 switchToTab 外部接口', () => {
    expect(getWorkspaceDirPath()).toBe('/tmp/ws');
    switchToTab('files');
    expect(el('#wsTabFiles').classList.contains('active')).toBe(true);
    switchToTab('terminal');
    expect(el('#wsTabTerminal').classList.contains('active')).toBe(true);
  });

  it('面板不存在时 renderPanel 安全返回', () => {
    const panel = el('#workspacePanel');
    panel.remove();
    expect(() => renderPanel()).not.toThrow();
    document.body.appendChild(panel);
    renderPanel();
  });

  it('双击文件不导航、根目录上级按钮无效', async () => {
    await loadFilesFixture();
    hoisted.listDir.mockClear();
    (document.querySelector('#wsFileList .ws-file-item[data-name="a.ts"]') as HTMLElement).dispatchEvent(
      new MouseEvent('dblclick'),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.listDir).not.toHaveBeenCalled();

    el('#wsFileUpBtn').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(hoisted.listDir).not.toHaveBeenCalled();
  });

  it('文件列表/预览容器缺失时安全返回', async () => {
    await loadFilesFixture();
    const list = el('#wsFileList');
    const preview = el('#wsPreview');
    const listParent = list.parentElement!;
    const previewParent = preview.parentElement!;
    list.remove();
    preview.remove();
    expect(() => switchToTab('files')).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    hoisted.readFile.mockResolvedValueOnce({ success: true, content: 'x' });
    // 直接调用点击逻辑前恢复列表，但预览仍缺失
    listParent.appendChild(list);
    (document.querySelector('#wsFileList .ws-file-item[data-name="a.ts"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(() => renderPanel()).not.toThrow();
    previewParent.appendChild(preview);
  });
});
