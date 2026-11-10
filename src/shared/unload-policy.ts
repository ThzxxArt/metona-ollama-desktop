/**
 * 远程模型卸载策略（纯函数）
 */

import type { OllamaConnectionSettings } from './contracts/ollama.js';

export interface UnloadPolicyInput {
  mode: OllamaConnectionSettings['mode'];
  remoteKind: OllamaConnectionSettings['remoteKind'];
  remoteAutoUnload: boolean;
}

/** 是否应该执行卸载；manual=true 时忽略自动卸载开关，但云服务始终跳过 */
export function shouldUnloadModels(settings: UnloadPolicyInput, manual = false): boolean {
  if (settings.mode === 'local') return true;
  if (settings.remoteKind === 'cloud') return false;
  if (manual) return true;
  return settings.remoteAutoUnload;
}
