import { describe, it, expect } from 'vitest';
import {
  generateId,
  formatTime,
  truncate,
  formatSize,
  escapeHtml,
  detectLanguage,
} from '../src/renderer/utils/utils.js';

describe('generateId', () => {
  it('生成唯一 ID', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });
});

describe('formatTime', () => {
  it('格式化为 YYYY-MM-DD HH:MM:SS', () => {
    const ts = new Date(2026, 7, 26, 14, 30, 5).getTime();
    const out = formatTime(ts);
    expect(out).toMatch(/^2026-08-26 14:30:05$/);
  });
});

describe('truncate', () => {
  it('短文本原样返回', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('超长文本截断加省略号', () => {
    expect(truncate('x'.repeat(20), 5)).toBe('xxxxx...');
  });

  it('空字符串返回空', () => {
    expect(truncate('')).toBe('');
  });
});

describe('formatSize', () => {
  it('字节格式化到适当单位', () => {
    expect(formatSize(0)).toBe('');
    expect(formatSize(512)).toBe('512.0 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('大数值进位到 TB', () => {
    expect(formatSize(1024 ** 4)).toBe('1.0 TB');
  });
});

describe('escapeHtml', () => {
  it('转义 HTML 特殊字符', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('转义单引号与 &', () => {
    expect(escapeHtml("a'b & c")).toBe('a&#39;b &amp; c');
  });

  it('null/undefined 返回空串', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('数字值被字符串化并转义', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('detectLanguage', () => {
  it('常见扩展名识别', () => {
    expect(detectLanguage('main.ts')).toBe('typescript');
    expect(detectLanguage('app.py')).toBe('python');
    expect(detectLanguage('index.js')).toBe('javascript');
    expect(detectLanguage('style.css')).toBe('css');
    expect(detectLanguage('data.json')).toBe('json');
  });

  it('特殊文件名识别', () => {
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('Makefile')).toBe('makefile');
  });

  it('未知扩展名返回自身', () => {
    // 有扩展名：未知映射返回扩展名本身
    expect(detectLanguage('file.xyz')).toBe('xyz');
    // 无扩展名：split 后 pop 得到整个文件名，未命中映射返回原值
    expect(detectLanguage('noext')).toBe('noext');
  });

  it('大小写不敏感', () => {
    expect(detectLanguage('MAIN.TS')).toBe('typescript');
  });
});
