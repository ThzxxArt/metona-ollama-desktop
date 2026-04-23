/**
 * TokenDashboard - Token 实时监控仪表盘
 * 显示当前会话的 Token 消耗统计、趋势图和明细表
 */

import { state, KEYS } from '../state/state.js';
import { formatTime } from '../utils/utils.js';
import type { ChatSession, ChatMessage } from '../types.js';

let dashboardModalEl: HTMLElement;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

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

function renderDashboard(): void {
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

  // A. 概览区域
  const overviewEl = dashboardModalEl.querySelector('#tdOverview')!;
  overviewEl.innerHTML = `
    <div class="td-stat-card">
      <div class="td-stat-icon">🔥</div>
      <div class="td-stat-value">${formatTokenCount(totalTokens)}</div>
      <div class="td-stat-label">总 Token 消耗</div>
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
  `;

  // B. 柱状图
  const chartEl = dashboardModalEl.querySelector('#tdChart')!;
  if (rounds.length === 0) {
    chartEl.innerHTML = '<div class="td-empty">暂无数据，发送消息后开始统计</div>';
  } else {
    const maxTokens = Math.max(...rounds.map(r => r.eval_count + r.prompt_eval_count), 1);
    const barsHtml = rounds.map(r => {
      const total = r.eval_count + r.prompt_eval_count;
      const heightPct = Math.max((total / maxTokens) * 100, 2);
      const inputPct = total > 0 ? (r.prompt_eval_count / total) * 100 : 0;
      const tooltip = `第${r.round}轮 · 输入 ${formatTokenCount(r.prompt_eval_count)} + 输出 ${formatTokenCount(r.eval_count)} = ${formatTokenCount(total)} tokens · ${formatDuration(r.total_duration)}`;
      return `
        <div class="td-bar-col" title="${tooltip}">
          <div class="td-bar-values">
            <span class="td-val-output">${formatTokenCount(r.eval_count)}</span>
            <span class="td-val-input">${formatTokenCount(r.prompt_eval_count)}</span>
          </div>
          <div class="td-bar-wrapper">
            <div class="td-bar" style="height:${heightPct}%;">
              <div class="td-bar-fill">
                <div class="td-bar-input" style="height:${inputPct}%;"></div>
              </div>
            </div>
          </div>
          <div class="td-bar-label">R${r.round}</div>
        </div>
      `;
    }).join('');

    chartEl.innerHTML = `
      <div class="td-chart-legend">
        <span class="td-legend-item"><span class="td-legend-dot td-legend-output"></span>输出 Token</span>
        <span class="td-legend-item"><span class="td-legend-dot td-legend-input"></span>输入 Token</span>
      </div>
      <div class="td-chart-container">
        <div class="td-chart-y-axis">
          <span>${formatTokenCount(maxTokens)}</span>
          <span>${formatTokenCount(Math.round(maxTokens / 2))}</span>
          <span>0</span>
        </div>
        <div class="td-chart-bars">${barsHtml}</div>
      </div>
    `;
  }

  // C. 明细表格
  const tableEl = dashboardModalEl.querySelector('#tdTableBody')!;
  if (rounds.length === 0) {
    tableEl.innerHTML = '<tr><td colspan="6" class="td-empty-row">暂无数据</td></tr>';
  } else {
    // 按时间倒序
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
