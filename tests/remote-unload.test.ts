import { describe, it, expect } from 'vitest';
import { shouldUnloadModels } from '../src/shared/unload-policy.js';

describe('shouldUnloadModels — 远程卸载策略', () => {
  it('本地始终卸载', () => {
    expect(shouldUnloadModels({ mode: 'local', remoteKind: 'self-hosted', remoteAutoUnload: false }, false)).toBe(true);
  });

  it('自建远程默认自动卸载', () => {
    expect(shouldUnloadModels({ mode: 'remote', remoteKind: 'self-hosted', remoteAutoUnload: true }, false)).toBe(true);
  });

  it('自建远程关闭开关后不自动卸载，但手动仍可', () => {
    const settings = { mode: 'remote' as const, remoteKind: 'self-hosted' as const, remoteAutoUnload: false };
    expect(shouldUnloadModels(settings, false)).toBe(false);
    expect(shouldUnloadModels(settings, true)).toBe(true);
  });

  it('Ollama Cloud 永不卸载（自动/手动都不行）', () => {
    const settings = { mode: 'remote' as const, remoteKind: 'cloud' as const, remoteAutoUnload: true };
    expect(shouldUnloadModels(settings, false)).toBe(false);
    expect(shouldUnloadModels(settings, true)).toBe(false);
  });
});
