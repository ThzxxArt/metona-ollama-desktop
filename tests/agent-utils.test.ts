// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  generateId,
  formatTime,
  truncate,
  debounce,
  formatSize,
  escapeHtml,
  stableStringify,
  detectLanguage,
} from '../src/renderer/utils/utils.js';
import { sanitize } from '../src/renderer/utils/sanitizer.js';
import { marked } from '../src/renderer/utils/marked-config.js';

describe('utils 全量', () => {
  it('generateId 唯一', () => {
    expect(generateId()).not.toBe(generateId());
  });

  it('formatTime 补零', () => {
    expect(formatTime(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02 03:04:05');
  });

  it('truncate 空值与超长', () => {
    expect(truncate('')).toBe('');
    expect(truncate('abcdef', 3)).toBe('abc...');
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('debounce 延迟执行并可重置', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced('a');
    debounced('b');
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledWith('b');
    vi.useRealTimers();
  });

  it('formatSize 单位换算', () => {
    expect(formatSize(0)).toBe('');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1024 ** 2)).toBe('1.0 MB');
  });

  it('escapeHtml 处理特殊字符与空值', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('stableStringify 递归排序与原始值', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify([2, 1])).toBe('[2,1]');
    expect(stableStringify(undefined)).toBe('undefined');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify('x')).toBe('"x"');
  });

  it('detectLanguage 常见与未知扩展名', () => {
    expect(detectLanguage('a.ts')).toBe('typescript');
    expect(detectLanguage('a.py')).toBe('python');
    expect(detectLanguage('a.unknown')).toBe('unknown');
    expect(detectLanguage('noext')).toBe('noext');
  });
});

describe('sanitize', () => {
  it('移除 script 与事件属性', () => {
    const out = sanitize('<div onclick="alert(1)">x<script>alert(1)</script></div>');
    expect(out).toContain('x');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
  });

  it('保留安全标签与 data image', () => {
    const out = sanitize('<img src="data:image/png;base64,AAA" alt="a"><a href="https://x" target="_blank">link</a>');
    expect(out).toContain('data:image/png');
    expect(out).toContain('https://x');
  });

  it('移除 javascript 协议链接', () => {
    const out = sanitize('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
  });

  it('保留相对路径与锚点链接', () => {
    const out = sanitize(
      '<a href="./a.md">a</a><a href="../b.md">b</a><a href="/c.md">c</a><a href="#d">d</a><a href="?q=1">q</a>',
    );
    expect(out).toContain('href="./a.md"');
    expect(out).toContain('href="../b.md"');
    expect(out).toContain('href="/c.md"');
    expect(out).toContain('href="#d"');
    expect(out).toContain('href="?q=1"');
  });
});

describe('marked', () => {
  it('空字符串返回空', () => {
    expect(marked('')).toBe('');
  });

  it('渲染标题、列表与代码块', () => {
    const out = marked('# Title\n\n- a\n- b\n\n```ts\nconst x = 1;\n```');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<li>a</li>');
    expect(out).toContain('const x = 1;');
  });

  it('安全链接保留 href', () => {
    const out = marked('[x](https://example.com)');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('>x</a>');
  });

  it('不安全协议链接被阻断为 span', () => {
    const out = marked('[x](javascript:alert(1))');
    expect(out).toContain('blocked-link');
    expect(out).not.toContain('javascript:');
  });

  it('绝对图片地址保留 src', () => {
    const out = marked('![alt](https://example.com/a.png)');
    expect(out).toContain('src="https://example.com/a.png"');
    expect(out).toContain('alt="alt"');
  });

  it('不安全图片协议被阻断', () => {
    const out = marked('![alt](javascript:alert(1))');
    expect(out).toContain('blocked-link');
  });

  it('图片无 alt 时使用默认文案', () => {
    const out = marked('![](javascript:alert(1))');
    expect(out).toContain('图片');
  });
});
