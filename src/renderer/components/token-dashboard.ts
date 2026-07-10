/**
 * TokenDashboard - Token 实时监控仪表盘
 * 支持全局统计（跨会话累计）和当前会话统计双视图切换
 */

import { state, KEYS } from '../state/state.js';
import { formatTime } from '../utils/utils.js';
import { logError } from '../services/log-service.js';
import { getEffectiveNumCtx, getModelContextLength } from './model-bar.js';
import { estimateTokens } from '../services/context-manager.js';
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

/** P1 #5: HTML 转义，防止 XSS */
function escapeHtml(s: unknown): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 打开仪表盘 */
export function openTokenDashboard(): void {
  if (!dashboardModalEl) return;
  dashboardModalEl.style.display = '';
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
  llmCallCount: number;
}

/**
 * 收集轮次数据 — 按用户消息分组（一次用户消息 = 一轮）。
 * Agent Loop 中一次用户交互可能触发多次 LLM 调用，
 * 这些调用的 token 统计会被聚合到同一个轮次中。
 */
function collectRoundData(messages: ChatMessage[]): RoundData[] {
  const rounds: RoundData[] = [];
  let turnNum = 0;
  let currentTurn: RoundData | null = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      // 新轮次开始
      if (currentTurn) rounds.push(currentTurn);
      turnNum++;
      currentTurn = {
        round: turnNum,
        role: 'assistant',
        eval_count: 0,
        prompt_eval_count: 0,
        total_duration: 0,
        timestamp: msg.timestamp,
        llmCallCount: 0,
      };
    } else if (msg.role === 'assistant' && (msg.eval_count || msg.prompt_eval_count || msg.total_duration)) {
      if (!currentTurn) {
        // 边界情况：assistant 消息出现在任何 user 消息之前
        turnNum++;
        currentTurn = {
          round: turnNum,
          role: 'assistant',
          eval_count: 0,
          prompt_eval_count: 0,
          total_duration: 0,
          timestamp: msg.timestamp,
          llmCallCount: 0,
        };
      }
      currentTurn.eval_count += msg.eval_count || 0;
      currentTurn.prompt_eval_count += msg.prompt_eval_count || 0;
      currentTurn.total_duration += msg.total_duration || 0;
      currentTurn.llmCallCount++;
      currentTurn.model = msg.model || currentTurn.model;
      currentTurn.timestamp = msg.timestamp;
    }
  }
  if (currentTurn) rounds.push(currentTurn);
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

/** P1 #3: 上次成功获取的全局数据（用于刷新期间保持旧数据可见，避免闪烁） */
let lastSuccessfulStats: AllSessionsTokenStats | null = null;
let hasEverLoaded = false;

/** P1 #3: 获取全局统计数据 — 每次都重新查询，不做永久缓存 */
async function fetchGlobalStats(): Promise<AllSessionsTokenStats | null> {
  try {
    const desktop = window.metonaDesktop;
    if (!desktop?.db?.getAllTokenStats) return null;
    const result = await desktop.db.getAllTokenStats();
    if (result) {
      lastSuccessfulStats = result;
      hasEverLoaded = true;
      return result;
    }
  } catch (err) {
    logError('Token Dashboard: 获取全局统计失败', String(err));
  }
  return null;
}

function renderDashboard(): void {
  // 全局视图时隐藏上下文环形图区域（仅会话视图显示）
  const ringSection = dashboardModalEl.querySelector('#tdCtxRingSection') as HTMLElement | null;
  if (ringSection) ringSection.style.display = viewMode === 'session' ? '' : 'none';

  if (viewMode === 'global') {
    renderGlobalView();
  } else {
    renderSessionView();
  }
}

/** P9: 全局刷新请求 ID，防止异步竞态 */
let globalFetchId = 0;

/** 重新计算全局汇总 */
function recalcTotals(sessions: SessionTokenStat[]): GlobalTokenTotals {
  let totalInput = 0, totalOutput = 0, totalDuration = 0, totalRounds = 0;
  for (const s of sessions) {
    totalInput += s.total_input || 0;
    totalOutput += s.total_output || 0;
    totalDuration += s.total_duration || 0;
    totalRounds += s.round_count || 0;
  }
  return {
    total_input: totalInput,
    total_output: totalOutput,
    total_duration: totalDuration,
    total_rounds: totalRounds,
    session_count: sessions.length,
  };
}

