/**
 * 设置面板：LLM 提供商（Ollama / OpenAI 兼容 / Anthropic 兼容）、API Key、上下文长度。
 */

import { state, KEYS } from '../../state/state.js';
import { debounce } from '../../utils/utils.js';
import { logError, logSetting } from '../../services/log-service.js';
import { checkConnection, updateConnectionInfo } from '../../components/header.js';
import { loadModels, formatCtxLen, clearModelCapabilityCache } from '../../components/model-bar.js';
import { showToast } from '../../components/toast.js';
import type { OllamaAPI } from '../../api/ollama.js';
import {
  LLM_PROVIDER_LABELS,
  type LlmProvider,
  type OllamaConnectionSettings,
  type OllamaConnectionView,
} from '../../../shared/contracts/ollama.js';

let connectionView: OllamaConnectionView | null = null;

function formatCtx(n: number): string {
  if (n >= 1048576) return `${Number((n / 1048576).toFixed(1))}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

function providerOf(view: OllamaConnectionView | null): LlmProvider {
  return view?.provider ?? 'ollama';
}

function providerUrl(view: OllamaConnectionView, provider: LlmProvider): string {
  if (provider === 'openai') return view.openaiUrl;
  if (provider === 'anthropic') return view.anthropicUrl;
  return view.mode === 'local' ? view.localUrl : view.remoteUrl;
}

function providerPlaceholder(provider: LlmProvider, mode: 'local' | 'remote'): string {
  if (provider === 'openai') return 'https://api.openai.com';
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  return mode === 'local' ? 'http://127.0.0.1:11434' : 'https://ollama.com';
}

function elements() {
  return {
    providerSelect: document.querySelector('#selectLlmProvider') as HTMLSelectElement,
    modeSelect: document.querySelector('#selectOllamaMode') as HTMLSelectElement,
    urlInput: document.querySelector('#inputServerUrl') as HTMLInputElement,
    apiKeyInput: document.querySelector('#inputApiKey') as HTMLInputElement,
    remoteFields: document.querySelector('#remoteFields') as HTMLElement,
    remoteKindRow: document.querySelector('#remoteKindRow') as HTMLElement,
    remoteKindCloud: document.querySelector('#remoteKindCloud') as HTMLInputElement,
    remoteKindSelf: document.querySelector('#remoteKindSelf') as HTMLInputElement,
    remoteUnloadWrap: document.querySelector('#remoteUnloadWrap') as HTMLElement,
    remoteUnloadToggle: document.querySelector('#toggleRemoteUnload') as HTMLInputElement,
    cloudUnloadHint: document.querySelector('#cloudUnloadHint') as HTMLElement,
    providerModelRow: document.querySelector('#providerModelRow') as HTMLElement,
    providerModelInput: document.querySelector('#inputProviderModel') as HTMLInputElement,
    ctxInput: document.querySelector('#inputContextLength') as HTMLInputElement,
    ctxFormatted: document.querySelector('#ctxFormatted') as HTMLElement,
    ctxModelHint: document.querySelector('#ctxModelHint') as HTMLElement,
    keyStorageWarning: document.querySelector('#keyStorageWarning') as HTMLElement | null,
  };
}

function updateCtxDisplay(value: number): void {
  const { ctxFormatted, ctxModelHint } = elements();
  ctxFormatted.textContent = `≈ ${formatCtx(value)}`;
  const model = document.querySelector('#modelSelect') as HTMLSelectElement | null;
  const limit = Number(model?.selectedOptions?.[0]?.dataset.contextLength || 0);
  const cloudNote =
    connectionView?.provider === 'ollama' && connectionView.mode === 'remote' && connectionView.remoteKind === 'cloud'
      ? ' 云端可能忽略 num_ctx。'
      : '';
  if (limit > 0) {
    ctxModelHint.textContent = `模型上限：${formatCtx(limit)} · 实际发送 min(设置值, 模型上限)。${cloudNote}`;
  } else {
    ctxModelHint.textContent = `发送给模型的最大上下文窗口。范围 1K–4M，默认 128K；实际发送 min(设置值, 模型上限)。${cloudNote}`;
  }
}

function updateProviderUI(): void {
  const {
    providerSelect,
    modeSelect,
    urlInput,
    remoteFields,
    remoteKindRow,
    remoteKindCloud,
    remoteUnloadWrap,
    remoteUnloadToggle,
    cloudUnloadHint,
    providerModelRow,
    keyStorageWarning,
  } = elements();
  const provider = providerSelect.value as LlmProvider;
  const mode = modeSelect.value as 'local' | 'remote';
  const isOllama = provider === 'ollama';
  const isLocalOllama = isOllama && mode === 'local';
  const isCloud = isOllama && mode === 'remote' && remoteKindCloud.checked;

  modeSelect.style.display = isOllama ? '' : 'none';
  remoteFields.style.display = isLocalOllama ? 'none' : '';
  remoteKindRow.style.display = isOllama && mode === 'remote' ? '' : 'none';
  remoteUnloadWrap.style.display = isOllama && mode === 'remote' ? '' : 'none';
  remoteUnloadToggle.disabled = isCloud;
  cloudUnloadHint.style.display = isCloud ? '' : 'none';
  providerModelRow.style.display = isOllama ? 'none' : '';

  // 注意：不要在这里强制取消勾选。否则用户从自建切到 Cloud 再切回自建时，
  // 之前的自动卸载偏好会被静默清空。
  const httpWarning = document.querySelector('#remoteHttpWarning') as HTMLElement | null;
  if (httpWarning) {
    httpWarning.style.display = !isLocalOllama && /^http:\/\//i.test(urlInput.value.trim()) ? '' : 'none';
  }
  if (keyStorageWarning) {
    keyStorageWarning.style.display =
      !isLocalOllama && connectionView && !connectionView.keyStorageAvailable ? '' : 'none';
  }
}

function applyConnectionView(view: OllamaConnectionView): void {
  connectionView = view;
  state.set('connection', view);
  const {
    providerSelect,
    modeSelect,
    urlInput,
    apiKeyInput,
    remoteKindCloud,
    remoteKindSelf,
    remoteUnloadToggle,
    ctxInput,
  } = elements();
  const provider = providerOf(view);
  providerSelect.value = provider;
  modeSelect.value = view.mode;
  urlInput.value = providerUrl(view, provider);
  urlInput.placeholder = providerPlaceholder(provider, view.mode);
  remoteKindCloud.checked = view.remoteKind === 'cloud';
  remoteKindSelf.checked = view.remoteKind !== 'cloud';
  remoteUnloadToggle.checked = view.remoteAutoUnload;
  if (document.activeElement !== apiKeyInput) apiKeyInput.value = '';
  apiKeyInput.placeholder = view.hasApiKey ? 'API Key 已保存（留空保持不变）' : 'API Key（可选）';
  ctxInput.value = String(view.contextLength);
  updateCtxDisplay(view.contextLength);
  updateProviderUI();
}

export async function refreshConnectionSettingsUI(): Promise<void> {
  const view = await window.metonaDesktop?.ollama?.getConfig();
  if (view) applyConnectionView(view);
}

export function initConnectionSettings(): void {
  const {
    providerSelect,
    modeSelect,
    urlInput,
    apiKeyInput,
    remoteKindCloud,
    remoteKindSelf,
    remoteUnloadToggle,
    providerModelInput,
    ctxInput,
  } = elements();
  const bridge = window.metonaDesktop;

  const saveConnectionNow = async (): Promise<void> => {
    if (!bridge?.ollama) return;
    const provider = providerSelect.value as LlmProvider;
    const mode = modeSelect.value as 'local' | 'remote';
    const url = urlInput.value.trim();
    if (!url) return;
    const patch: Partial<OllamaConnectionSettings> = { provider };
    if (provider === 'openai') {
      patch.openaiUrl = url;
    } else if (provider === 'anthropic') {
      patch.anthropicUrl = url;
    } else if (mode === 'local') {
      patch.mode = mode;
      patch.localUrl = url;
      // 只保存当前模式的字段。不能在编辑本地地址时把 remoteKind / remoteAutoUnload
      // 重置为 false，否则用户切回远程时偏好已被静默清空。
    } else {
      patch.mode = mode;
      patch.remoteUrl = url;
      patch.remoteKind = remoteKindCloud.checked ? 'cloud' : 'self-hosted';
      if (remoteKindSelf.checked) patch.remoteAutoUnload = remoteUnloadToggle.checked;
    }
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
      const modeLabel = provider === 'ollama' ? (mode === 'local' ? '本地' : '远程') : LLM_PROVIDER_LABELS[provider];
      logSetting('LLM 连接', `${modeLabel} · ${url}`);
    } catch (err) {
      showToast(`连接设置保存失败: ${(err as Error).message}`, 'error');
      logError('连接设置保存失败', (err as Error).message);
    }
  };
  const saveConnection = debounce(saveConnectionNow, 500);

  providerSelect.addEventListener('change', async () => {
    const provider = providerSelect.value as LlmProvider;
    try {
      const view = await bridge?.ollama?.getConfig();
      if (view) {
        connectionView = view;
        urlInput.value = providerUrl(view, provider);
        urlInput.placeholder = providerPlaceholder(provider, view.mode);
      }
    } catch {
      /* 保持当前输入 */
    }
    updateProviderUI();
    // 提供商切换必须立即保存，避免用户紧接着输入 Key 时被旧配置回写覆盖。
    await saveConnectionNow();
  });

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
    updateProviderUI();
    saveConnection();
  });
  urlInput.addEventListener('input', () => {
    updateProviderUI();
    saveConnection();
  });
  remoteKindCloud.addEventListener('change', () => {
    updateProviderUI();
    saveConnection();
  });
  remoteKindSelf.addEventListener('change', () => {
    updateProviderUI();
    saveConnection();
  });
  remoteUnloadToggle.addEventListener('change', saveConnection);

  const persistApiKey = async (key: string): Promise<void> => {
    if (!bridge?.ollama) return;
    const provider = providerSelect.value as LlmProvider;
    const result =
      provider === 'ollama' ? await bridge.ollama.setApiKey(key) : await bridge.ollama.setApiKey(key, provider);
    apiKeyInput.value = '';
    if (result.success) {
      apiKeyInput.placeholder = result.error ? 'API Key 仅本次运行有效' : 'API Key 已保存（留空保持不变）';
      showToast(result.error || 'API Key 已保存', result.error ? 'warning' : 'success');
    } else {
      showToast(`API Key 保存失败: ${result.error || '未知错误'}`, 'error');
    }
    const view = await bridge.ollama.getConfig();
    applyConnectionView(view);
  };

  const commitApiKey = async (): Promise<void> => {
    const key = apiKeyInput.value.trim();
    if (!key) return;
    await persistApiKey(key);
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
  document.querySelector('#btnClearApiKey')?.addEventListener('mousedown', () => {
    // 点击“清除”时先清空输入框，避免 blur 先触发 commitApiKey 把 Key 又写回去
    apiKeyInput.value = '';
  });
  document.querySelector('#btnClearApiKey')?.addEventListener('click', async () => {
    if (!bridge?.ollama) return;
    const provider = providerSelect.value as LlmProvider;
    if (provider === 'ollama') await bridge.ollama.clearApiKey();
    else await bridge.ollama.clearApiKey(provider);
    apiKeyInput.value = '';
    apiKeyInput.placeholder = 'API Key（可选）';
    showToast('API Key 已清除', 'info');
    const view = await bridge.ollama.getConfig();
    applyConnectionView(view);
  });

  const testConnectionBtn = document.querySelector('#btnTestConnection') as HTMLButtonElement | null;
  let pendingTestKey = '';
  testConnectionBtn?.addEventListener('mousedown', () => {
    // 点击测试会先触发 Key 输入框 blur；在 blur 清空输入框前捕获用户刚输入的 Key
    pendingTestKey = apiKeyInput.value.trim();
  });
  testConnectionBtn?.addEventListener('click', async () => {
    if (!bridge?.ollama) return;
    const resultEl = document.querySelector('#connectionTestResult') as HTMLElement;
    resultEl.textContent = '测试中…';
    // 先保存当前连接（提供商/URL/模式），再提交输入框中的新 Key，最后测试。
    // 顺序不能反：applyConnectionView 会用已保存地址覆盖输入框。
    const pendingKey = pendingTestKey || apiKeyInput.value.trim();
    pendingTestKey = '';
    await saveConnectionNow();
    if (pendingKey) await persistApiKey(pendingKey);
    const result = await bridge.ollama.test();
    if (result.ok) {
      const provider = result.provider ?? (providerSelect.value as LlmProvider);
      const version = provider === 'ollama' && result.version ? ` ${result.version}` : '';
      resultEl.textContent = `✓ ${LLM_PROVIDER_LABELS[provider]}${version} · ${result.modelCount ?? 0} 个模型 · ${result.latencyMs ?? 0}ms`;
      resultEl.style.color = 'var(--success, #2e7d32)';
    } else {
      resultEl.textContent = `✗ ${result.error || '连接失败'}`;
      resultEl.style.color = 'var(--critical, #c62828)';
    }
    updateConnectionInfo();
    checkConnection();
  });

  const applyProviderModel = (): void => {
    const model = providerModelInput.value.trim();
    if (!model) return;
    const select = document.querySelector('#modelSelect') as HTMLSelectElement | null;
    if (!select) return;
    let option = Array.from(select.options).find((item) => item.value === model);
    if (!option) {
      option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    }
    select.value = model;
    select.dispatchEvent(new Event('change'));
    showToast(`已切换模型: ${model}`, 'success');
  };
  document.querySelector('#btnApplyProviderModel')?.addEventListener('click', applyProviderModel);
  providerModelInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyProviderModel();
    }
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
