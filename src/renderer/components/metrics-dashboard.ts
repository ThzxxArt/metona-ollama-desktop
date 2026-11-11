/**
 * MetricsDashboard — Agent Metrics 可视化仪表盘
 * 展示效率概览、工具热力图、Token 趋势；支持 JSON / Prometheus 格式导出
 */

import { getMetricsHistory, aggregateMetrics, generateImprovementSuggestions, exportMetricsJSON, exportMetricsPrometheus } from '../services/agent-metrics.js';
import { logInfo, logError, logSuccess } from '../services/log-service.js';
import { escapeHtml } from '../utils/utils.js';
import { showToast } from './toast.js';

let metricsModalEl: HTMLElement | null = null;

export function initMetricsDashboard(): void {
  metricsModalEl = document.querySelector('#metricsDashboardModal');

  document.querySelector('#btnMetrics')?.addEventListener('click', openMetricsDashboard);
  document.querySelector('#btnCloseMetrics')?.addEventListener('click', closeMetricsDashboard);

  // 指标导出（JSON / Prometheus 文本）
  document.querySelector('#btnExportMetricsJson')?.addEventListener('click', () => exportMetrics('json'));
  document.querySelector('#btnExportMetricsPrometheus')?.addEventListener('click', () => exportMetrics('prometheus'));

  if (metricsModalEl) {
    metricsModalEl.addEventListener('click', (e) => {
      if (e.target === metricsModalEl) closeMetricsDashboard();
    });
  }
}

/** 导出指标为 JSON 或 Prometheus 文本格式 */
async function exportMetrics(format: 'json' | 'prometheus'): Promise<void> {
  try {
    const bridge = window.metonaDesktop;
    const content = format === 'json' ? exportMetricsJSON() : exportMetricsPrometheus();
    const ext = format === 'json' ? 'json' : 'prom';
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    if (bridge) {
      const filePath = await bridge.dialog.saveFile({
        defaultPath: `metona-metrics-${ts}.${ext}`,
        filters: [
          format === 'json'
            ? { name: 'JSON', extensions: ['json'] }
            : { name: 'Prometheus 文本', extensions: ['prom', 'txt'] },
        ]
      });
      if (!filePath) return;
      const result = await bridge.fs.writeFile(filePath, content, 'utf-8');
      if (!result.success) {
        showToast(`导出失败: ${result.error}`, 'error');
        return;
      }
      logSuccess(`指标已导出 (${format})`, filePath);
      showToast('指标已导出', 'success');
    } else {
      // 浏览器回退：直接下载
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `metona-metrics-${ts}.${ext}`;
      a.click();
    }
  } catch (err) {
    logError('指标导出失败', (err as Error).message);
    showToast(`导出失败: ${(err as Error).message}`, 'error');
  }
}

function openMetricsDashboard(): void {
  if (!metricsModalEl) return;
  metricsModalEl.style.display = '';
  renderMetricsDashboard();
}

function closeMetricsDashboard(): void {
  if (metricsModalEl) metricsModalEl.style.display = 'none';
}