/** 渲染全局统计视图 */
function renderGlobalView(): void {
  const myFetchId = ++globalFetchId;
  fetchGlobalStats().then(stats => {
    if (myFetchId !== globalFetchId) return; // P9: 过期响应，丢弃
    if (!stats) {
      // P1 #3/#9: 刷新失败时保留旧数据，仅在从未加载成功时显示错误
      if (hasEverLoaded && lastSuccessfulStats) {
        renderGlobalOverview(lastSuccessfulStats);
        renderGlobalChart(lastSuccessfulStats);
        renderGlobalTable(lastSuccessfulStats);
      } else {
        renderGlobalFallback(true);
      }
      return;
    }

    // P2: 合并当前会话内存数据，确保实时性
    const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
    if (currentSession && currentSession.messages.length > 0) {
      const rounds = collectRoundData(currentSession.messages);
      if (rounds.length > 0) {
        const totalInput = rounds.reduce((sum, r) => sum + r.prompt_eval_count, 0);
        const totalOutput = rounds.reduce((sum, r) => sum + r.eval_count, 0);
        const totalDuration = rounds.reduce((sum, r) => sum + r.total_duration, 0);
        const sessionStat: SessionTokenStat = {
          session_id: currentSession.id,
          title: currentSession.title,
          model: currentSession.model,
          created_at: currentSession.createdAt,
          total_input: totalInput,
          total_output: totalOutput,
          total_duration: totalDuration,
          round_count: rounds.length,
        };
        const idx = stats.sessions.findIndex(s => s.session_id === currentSession.id);
        if (idx >= 0) {
          stats.sessions[idx] = sessionStat;
        } else {
          stats.sessions.push(sessionStat);
        }
        stats.totals = recalcTotals(stats.sessions);
      }
    }

    renderGlobalOverview(stats);
    renderGlobalChart(stats);
    renderGlobalTable(stats);
  });
}

/** 全局统计获取失败时的降级处理 */
function renderGlobalFallback(isError = false): void {
  const overviewEl = dashboardModalEl.querySelector('#tdOverview')!;
  const msg = isError ? '全局统计加载失败，正在重试…' : '正在加载全局数据…';
  overviewEl.innerHTML = `
    <div class="td-stat-card">
      <div class="td-stat-icon">🌍</div>
      <div class="td-stat-value">-</div>
      <div class="td-stat-label">${msg}</div>
    </div>
  `;
  const chartEl = dashboardModalEl.querySelector('#tdChart')!;
  chartEl.innerHTML = `<div class="td-empty">${msg}</div>`;
  const tableEl = dashboardModalEl.querySelector('#tdTableBody')!;
  tableEl.innerHTML = `<tr><td colspan="7" class="td-empty-row">${msg}</td></tr>`;
}

/** 渲染全局概览卡片 */
function renderGlobalOverview(stats: AllSessionsTokenStats): void {
  const { totals } = stats;
  const totalTokens = totals.total_input + totals.total_output;
  const avgPerRound = totals.total_rounds > 0 ? Math.round(totalTokens / totals.total_rounds) : 0;

  const overviewEl = dashboardModalEl.querySelector('#tdOverview')!;
  overviewEl.innerHTML = `
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
      <div class="td-stat-card td-stat-card-small">
        <div class="td-stat-icon">📊</div>
        <div class="td-stat-value">${formatTokenCount(avgPerRound)}</div>
        <div class="td-stat-label">平均 Token/轮</div>
      </div>
  `;
}

