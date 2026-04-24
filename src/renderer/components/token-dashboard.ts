/**
 * TokenDashboard - Token 实时监控仪表盘
 * 支持全局统计（跨会话累计）和当前会话统计双视图切换
 */

import { state, KEYS } from '../state/state.js';
import { formatTime } from '../utils/utils.js';
import { logError, logInfo } from '../services/log-service.js';
import type { ChatSession, ChatMessage } from '../types.js';

let dashboardModalEl: HTMLElement;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let viewMode: 'global' | 'session' = 'global';

/** 全局统计缓存 */
interface SessionTokenStat {
  session_id: string;
  title: string;
  model: string;
  created_at: number;
  total_input: number;
  total_output: number;
  total_duration: number;
  round_count: number;
}

interface GlobalTokenTotals {
  total_input: number;
  total_output: number;
  total_duration: number;
  total_rounds: number;
  session_count: number;
}

interface AllSessionsTokenStats {
  sessions: SessionTokenStat[];
  totals: GlobalTokenTotals;
}

let globalStatsCache: AllSessionsTokenStats | null = null;
let globalStatsLoaded = false;

/** 打开仪表盘 */
export function openTokenDashboard(): void {
  if (!dashboardModalEl) return;
  dashboardModalEl.style.display = '';
  globalStatsLoaded = false;
  renderDashboard();
  startAutoRefresh();
}

/** 关闭仪表盘 */
export function closeTokenDashboard(): void {
  if (!dashboardModalEl) return;
  dashboardModalEl.style.display = 'none';
  stopAutoRefresh();
}

/** 初始化 */
export function initTokenDashboard(): void {
  dashboardModalEl = document.querySelector('#tokenDashboardModal')!;

  document.querySelector('#btnTokenDashboard')!.addEventListener('click', openTokenDashboard);
  document.querySelector('#btnCloseTokenDashboard')!.addEventListener('click', closeTokenDashboard);
  dashboardModalEl.addEventListener('click', (e) => {
    if (e.target === dashboardModalEl) closeTokenDashboard();
  });

  // 视图切换按钮事件
  const toggleEl = dashboardModalEl.querySelector('#tdViewToggle')!;
  toggleEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('td-view-btn')) return;
    const newView = target.dataset.view as 'global' | 'session';
    if (newView && newView !== viewMode) {
      viewMode = newView;
      // 更新按钮 active 状态
      toggleEl.querySelectorAll('.td-view-btn').forEach(btn => btn.classList.remove('active'));
      target.classList.add('active');
      // 切换时刷新
      if (viewMode === 'global') globalStatsLoaded = false;
      renderDashboard();
    }
  });
}

function startAutoRefresh(): void {
  stopAutoRefresh();
  refreshTimer = setInterval(() => renderDashboard(), 2000);
}

function stopAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

interface RoundData {
  round: number;
  role: string;
  eval_count: number;
  prompt_eval_count: number;
  total_duration: number;
  timestamp: number;
  model?: string;
}

function collectRoundData(messages: ChatMessage[]): RoundData[] {
  const rounds: RoundData[] = [];
  let roundNum = 0;
  for (const msg of messages) {
    if (msg.role === 'assistant' && (msg.eval_count || msg.prompt_eval_count || msg.total_duration)) {
      roundNum++;
      rounds.push({
        round: roundNum,
        role: msg.role,
        eval_count: msg.eval_count || 0,
        prompt_eval_count: msg.prompt_eval_count || 0,
        total_duration: msg.total_duration || 0,
        timestamp: msg.timestamp,
        model: msg.model,
      });
    }
  }
  return rounds;
}

