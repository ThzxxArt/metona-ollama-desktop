/**
 * Calculator — 安全数学计算器（纯 JS 递归下降解析，无 eval）
 * 独立纯函数模块，便于单元测试。
 */

import type { ToolResult } from './tool-handlers-shared.js';

export function handleCalculator(params: { expression: string }): ToolResult {
  try {
    const expr = params.expression;
    if (!expr || expr.length > 500) {
      return { success: false, error: '表达式为空或过长（最大500字符）' };
    }
    const result = safeCalc(expr);
    return { success: true, expression: expr, result };
  } catch (err) {
    return { success: false, error: (err as Error).message, expression: params.expression };
  }
}

function safeCalc(expr: string): number {
  expr = expr.replace(/\s+/g, '');
  if (!/^[\d+\-*/().%]+$/.test(expr)) {
    throw new Error('表达式包含非法字符');
  }
  let pos = 0;

  function parseExpression(): number {
    let left = parseTerm();
    while (pos < expr.length) {
      if (expr[pos] === '+') { pos++; left += parseTerm(); }
      else if (expr[pos] === '-') { pos++; left -= parseTerm(); }
      else break;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parsePower();
    while (pos < expr.length) {
      if (expr[pos] === '*') { pos++; left *= parsePower(); }
      else if (expr[pos] === '/') { pos++; const d = parsePower(); if (d === 0) throw new Error('除数不能为零'); left /= d; }
      else if (expr[pos] === '%') { pos++; left %= parsePower(); }
      else break;
    }
    return left;
  }

  function parsePower(): number {
    let left = parseUnary();
    while (pos + 1 < expr.length && expr[pos] === '*' && expr[pos + 1] === '*') {
      pos += 2;
      left = Math.pow(left, parseUnary());
    }
    return left;
  }

  function parseUnary(): number {
    if (expr[pos] === '-') { pos++; return -parseAtom(); }
    if (expr[pos] === '+') { pos++; return parseAtom(); }
    return parseAtom();
  }

  function parseAtom(): number {
    if (expr[pos] === '(') {
      pos++;
      const val = parseExpression();
      if (pos >= expr.length || expr[pos] !== ')') throw new Error('缺少右括号');
      pos++;
      return val;
    }
    const start = pos;
    while (pos < expr.length && /[\d.]/.test(expr[pos])) pos++;
    if (start === pos) throw new Error(`意外字符: ${expr[pos] || 'EOF'}`);
    const num = parseFloat(expr.slice(start, pos));
    if (isNaN(num)) throw new Error(`无效数字: ${expr.slice(start, pos)}`);
    return num;
  }

  const result = parseExpression();
  if (pos < expr.length) throw new Error(`表达式末尾有意外字符: ${expr.slice(pos)}`);
  if (!isFinite(result)) throw new Error('计算结果为无穷大');
  return result;
}