/** 渲染柱状图（通用，全局/会话复用） */
function renderBarChart(
  chartEl: HTMLElement,
  data: Array<{ label: string; input: number; output: number; tooltip: string }>,
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
      <div class="td-bar-col" title="${escapeHtml(d.tooltip)}">
        <div class="td-bar-area">
          <div class="td-bar-stack" style="height:${heightPct}%;">
            <div class="td-bar-segment td-bar-output" style="height:${outputPct}%;"></div>
            <div class="td-bar-segment td-bar-input-seg" style="height:${inputPct}%;"></div>
          </div>
        </div>
        <div class="td-bar-labels">
          <span class="td-val-input">${formatTokenCount(d.input)}</span>
          <span class="td-val-output">${formatTokenCount(d.output)}</span>
        </div>
        <div class="td-bar-label">${escapeHtml(d.label)}</div>
      </div>
    `;
  }).join('');

  chartEl.innerHTML = `
    <div class="td-chart-legend">
      <span class="td-legend-item"><span class="td-legend-dot td-legend-output"></span>输出 Token</span>
      <span class="td-legend-item"><span class="td-legend-dot td-legend-input"></span>输入 Token</span>
      ${note ? `<span class="td-legend-item td-legend-note">${escapeHtml(note)}</span>` : ''}
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

/** 渲染全局柱状图（按会话） */
function renderGlobalChart(stats: AllSessionsTokenStats): void {
  const chartEl = dashboardModalEl.querySelector('#tdChart') as HTMLElement;
  const barsEl = chartEl.querySelector('.td-chart-bars') as HTMLElement | null;
  const savedScrollLeft = barsEl?.scrollLeft ?? 0;

  const chartTitleEl = dashboardModalEl.querySelector('#tdChartTitle');
  if (chartTitleEl) chartTitleEl.textContent = '📈 Token 消耗趋势 — 按会话';

  const sessions = stats.sessions;
  if (sessions.length === 0) {
    chartEl.innerHTML = '<div class="td-empty">暂无数据</div>';
    return;
  }

  // P2 #10: 统一排序 — 按 created_at 正序（图表左→右为时间递增）
  const sorted = [...sessions].sort((a, b) => a.created_at - b.created_at).slice(-30);

  const chartData = sorted.map(s => ({
    label: s.title.length > 10 ? s.title.slice(0, 10) + '…' : s.title,
    input: s.total_input,
    output: s.total_output,
    tooltip: `${s.title} · 模型 ${s.model} · 输入 ${formatTokenCount(s.total_input)} + 输出 ${formatTokenCount(s.total_output)} = ${formatTokenCount(s.total_input + s.total_output)} tokens · ${s.round_count} 轮`,
  }));

  const noteText = sessions.length > sorted.length
    ? `最近 ${sorted.length} / 共 ${sessions.length} 个会话`
    : `共 ${sorted.length} 个会话`;
  renderBarChart(chartEl, chartData, noteText, savedScrollLeft);
}

/** 渲染全局明细表格 */
function renderGlobalTable(stats: AllSessionsTokenStats): void {
  const tableTitleEl = dashboardModalEl.querySelector('#tdTableTitle') as HTMLElement | null;
  if (tableTitleEl) tableTitleEl.textContent = '📋 会话汇总明细';

  // 动态更新表头
  updateTableHeader('global');

  // P1 #4: 保存表格滚动位置
  const tableWrapEl = dashboardModalEl.querySelector('.td-table-wrap') as HTMLElement | null;
  const savedScrollTop = tableWrapEl?.scrollTop ?? 0;

  const tableEl = dashboardModalEl.querySelector('#tdTableBody')!;
  const sessions = stats.sessions;

  if (sessions.length === 0) {
    tableEl.innerHTML = '<tr><td colspan="7" class="td-empty-row">暂无数据</td></tr>';
    return;
  }

  // P2 #10: 统一排序 — 按 created_at 倒序（最新创建的在前）
  const sorted = [...sessions].sort((a, b) => b.created_at - a.created_at);

  // P2 #8: 限制表格行数，避免大量数据导致 DOM 性能问题
  const MAX_ROWS = 50;
  const display = sorted.slice(0, MAX_ROWS);

  // 如果有截断，在表格标题中标注
  if (tableTitleEl && sorted.length > MAX_ROWS) {
    tableTitleEl.textContent = `📋 会话汇总明细（最近 ${MAX_ROWS} 条 / 共 ${sorted.length} 条）`;
  }

  tableEl.innerHTML = display.map(s => {
    const total = s.total_input + s.total_output;
    return `
    <tr>
      <td title="${escapeHtml(s.title)}">${escapeHtml(s.title.length > 20 ? s.title.slice(0, 20) + '…' : s.title)}</td>
      <td><span class="td-model-tag">${escapeHtml(s.model)}</span></td>
      <td class="td-num">${formatTokenCount(s.total_input)}</td>
      <td class="td-num">${formatTokenCount(s.total_output)}</td>
      <td class="td-num td-num-total">${formatTokenCount(total)}</td>
      <td class="td-num">${s.round_count}</td>
      <td class="td-time">${s.created_at ? formatTime(s.created_at) : '-'}</td>
    </tr>
    `;
  }).join('');

  // P1 #4: 恢复表格滚动位置
  if (savedScrollTop > 0) {
    const newWrapEl = dashboardModalEl.querySelector('.td-table-wrap') as HTMLElement | null;
    if (newWrapEl) newWrapEl.scrollTop = savedScrollTop;
  }
}

/**
 * 计算当前已用上下文 token 数。
 * 优先使用最后一条 assistant 消息的 prompt_eval_count（Ollama 精确值），
 * 再加上后续新增消息的估算 token（含 toolCalls/images 开销）。
 * 无实际数据时回退到增强估算（全量消息内容 + toolCalls/images 开销）。
 */
function computeUsedContextTokens(messages: ChatMessage[]): { usedTokens: number; isActual: boolean } {
  // 从末尾向前查找最后一条携带 prompt_eval_count 的 assistant 消息
  let lastActualIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.prompt_eval_count && m.prompt_eval_count > 0) {
      lastActualIdx = i;
      break;
    }
  }

  if (lastActualIdx >= 0) {
    const lastActual = messages[lastActualIdx];
    // 基准：Ollama 返回的实际输入 token + 输出 token
    let base = lastActual.prompt_eval_count! + (lastActual.eval_count || 0);

    // 累加 lastActual 之后新增消息的估算 token
    for (let i = lastActualIdx + 1; i < messages.length; i++) {
      const m = messages[i];
      base += estimateTokens(m.content || '');
      if (m.toolCalls?.length) base += m.toolCalls.length * 50;
      if (m.images?.length) base += m.images.length * 100;
    }
    return { usedTokens: base, isActual: true };
  }

  // 无实际数据：增强估算（含 toolCalls/images 开销）
  let estimated = 0;
  for (const m of messages) {
    estimated += estimateTokens(m.content || '');
    if (m.toolCalls?.length) estimated += m.toolCalls.length * 50;
    if (m.images?.length) estimated += m.images.length * 100;
  }
  return { usedTokens: estimated, isActual: false };
}