function formatDuration(ns: number): string {
  if (!ns) return '-';
  const ms = ns / 1_000_000;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(0);
  return `${m}m${rem}s`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 获取全局统计数据（带缓存） */
async function fetchGlobalStats(): Promise<AllSessionsTokenStats | null> {
  if (globalStatsLoaded && globalStatsCache) return globalStatsCache;
  try {
    const desktop = window.metonaDesktop;
    if (!desktop?.db?.getAllTokenStats) return null;
    const result = await desktop.db.getAllTokenStats();
    if (result) {
      globalStatsCache = result;
      globalStatsLoaded = true;
      return result;
    }
  } catch (err) {
    logError('Token Dashboard: 获取全局统计失败', String(err));
  }
  return null;
}

function renderDashboard(): void {
  if (viewMode === 'global') {
    renderGlobalView();
  } else {
    renderSessionView();
  }
}

/** 渲染全局统计视图 */
function renderGlobalView(): void {
  fetchGlobalStats().then(stats => {
    if (!stats) {
      renderGlobalFallback();
      return;
    }
    renderGlobalOverview(stats);
    renderGlobalChart(stats);
    renderGlobalTable(stats);
  });
}

/** 全局统计获取失败时的降级处理 */
function renderGlobalFallback(): void {
  const overviewEl = dashboardModalEl.querySelector('#tdOverview')!;
  overviewEl.innerHTML = `
    <div class="td-stat-card">
      <div class="td-stat-icon">🌍</div>
      <div class="td-stat-value">-</div>
      <div class="td-stat-label">全局统计加载中…</div>
    </div>
  `;
  const chartEl = dashboardModalEl.querySelector('#tdChart')!;
  chartEl.innerHTML = '<div class="td-empty">正在加载全局数据…</div>';
  const tableEl = dashboardModalEl.querySelector('#tdTableBody')!;
  tableEl.innerHTML = '<tr><td colspan="7" class="td-empty-row">正在加载…</td></tr>';
}

/** 渲染全局概览卡片 */
function renderGlobalOverview(stats: AllSessionsTokenStats): void {
  const { totals } = stats;
  const totalTokens = totals.total_input + totals.total_output;
  const avgPerRound = totals.total_rounds > 0 ? Math.round(totalTokens / totals.total_rounds) : 0;

  const overviewEl = dashboardModalEl.querySelector('#tdOverview')!;
  overviewEl.innerHTML = `
    <div class="td-stat-row td-stat-row-global">
      <div class="td-stat-card">
        <div class="td-stat-icon">🌍</div>
        <div class="td-stat-value">${formatTokenCount(totalTokens)}</div>
        <div class="td-stat-label">全局 Token 总计</div>
        <div class="td-stat-detail">输入 ${formatTokenCount(totals.total_input)} / 输出 ${formatTokenCount(totals.total_output)}</div>
      </div>
      <div class="td-stat-card">
        <div class="td-stat-icon">📂</div>
        <div class="td-stat-value">${totals.session_count}</div>
        <div class="td-stat-label">总会话数</div>
      </div>
      <div class="td-stat-card">
        <div class="td-stat-icon">💬</div>
        <div class="td-stat-value">${totals.total_rounds}</div>
        <div class="td-stat-label">总轮次</div>
      </div>
      <div class="td-stat-card">
        <div class="td-stat-icon">⏱️</div>
        <div class="td-stat-value">${formatDuration(totals.total_duration)}</div>
        <div class="td-stat-label">总推理耗时</div>
      </div>
    </div>
    <div class="td-stat-row td-stat-row-session">
      <div class="td-stat-card td-stat-card-small">
        <div class="td-stat-icon">📊</div>
        <div class="td-stat-value">${formatTokenCount(avgPerRound)}</div>
        <div class="td-stat-label">平均 Token/轮</div>
      </div>
    </div>
  `;
}

/** 渲染柱状图（通用，全局/会话复用） */
function renderBarChart(
  chartEl: HTMLElement,
  data: Array<{ label: string; input: number; output: number; tooltip: string }>,
  title: string,
  note?: string,
  savedScrollLeft?: number
): void {
  if (data.length === 0) {
    chartEl.innerHTML = '<div class="td-empty">暂无数据</div>';
    return;
  }

  const maxTokens = Math.max(...data.map(d => d.input + d.output), 1);

  // 网格线：5 条水平线（0%, 25%, 50%, 75%, 100%）
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
    const val = Math.round(maxTokens * ratio);
    return `<div class="td-gridline" style="bottom:${ratio * 100}%">
      <span class="td-gridline-label">${formatTokenCount(val)}</span>
    </div>`;
  }).join('');

  const barsHtml = data.map(d => {
    const total = d.input + d.output;
    const heightPct = Math.max((total / maxTokens) * 100, 1.5);
    const inputPct = total > 0 ? (d.input / total) * 100 : 0;
    const outputPct = 100 - inputPct;
    return `
      <div class="td-bar-col" title="${d.tooltip}">
        <div class="td-bar-area">
          <div class="td-bar-stack" style="height:${heightPct}%;">
            <div class="td-bar-segment td-bar-output" style="height:${outputPct}%;"></div>
            <div class="td-bar-segment td-bar-input-seg" style="height:${inputPct}%;"></div>
          </div>
        </div>
        <div class="td-bar-labels">
          <span class="td-val-output">${formatTokenCount(d.output)}</span>
          <span class="td-val-input">${formatTokenCount(d.input)}</span>
        </div>
        <div class="td-bar-label">${d.label}</div>
      </div>
    `;
  }).join('');

  chartEl.innerHTML = `
    <div class="td-chart-legend">
      <span class="td-legend-item"><span class="td-legend-dot td-legend-output"></span>输出 Token</span>
      <span class="td-legend-item"><span class="td-legend-dot td-legend-input"></span>输入 Token</span>
      ${note ? `<span class="td-legend-item td-legend-note">${note}</span>` : ''}
    </div>
    <div class="td-chart-grid">
      ${gridLines}
      <div class="td-chart-bars">${barsHtml}</div>
    </div>
  `;

  // 恢复滚动位置
  if (savedScrollLeft && savedScrollLeft > 0) {
    const newBarsEl = chartEl.querySelector('.td-chart-bars') as HTMLElement | null;
    if (newBarsEl) newBarsEl.scrollLeft = savedScrollLeft;
  }
}