function renderMetricsDashboard(): void {
  const history = getMetricsHistory();
  const agg = aggregateMetrics();
  const suggestions = generateImprovementSuggestions();

  // ── 效率概览 ──
  const overviewEl = document.querySelector('#mdOverview');
  if (overviewEl) {
    if (agg.totalSessions === 0) {
      overviewEl.innerHTML = '<p class="text-muted" style="text-align:center;padding:40px;">暂无度量数据，开始对话后将有统计数据</p>';
    } else {
      const successRate = (agg.toolSuccessRate * 100).toFixed(1);
      const avgIter = agg.avgIterationsPerTask.toFixed(1);
      const tokenEff = agg.tokenEfficiency.toFixed(2);
      overviewEl.innerHTML = `
        <div class="md-card"><div class="md-card-value">${agg.totalSessions}</div><div class="md-card-label">会话总数</div></div>
        <div class="md-card"><div class="md-card-value">${avgIter}</div><div class="md-card-label">平均迭代轮次</div></div>
        <div class="md-card"><div class="md-card-value" style="color:var(--success)">${successRate}%</div><div class="md-card-label">工具成功率</div></div>
        <div class="md-card"><div class="md-card-value" style="color:var(--caution)">${tokenEff}</div><div class="md-card-label">Token 效率</div></div>
      `;
    }
  }

  // ── 工具热力图 ──
  const toolHeatmapEl = document.querySelector('#mdToolHeatmap');
  if (toolHeatmapEl) {
    if (history.length === 0) {
      toolHeatmapEl.innerHTML = '<p class="text-muted" style="text-align:center;padding:20px;">暂无工具调用数据</p>';
    } else {
      const toolStats = new Map<string, { success: number; error: number; cancelled: number }>();
      for (const session of history) {
        for (const tc of session.toolCalls) {
          if (!toolStats.has(tc.name)) toolStats.set(tc.name, { success: 0, error: 0, cancelled: 0 });
          const stat = toolStats.get(tc.name)!;
          if (tc.status === 'success') stat.success++;
          else if (tc.status === 'error') stat.error++;
          else stat.cancelled++;
        }
      }
      const sortedTools = [...toolStats.entries()].sort((a, b) => {
        const aTotal = a[1].success + a[1].error + a[1].cancelled;
        const bTotal = b[1].success + b[1].error + b[1].cancelled;
        return bTotal - aTotal;
      });
      const maxTotal = sortedTools.length > 0
        ? Math.max(...sortedTools.map(([_, s]) => s.success + s.error + s.cancelled))
        : 1;
      toolHeatmapEl.innerHTML = sortedTools.slice(0, 20).map(([name, stat]) => {
        const total = stat.success + stat.error + stat.cancelled;
        const successPct = (stat.success / maxTotal * 100).toFixed(1);
        const errorPct = (stat.error / maxTotal * 100).toFixed(1);
        const cancelPct = (stat.cancelled / maxTotal * 100).toFixed(1);
        return `
          <div class="md-bar-row">
            <span class="md-bar-label">${escapeHtml(name)}</span>
            <div class="md-bar">
              <div class="md-bar-success" style="width:${successPct}%"></div>
              <div class="md-bar-error" style="width:${errorPct}%"></div>
              <div class="md-bar-cancelled" style="width:${cancelPct}%"></div>
            </div>
            <span class="md-bar-count">${stat.success}/${total}</span>
          </div>
        `;
      }).join('');
    }
  }

  // ── Token 趋势 ──
  const tokenTrendEl = document.querySelector('#mdTokenTrend');
  if (tokenTrendEl) {
    if (history.length === 0) {
      tokenTrendEl.innerHTML = '<p class="text-muted" style="text-align:center;padding:20px;">暂无 Token 趋势数据</p>';
    } else {
      const recent = history.slice(-20);
      const maxTokens = Math.max(...recent.map(s => s.totalInputTokens + s.totalOutputTokens), 1);
      tokenTrendEl.innerHTML = recent.map((s, i) => {
        const inputPct = (s.totalInputTokens / maxTokens * 100).toFixed(1);
        const outputPct = (s.totalOutputTokens / maxTokens * 100).toFixed(1);
        return `
          <div class="md-token-bar" title="会话 ${i + 1}: 输入 ${s.totalInputTokens} / 输出 ${s.totalOutputTokens}">
            <div class="md-token-input" style="height:${inputPct}%"></div>
            <div class="md-token-output" style="height:${outputPct}%"></div>
            <span class="md-token-label">${i + 1}</span>
          </div>
        `;
      }).join('');
    }
  }

  // ── 改进建议 ──
  const suggestionsEl = document.querySelector('#mdSuggestions');
  if (suggestionsEl) {
    if (suggestions.length === 0) {
      suggestionsEl.innerHTML = '<p class="text-muted" style="text-align:center;padding:20px;">暂无改进建议</p>';
    } else {
      suggestionsEl.innerHTML = suggestions.map(s => `
        <div class="md-suggestion">
          <span class="md-suggestion-severity md-severity-${s.severity}">${s.severity}</span>
          <span class="md-suggestion-msg">${escapeHtml(s.suggestion)}</span>
        </div>
      `).join('');
    }
  }

  logInfo('Metrics 仪表盘已刷新', `${history.length} 个会话记录`);
}