/** 渲染上下文使用率环形图 */
function renderCtxRing(messages: ChatMessage[], isStreaming: boolean): void {
  const ringSection = dashboardModalEl.querySelector('#tdCtxRingSection') as HTMLElement;
  const ringEl = dashboardModalEl.querySelector('#tdCtxRing') as HTMLElement;
  if (!ringSection || !ringEl) return;

  ringSection.style.display = '';

  const effectiveCtx = getEffectiveNumCtx();
  const modelCtx = getModelContextLength();
  const userCtx = state.get<number>(KEYS.NUM_CTX, 131072);

  // ── 计算已用上下文 token ──
  // 优先使用 Ollama 返回的实际 prompt_eval_count（精确值），
  // 无实际数据时回退到增强估算（含 toolCalls/images 开销）
  const { usedTokens, isActual } = computeUsedContextTokens(messages);
  const remainTokens = Math.max(effectiveCtx - usedTokens, 0);
  const usagePct = effectiveCtx > 0 ? Math.min((usedTokens / effectiveCtx) * 100, 100) : 0;

  // SVG 环形图参数
  const size = 140;
  const strokeWidth = 12;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - usagePct / 100);

  // 颜色根据使用率变化
  let ringColor = '#9B7ED8'; // 紫色 - 正常
  if (usagePct >= 90) ringColor = '#E8734A'; // 珊瑚红 - 危险
  else if (usagePct >= 70) ringColor = '#F0A040'; // 橙色 - 警告

  // 钳制说明文字
  const clampNote = modelCtx > 0 && modelCtx < userCtx
    ? `模型限制 ${formatTokenCount(modelCtx)} < 设置值 ${formatTokenCount(userCtx)}，采用 ${formatTokenCount(effectiveCtx)}`
    : `设置值 ${formatTokenCount(userCtx)}`;

  ringEl.innerHTML = `
    <div class="td-ctx-ring-container">
      <svg class="td-ctx-ring-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle class="td-ctx-ring-bg" cx="${size/2}" cy="${size/2}" r="${radius}"
          fill="none" stroke="var(--border-subtle)" stroke-width="${strokeWidth}"/>
        <circle class="td-ctx-ring-fg" cx="${size/2}" cy="${size/2}" r="${radius}"
          fill="none" stroke="${ringColor}" stroke-width="${strokeWidth}"
          stroke-linecap="round"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${dashOffset}"
          transform="rotate(-90 ${size/2} ${size/2})"
          style="transition: stroke-dashoffset 0.6s ease, stroke 0.3s ease;"/>
        <text class="td-ctx-ring-pct" x="${size/2}" y="${size/2 - 4}" text-anchor="middle"
          fill="${ringColor}" font-size="22" font-weight="700" font-family="var(--font-mono)">
          ${usagePct.toFixed(0)}%
        </text>
        <text class="td-ctx-ring-label" x="${size/2}" y="${size/2 + 16}" text-anchor="middle"
          fill="var(--text-tertiary)" font-size="10">
          已用 / 总量
        </text>
      </svg>
      <div class="td-ctx-ring-details">
        <div class="td-ctx-ring-row">
          <span class="td-ctx-ring-dot td-ctx-dot-used"></span>
          <span class="td-ctx-ring-label-text">已用上下文</span>
          <span class="td-ctx-ring-val">${formatTokenCount(usedTokens)}</span>
        </div>
        <div class="td-ctx-ring-row">
          <span class="td-ctx-ring-dot td-ctx-dot-remain"></span>
          <span class="td-ctx-ring-label-text">剩余上下文</span>
          <span class="td-ctx-ring-val">${formatTokenCount(remainTokens)}</span>
        </div>
        <div class="td-ctx-ring-row td-ctx-ring-total">
          <span class="td-ctx-ring-label-text">有效上下文窗口</span>
          <span class="td-ctx-ring-val">${formatTokenCount(effectiveCtx)}</span>
        </div>
        <div class="td-ctx-ring-note">${escapeHtml(clampNote)}</div>
        <div class="td-ctx-ring-source">${isActual ? '✅ 基于 Ollama 实际计数' : '⚙️ 基于估算（含工具/图片开销）'}</div>
        ${isStreaming ? '<div class="td-ctx-ring-streaming">⚡ 实时更新中…</div>' : ''}
      </div>
    </div>
  `;
}

