/**
 * Header - 顶部导航组件
 */

import { state, KEYS } from '../state/state.js';
import { formatSize } from '../utils/utils.js';
import { OllamaAPI } from '../api/ollama.js';
import { LLM_PROVIDER_LABELS, type LlmProvider } from '../../shared/contracts/ollama.js';
import { logConnection, logError, logDebug, logInfo } from '../services/log-service.js';

let connStatusEl: HTMLElement;

function versionProvider(provider?: LlmProvider): LlmProvider {
  return provider ?? 'ollama';
}

export function initHeader(): void {
  connStatusEl = document.querySelector('#connStatus')!;
}

export async function checkConnection(): Promise<{ ok: boolean; version?: { version: string }; error?: Error }> {
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return { ok: false, error: new Error('API 未初始化') };

  connStatusEl.className = 'conn-status pending';
  connStatusEl.querySelector('.status-label')!.textContent = '连接中...';

  try {
    const version = await api.getVersion();
    const connection = state.get<{ provider?: LlmProvider } | null>('connection', null);
    const provider = version.provider ?? connection?.provider ?? 'ollama';
    const label = provider === 'ollama' ? `Ollama v${version.version}` : LLM_PROVIDER_LABELS[provider];
    connStatusEl.className = 'conn-status connected';
    connStatusEl.title = `已连接 (${label})`;
    connStatusEl.querySelector('.status-label')!.textContent = '已连接';
    logConnection('connected', label);
    return { ok: true, version };
  } catch (err) {
    connStatusEl.className = 'conn-status disconnected';
    connStatusEl.title = '未连接';
    connStatusEl.querySelector('.status-label')!.textContent = '未连接';
    logConnection('disconnected', (err as Error).message);
    return { ok: false, error: err as Error };
  }
}

export async function updateConnectionInfo(): Promise<void> {
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  const badge = document.querySelector('#connBadge')!;
  const verEl = document.querySelector('#serverVersion')!;
  const connection = state.get<{ provider?: LlmProvider; mode?: string; remoteKind?: string } | null>(
    'connection',
    null,
  );
  const provider = versionProvider(connection?.provider);
  const modeLabel =
    provider !== 'ollama'
      ? LLM_PROVIDER_LABELS[provider]
      : connection?.mode === 'remote'
        ? connection.remoteKind === 'cloud'
          ? '云端'
          : '远程'
        : '本地';

  badge.textContent = '检测中...';
  badge.className = 'status-badge warning';
  verEl.textContent = '';

  try {
    const version = await api.getVersion();
    badge.textContent = `✓ 已连接 · ${modeLabel}`;
    badge.className = 'status-badge success';
    verEl.textContent = provider === 'ollama' ? `v${version.version}` : LLM_PROVIDER_LABELS[provider];
    logInfo(`LLM 服务版本: ${version.version}（${modeLabel}）`);
  } catch (err) {
    badge.textContent = '✗ 未连接';
    badge.className = 'status-badge error';
    verEl.textContent = '';
    logError('连接检测失败', (err as Error).message);
  }
}

export async function updateRunningModels(): Promise<void> {
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  const container = document.querySelector('#runningModels')!;
  try {
    const data = await api.psModels();
    if (!data.models || data.models.length === 0) {
      container.innerHTML = '<p class="text-muted">无运行中的模型</p>';
      logDebug('运行中模型: 0');
      return;
    }
    container.innerHTML = data.models
      .map(
        (m) => `
      <div class="running-model">
        <span class="model-name">${m.name}</span>
        <span class="model-vram">${formatSize(m.size_vram || 0)} VRAM${m.context_length ? ` · ${Math.round(m.context_length / 1024)}K ctx` : ''}</span>
      </div>
    `,
      )
      .join('');
    logDebug(`运行中模型: ${data.models.length}`, data.models.map((m) => m.name).join(', '));
  } catch {
    container.innerHTML = '<p class="text-muted">无法获取运行信息</p>';
  }
}
