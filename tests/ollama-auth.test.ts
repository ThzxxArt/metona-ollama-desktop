import { describe, it, expect } from 'vitest';
import { buildOllamaHeaders } from '../src/shared/ollama-auth.js';

describe('buildOllamaHeaders — Authorization 规则', () => {
  it('无 Key 时不发送 Authorization', () => {
    const headers = buildOllamaHeaders(null);
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('空字符串 / 空白 Key 不发送 Authorization', () => {
    expect(buildOllamaHeaders('').Authorization).toBeUndefined();
    expect(buildOllamaHeaders('   ').Authorization).toBeUndefined();
  });

  it('有 Key 时发送 Bearer', () => {
    expect(buildOllamaHeaders('sk-test-123').Authorization).toBe('Bearer sk-test-123');
  });

  it('保留额外请求头', () => {
    const headers = buildOllamaHeaders('k', { 'X-Test': '1' });
    expect(headers['X-Test']).toBe('1');
    expect(headers.Authorization).toBe('Bearer k');
  });
});
