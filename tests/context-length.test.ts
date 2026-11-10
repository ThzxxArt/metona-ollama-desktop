import { describe, it, expect } from 'vitest';
import { DEFAULT_CONTEXT_LENGTH, MAX_CONTEXT_LENGTH, MIN_CONTEXT_LENGTH } from '../src/shared/contracts/ollama.js';
import { clampContextLength, formatContextLength } from '../src/shared/context-length.js';

describe('clampContextLength', () => {
  it('默认 131072', () => {
    expect(DEFAULT_CONTEXT_LENGTH).toBe(131072);
    expect(clampContextLength(undefined)).toBe(131072);
    expect(clampContextLength('abc')).toBe(131072);
  });

  it('越界钳制', () => {
    expect(clampContextLength(1)).toBe(MIN_CONTEXT_LENGTH);
    expect(clampContextLength(MAX_CONTEXT_LENGTH + 1)).toBe(MAX_CONTEXT_LENGTH);
  });

  it('合法值四舍五入', () => {
    expect(clampContextLength(32768)).toBe(32768);
    expect(clampContextLength(32768.6)).toBe(32769);
  });
});

describe('formatContextLength', () => {
  it('K / M 格式化', () => {
    expect(formatContextLength(8192)).toBe('8K');
    expect(formatContextLength(131072)).toBe('128K');
    expect(formatContextLength(1048576)).toBe('1M');
  });
});
