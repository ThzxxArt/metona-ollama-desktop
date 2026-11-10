/**
 * 设置面板：Ollama 连接、API Key、上下文长度。
 */

import { state, KEYS } from '../../state/state.js';
import { debounce } from '../../utils/utils.js';
import { logError, logSetting } from '../../services/log-service.js';
import { checkConnection, updateConnectionInfo } from '../../components/header.js';
import { loadModels, formatCtxLen, clearModelCapabilityCache } from '../../components/model-bar.js';
import { showToast } from '../../components/toast.js';
import type { OllamaAPI } from '../../api/ollama.js';
import type {
  OllamaConnectionSettings,
  OllamaConnectionView,
} from '../../../shared/contracts/ollama.js';

let connectionView: OllamaConnectionView | null = null;

function formatCtx(n: number): string {
  if (n >= 1048576) return `${Number((n / 1048576).toFixed(1))}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

function elements() {
  return {
    modeSelect: document.querySelector('#selectOllamaMode') as HTMLSelectElement,
    urlInput: document.querySelector('#inputServerUrl') as HTMLInputElement,
    apiKeyInput: document.querySelector('#inputApiKey') as HTMLInputElement,
    remoteFields: document.querySelector('#remoteFields') as HTMLElement,
    remoteKindCloud: document.querySelector('#remoteKindCloud') as HTMLInputElement,
    remoteKindSelf: document.querySelector('#remoteKindSelf') as HTMLInputElement,
    remoteUnloadToggle: document.querySelector('#toggleRemoteUnload') as HTMLInputElement,
    cloudUnloadHint: document.querySelector('#cloudUnloadHint') as HTMLElement,
    ctxInput: document.querySelector('#inputContextLength') as HTMLInputElement,
    ctxFormatted: document.querySelector('#ctxFormatted') as HTMLElement,
    ctxModelHint: document.querySelector('#ctxModelHint') as HTMLElement,
  };
}

function updateCtxDisplay(value: number): void {
  const { ctxFormatted, ctxModelHint } = elements();
  ctxFormatted.textContent = `≈ ${formatCtx(value)}`;
  const model = document.querySelector('#modelSelect') as HTMLSelectElement | null;
  const limit = Number(model?.selectedOptions?.[0]?.dataset.contextLength || 0);
  const cloudNote =
    connectionView?.mode === 'remote' && connectionView.remoteKind === 'cloud' ? ' 云端可能忽略 num_ctx。' : '';
  if (limit > 0) {
    ctxModelHint.textContent = `模型上限：${formatCtx(limit)} · 实际发送 min(设置值, 模型上限)。${cloudNote}`;
  } else {
    ctxModelHint.textContent = `发送给模型的最大上下文窗口。范围 1K–4M，默认 128K；实际发送 min(设置值, 模型上限)。${cloudNote}`;
  }
}

function updateModeUI(): void {
  const { modeSelect, urlInput, remoteFields, remoteKindCloud, remoteUnloadToggle, cloudUnloadHint } = elements();
  const mode = modeSelect.value as 'local' | 'remote';
  remoteFields.style.display = mode === 'remote' ? '' : 'none';
  const isCloud = mode === 'remote' && remoteKindCloud.checked;
  remoteUnloadToggle.disabled = isCloud;
  cloudUnloadHint.style.display = isCloud ? '' : 'none';
  if (isCloud) remoteUnloadToggle.checked = false;
  const httpWarning = document.querySelector('#remoteHttpWarning') as HTMLElement | null;
  if (httpWarning) {
    httpWarning.style.display = mode === 'remote' && /^http:\/\//i.test(urlInput.value.trim()) ? '' : 'none';
  }
}

function applyConnectionView(view: OllamaConnectionView): void {
  connectionView = view;
  state.set('connection', view);
  const {
    modeSelect,
    urlInput,
    apiKeyInput,
    remoteKindCloud,
    remoteKindSelf,
    remoteUnloadToggle,
    ctxInput,
  } = elements();
  modeSelect.value = view.mode;
  urlInput.value = view.mode === 'local' ? view.localUrl : view.remoteUrl;
  urlInput.placeholder = view.mode === 'local' ? 'http://127.0.0.1:11434' : 'https://ollama.com';
  remoteKindCloud.checked = view.remoteKind === 'cloud';
  remoteKindSelf.checked = view.remoteKind !== 'cloud';
  remoteUnloadToggle.checked = view.remoteAutoUnload;
  apiKeyInput.value = '';
  apiKeyInput.placeholder = view.hasApiKey ? 'API Key 已保存（留空保持不变）' : 'API Key（可选）';
  ctxInput.value = String(view.contextLength);
  updateCtxDisplay(view.contextLength);
  updateModeUI();
}

export async function refreshConnectionSettingsUI(): Promise<void> {
  const view = await window.metonaDesktop?.ollama?.getConfig();
  if (view) applyConnectionView(view);
}

export function initConnectionSettings(): void {
  const {
    modeSelect,
    urlInput,
    apiKeyInput,
    remoteKindCloud,
    remoteKindSelf,
    remoteUnloadToggle,
    ctxInput,
  } = elements();
  const bridge = window.metonaDesktop;

  const saveConnection = debounce(async () => {
    if (!bridge?.ollama) return;
    const mode = modeSelect.value as 'local' | 'remote';
    const url = urlInput.value.trim();
    if (!url) return;
    const patch: Partial<OllamaConnectionSettings> = {
      mode,
      remoteKind: mode === 'remote' && remoteKindCloud.checked ? 'cloud' : 'self-hosted',
      remoteAutoUnload: mode === 'remote' && remoteKindSelf.checked ? remoteUnloadToggle.checked : false,
    };
    if (mode === 'local') patch.localUrl = url;
    else patch.remoteUrl = url;
    try {
      const view = await bridge.ollama.setConfig(patch);
      applyConnectionView(view);
      const ac = state.get<AbortController | null>(KEYS.ABORT_CONTROLLER, null);
      ac?.abort();
      state.set(KEYS.IS_STREAMING, false);
      state.set(KEYS.ABORT_CONTROLLER, null);
      clearModelCapabilityCache();
      const api = state.get<OllamaAPI | null>(KEYS.API);
      if (api) await api.refreshConfig();
      updateConnectionInfo();
      checkConnection();
      loadModels();
      logSetting('Ollama 连接', `${mode === 'local' ? '本地' : '远程'} · ${url}`);
    } catch (err) {
      showToast(`连接设置保存失败: ${(err as Error).message}`, 'error');
      logError('连接设置保存失败', (err as Error).message);
    }
  }, 500);

  modeSelect.addEventListener('change', async () => {
    try {
      const view = await bridge?.ollama?.getConfig();
      if (view) {
        connectionView = view;
        urlInput.value = modeSelect.value === 'local' ? view.localUrl : view.remoteUrl;
      }
    } catch {
      /* 保持当前输入 */
    }
    updateModeUI();
    saveConnection();
  });
  urlInput.addEventListener('input', () => {
    updateModeUI();
    saveConnection();
  });
  remoteKindCloud.addEventListener('change', () => {
    updateModeUI();
    saveConnection();
  });
  remoteKindSelf.addEventListener('change', () => {
    updateModeUI();
    saveConnection();
  });
  remoteUnloadToggle.addEventListener('change', saveConnection);

  const commitApiKey = async (): Promise<void> => {
    if (!bridge?.ollama) return;
    const key = apiKeyInput.value.trim();
    if (!key) return;
    const result = await bridge.ollama.setApiKey(key);
    apiKeyInput.value = '';
    if (result.success) {
      apiKeyInput.placeholder = 'API Key 已保存（留空保持不变）';
      showToast(result.error || 'API Key 已保存', result.error ? 'warning' : 'success');
    } else {
      showToast(`API Key 保存失败: ${result.error || '未知错误'}`, 'error');
    }
    const view = await bridge.ollama.getConfig();
    applyConnectionView(view);
  };
  apiKeyInput.addEventListener('blur', () => void commitApiKey());
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitApiKey();
    }
  });
  document.querySelector('#btnToggleApiKey')?.addEventListener('click', () => {
    const show = apiKeyInput.type === 'password';
    apiKeyInput.type = show ? 'text' : 'password';
    (document.querySelector('#btnToggleApiKey') as HTMLButtonElement).textContent = show ? '隐藏' : '显示';
  });
  document.querySelector('#btnClearApiKey')?.addEventListener('click', async () => {
    if (!bridge?.ollama) return;
    await bridge.ollama.clearApiKey();
    apiKeyInput.value = '';
    apiKeyInput.placeholder = 'API Key（可选）';
    showToast('API Key 已清除', 'info');
    const view = await bridge.ollama.getConfig();
    applyConnectionView(view);
  });

  document.querySelector('#btnTestConnection')?.addEventListener('click', async () => {
    if (!bridge?.ollama) return;
    const resultEl = document.querySelector('#connectionTestResult') as HTMLElement;
    resultEl.textContent = '测试中…';
    await saveConnection();
    const result = await bridge.ollama.test();
    if (result.ok) {
      resultEl.textContent = `✓ Ollama ${result.version || ''} · ${result.modelCount ?? 0} 个模型 · ${result.latencyMs ?? 0}ms`;
      resultEl.style.color = 'var(--success, #2e7d32)';
    } else {
      resultEl.textContent = `✗ ${result.error || '连接失败'}`;
      resultEl.style.color = 'var(--critical, #c62828)';
    }
    updateConnectionInfo();
    checkConnection();
  });

  const saveContextLength = debounce(async () => {
    if (!bridge?.ollama) return;
    const raw = ctxInput.value.trim();
    let value = parseInt(raw, 10);
    if (!Number.isFinite(value)) value = 131072;
    const clamped = Math.min(4194304, Math.max(1024, value));
    if (clamped !== value) {
      showToast(`上下文长度已钳制到 ${clamped}`, 'warning');
      ctxInput.value = String(clamped);
    }
    updateCtxDisplay(clamped);
    const view = await bridge.ollama.setConfig({ contextLength: clamped });
    applyConnectionView(view);
    const api = state.get<OllamaAPI | null>(KEYS.API);
    if (api) await api.refreshConfig();
    state.set(KEYS.NUM_CTX, clamped);
    logSetting('上下文长度', formatCtxLen(clamped));
  }, 500);
  ctxInput.addEventListener('input', () => {
    const n = parseInt(ctxInput.value, 10);
    updateCtxDisplay(Number.isFinite(n) ? n : 131072);
  });
  ctxInput.addEventListener('change', saveContextLength);
  ctxInput.addEventListener('blur', saveContextLength);
}