/** 渲染当前会话视图 */
function renderSessionView(): void {
  const session = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  const messages = session?.messages || [];
  const isStreaming = state.get<boolean>(KEYS.IS_STREAMING, false);

  const userMsgs = messages.filter(m => m.role === 'user');
  const aiMsgs = messages.filter(m => m.role === 'assistant');
  const rounds = collectRoundData(messages);

  const totalOutputTokens = rounds.reduce((sum, r) => sum + r.eval_count, 0);
  const totalInputTokens = rounds.reduce((sum, r) => sum + r.prompt_eval_count, 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalDurationNs = rounds.reduce((sum, r) => sum + r.total_duration, 0);
  const avgTokens = rounds.length > 0 ? Math.round(totalTokens / rounds.length) : 0;

  // P3 #12: 从最后一条 assistant 消息获取实际使用的模型
  const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant' && m.model);
  const currentModel = lastAssistantMsg?.model || session?.model || '-';

  // 渲染上下文使用率环形图
  renderCtxRing(messages, isStreaming);

  // 概览区域
  const overviewEl = dashboardModalEl.querySelector('#tdOverview')!;
  overviewEl.innerHTML = `
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
      <div class="td-stat-card td-stat-card-small">
        <div class="td-stat-icon">🤖</div>
        <div class="td-stat-value">${escapeHtml(currentModel)}</div>
        <div class="td-stat-label">当前模型</div>
      </div>
  `;

  // 柱状图
  const chartEl = dashboardModalEl.querySelector('#tdChart') as HTMLElement;
  const barsEl = chartEl.querySelector('.td-chart-bars') as HTMLElement | null;
  const savedScrollLeft = barsEl?.scrollLeft ?? 0;

  // P4: 限制图表柱子数量，避免长会话性能下降
  const MAX_CHART_ROUNDS = 50;
  const displayRounds = rounds.length > MAX_CHART_ROUNDS ? rounds.slice(-MAX_CHART_ROUNDS) : rounds;

  const chartData = displayRounds.map(r => ({
    label: `R${r.round}`,
    input: r.prompt_eval_count,
    output: r.eval_count,
    tooltip: `第${r.round}轮${r.llmCallCount > 1 ? ` · ${r.llmCallCount}次调用` : ''} · 输入 ${formatTokenCount(r.prompt_eval_count)} + 输出 ${formatTokenCount(r.eval_count)} = ${formatTokenCount(r.eval_count + r.prompt_eval_count)} tokens · ${formatDuration(r.total_duration)}`,
  }));

  const chartTitleEl = dashboardModalEl.querySelector('#tdChartTitle');
  if (chartTitleEl) chartTitleEl.textContent = '📈 Token 消耗趋势 — 按轮次';

  // P4 #6/#7: 图表 note — 显示轮次总数 + 流式提示
  const noteParts: string[] = [];
  if (rounds.length > MAX_CHART_ROUNDS) noteParts.push(`最近 ${MAX_CHART_ROUNDS} / 共 ${rounds.length} 轮`);
  else noteParts.push(`共 ${rounds.length} 轮`);
  if (isStreaming) noteParts.push('⚡ AI 回复中…');
  renderBarChart(chartEl, chartData, noteParts.join(' · '), savedScrollLeft);

  // 表格标题
  const tableTitleEl = dashboardModalEl.querySelector('#tdTableTitle') as HTMLElement | null;
  // P1 #6: 流式输出期间显示提示
  if (tableTitleEl) {
    tableTitleEl.textContent = isStreaming
      ? '📋 轮次明细（按时间倒序）— ⚡ AI 回复中，数据实时更新…'
      : '📋 轮次明细（按时间倒序）';
  }

  // 动态更新表头
  updateTableHeader('session');

  // P1 #4: 保存表格滚动位置
  const tableWrapEl = dashboardModalEl.querySelector('.td-table-wrap') as HTMLElement | null;
  const savedScrollTop = tableWrapEl?.scrollTop ?? 0;

  // 明细表格
  const tableEl = dashboardModalEl.querySelector('#tdTableBody')!;
  if (rounds.length === 0) {
    tableEl.innerHTML = isStreaming
      ? '<tr><td colspan="7" class="td-empty-row">⏳ AI 正在回复中，暂无统计数据…</td></tr>'
      : '<tr><td colspan="7" class="td-empty-row">暂无数据</td></tr>';
  } else {
    const sorted = [...rounds].reverse();
    tableEl.innerHTML = sorted.map(r => {
      const total = r.eval_count + r.prompt_eval_count;
      return `
      <tr>
        <td>R${r.round}</td>
        <td>${r.llmCallCount > 1 ? `<span class="td-num">${r.llmCallCount}次</span>` : '<span class="td-num">1次</span>'}${r.model ? ` <span class="td-model-tag">${escapeHtml(r.model)}</span>` : ''}</td>
        <td class="td-num">${formatTokenCount(r.prompt_eval_count)}</td>
        <td class="td-num">${formatTokenCount(r.eval_count)}</td>
        <td class="td-num td-num-total">${formatTokenCount(total)}</td>
        <td class="td-num">${formatDuration(r.total_duration)}</td>
        <td class="td-time">${r.timestamp ? formatTime(r.timestamp) : '-'}</td>
      </tr>
    `;
    }).join('');
  }

  // P1 #4: 恢复表格滚动位置
  if (savedScrollTop > 0) {
    const newWrapEl = dashboardModalEl.querySelector('.td-table-wrap') as HTMLElement | null;
    if (newWrapEl) newWrapEl.scrollTop = savedScrollTop;
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
      <th>调用</th>
      <th>输入</th>
      <th>输出</th>
      <th>合计</th>
      <th>耗时</th>
      <th>时间</th>
    `;
  }
}
