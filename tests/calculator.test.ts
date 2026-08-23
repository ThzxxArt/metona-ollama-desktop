import { describe, it, expect } from 'vitest';
import { handleCalculator } from '../src/main/calculator.js';

describe('handleCalculator', () => {
  it('基础四则运算', () => {
    expect(handleCalculator({ expression: '1 + 2' }).result).toBe(3);
    expect(handleCalculator({ expression: '10 - 4' }).result).toBe(6);
    expect(handleCalculator({ expression: '6 * 7' }).result).toBe(42);
    expect(handleCalculator({ expression: '10 / 4' }).result).toBe(2.5);
  });

  it('运算优先级与括号', () => {
    expect(handleCalculator({ expression: '2 + 3 * 4' }).result).toBe(14);
    expect(handleCalculator({ expression: '(2 + 3) * 4' }).result).toBe(20);
    expect(handleCalculator({ expression: '2 * (3 + (4 - 1))' }).result).toBe(12);
  });

  it('幂运算与取模', () => {
    expect(handleCalculator({ expression: '2 ** 10' }).result).toBe(1024);
    expect(handleCalculator({ expression: '10 % 3' }).result).toBe(1);
  });

  it('一元负号', () => {
    expect(handleCalculator({ expression: '-5 + 3' }).result).toBe(-2);
    expect(handleCalculator({ expression: '2 * -3' }).result).toBe(-6);
  });

  it('小数与空白字符', () => {
    expect(handleCalculator({ expression: ' 1.5  *  2 ' }).result).toBe(3);
  });

  it('除零报错', () => {
    const r = handleCalculator({ expression: '1 / 0' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('除数不能为零');
  });

  it('非法字符拒绝（无 eval，防注入）', () => {
    expect(handleCalculator({ expression: 'process.exit(1)' }).success).toBe(false);
    expect(handleCalculator({ expression: '1;require("fs")' }).success).toBe(false);
    expect(handleCalculator({ expression: 'alert(1)' }).success).toBe(false);
  });

  it('括号不闭合报错', () => {
    expect(handleCalculator({ expression: '(1 + 2' }).success).toBe(false);
  });

  it('空表达式与超长表达式拒绝', () => {
    expect(handleCalculator({ expression: '' }).success).toBe(false);
    expect(handleCalculator({ expression: '1'.repeat(501) }).success).toBe(false);
  });

  it('结果非有限数报错', () => {
    const r = handleCalculator({ expression: '2 ** 10000' });
    expect(r.success).toBe(false);
  });
});