/** 渲染全局明细表格 */
function renderGlobalTable(stats: AllSessionsTokenStats): void {
  const tableTitleEl = dashboardModalEl.querySelector('#tdTableTitle');
  if (tableTitleEl) tableTitleEl.textContent = '📋 会话汇总明细';

  // 动态更新表头
  updateTableHeader('global');

  const tableEl = dashboardModalEl.querySelector('#tdTableBody')!;
  const sessions = stats.sessions;

  if (sessions.length === 0) {
    tableEl.innerHTML = '<tr><td colspan="7" class="td-empty-row">暂无数据</td></tr>';
    return;
  }

  tableEl.innerHTML = sessions.map(s => {
    const total = s.total_input + s.total_output;
    return `
    <tr>
      <td title="${s.title}">${s.title.length > 20 ? s.title.slice(0, 20) + '…' : s.title}</td>
      <td><span class="td-model-tag">${s.model}</span></td>
      <td class="td-num">${formatTokenCount(s.total_input)}</td>
      <td class="td-num">${formatTokenCount(s.total_output)}</td>
      <td class="td-num td-num-total">${formatTokenCount(total)}</td>
      <td class="td-num">${s.round_count}</td>
      <td class="td-time">${s.created_at ? formatTime(s.created_at) : '-'}</td>
    </tr>
    `;
  }).join('');
}

/** 渲染当前会话视图 */
function renderSessionView(): void {
  const session = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  const messages = session?.messages || [];

  const userMsgs = messages.filter(m => m.role === 'user');
  const aiMsgs = messages.filter(m => m.role === 'assistant');
  const rounds = collectRoundData(messages);

  const totalOutputTokens = rounds.reduce((sum, r) => sum + r.eval_count, 0);
  const totalInputTokens = rounds.reduce((sum, r) => sum + r.prompt_eval_count, 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalDurationNs = rounds.reduce((sum, r) => sum + r.total_duration, 0);
  const avgTokens = rounds.length > 0 ? Math.round(totalTokens / rounds.length) : 0;

  // 概览区域
  const overviewEl = dashboardModalEl.querySelector('#tdOverview')!;
  overviewEl.innerHTML = `
    <div class="td-stat-row td-stat-row-global">
      <div class="td-stat-card">
        <div class="td-stat-icon">🔥</div>
        <div class="td-stat-value">${formatTokenCount(totalTokens)}</div>
        <div class="td-stat-label">会话 Token 消耗</div>
        <div class="td-stat-detail">输入 ${formatTokenCount(totalInputTokens)} / 输出 ${formatTokenCount(totalOutputTokens)}</div>
      </div>
      <div class="td-stat-card">
        <div class="td-stat-icon">💬</div>
        <div class="td-stat-value">${userMsgs.length} / ${aiMsgs.length}</div>
        <div class="td-stat-label">用户 / AI 消息</div>
      </div>
      <div class="td-stat-card">
        <div class="td-stat-icon">📊</div>
        <div class="td-stat-value">${formatTokenCount(avgTokens)}</div>
        <div class="td-stat-label">平均 Token/轮</div>
      </div>
      <div class="td-stat-card">
        <div class="td-stat-icon">⏱️</div>
        <div class="td-stat-value">${formatDuration(totalDurationNs)}</div>
        <div class="td-stat-label">总推理耗时</div>
      </div>
    </div>
    <div class="td-stat-row td-stat-row-session">
      <div class="td-stat-card td-stat-card-small">
        <div class="td-stat-icon">🤖</div>
        <div class="td-stat-value">${session?.model || '-'}</div>
        <div class="td-stat-label">当前模型</div>
      </div>
    </div>
  `;

  // 柱状图
  const chartEl = dashboardModalEl.querySelector('#tdChart')!;
  const barsEl = chartEl.querySelector('.td-chart-bars') as HTMLElement | null;
  const savedScrollLeft = barsEl?.scrollLeft ?? 0;

  const chartData = rounds.map(r => ({
    label: `R${r.round}`,
    input: r.prompt_eval_count,
    output: r.eval_count,
    tooltip: `第${r.round}轮 · 输入 ${formatTokenCount(r.prompt_eval_count)} + 输出 ${formatTokenCount(r.eval_count)} = ${formatTokenCount(r.eval_count + r.prompt_eval_count)} tokens · ${formatDuration(r.total_duration)}`,
  }));

  const chartTitleEl = dashboardModalEl.querySelector('#tdChartTitle');
  if (chartTitleEl) chartTitleEl.textContent = '📈 Token 消耗趋势 — 按轮次';

  renderBarChart(chartEl, chartData, '按轮次', undefined, savedScrollLeft);

  // 表格标题
  const tableTitleEl = dashboardModalEl.querySelector('#tdTableTitle');
  if (tableTitleEl) tableTitleEl.textContent = '📋 轮次明细（按时间倒序）';

  // 动态更新表头
  updateTableHeader('session');

  // 明细表格
  const tableEl = dashboardModalEl.querySelector('#tdTableBody')!;
  if (rounds.length === 0) {
    tableEl.innerHTML = '<tr><td colspan="7" class="td-empty-row">暂无数据</td></tr>';
  } else {
    const sorted = [...rounds].reverse();
    tableEl.innerHTML = sorted.map(r => {
      const total = r.eval_count + r.prompt_eval_count;
      return `
      <tr>
        <td>R${r.round}</td>
        <td><span class="td-role-badge">🤖 AI</span>${r.model ? ` <span class="td-model-tag">${r.model}</span>` : ''}</td>
        <td class="td-num">${formatTokenCount(r.prompt_eval_count)}</td>
        <td class="td-num">${formatTokenCount(r.eval_count)}</td>
        <td class="td-num td-num-total">${formatTokenCount(total)}</td>
        <td class="td-num">${formatDuration(r.total_duration)}</td>
        <td class="td-time">${r.timestamp ? formatTime(r.timestamp) : '-'}</td>
      </tr>
    `;
    }).join('');
  }
}

/** 动态更新表头列 */
function updateTableHeader(mode: 'global' | 'session'): void {
  const thead = dashboardModalEl.querySelector('.td-table thead tr');
  if (!thead) return;

  if (mode === 'global') {
    thead.innerHTML = `
      <th>会话</th>
      <th>模型</th>
      <th>输入</th>
      <th>输出</th>
      <th>合计</th>
      <th>轮次</th>
      <th>创建时间</th>
    `;
  } else {
    thead.innerHTML = `
      <th>轮次</th>
      <th>角色</th>
      <th>输入</th>
      <th>输出</th>
      <th>合计</th>
      <th>耗时</th>
      <th>时间</th>
    `;
  }
}
