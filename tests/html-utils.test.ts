import { describe, it, expect } from 'vitest';
import {
  decodeHTMLEntities,
  htmlToText,
  htmlToMarkdown,
  isBlockedPage,
  computeRelevance,
} from '../src/main/html-utils.js';

describe('decodeHTMLEntities', () => {
  it('解码常见命名实体', () => {
    expect(decodeHTMLEntities('&lt;div&gt;&amp;&quot;x&quot;')).toBe('<div>&"x"');
    expect(decodeHTMLEntities('&nbsp;')).toBe(' ');
  });

  it('解码十进制数字实体', () => {
    expect(decodeHTMLEntities('&#65;&#66;')).toBe('AB');
  });

  it('解码十六进制数字实体', () => {
    expect(decodeHTMLEntities('&#x41;&#x42;')).toBe('AB');
  });

  it('无实体时原样返回', () => {
    expect(decodeHTMLEntities('plain text')).toBe('plain text');
  });

  it('多实体混合解码', () => {
    expect(decodeHTMLEntities('&copy; 2026 &mdash; &euro;10')).toBe('\u00A9 2026 \u2014 \u20AC10');
  });
});

describe('htmlToText', () => {
  it('移除 script/style 噪音标签', () => {
    const html = '<html><body><script>alert(1)</script><p>正文内容</p><style>body{display:none}</style></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('正文内容');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('display:none');
  });

  it('块级标签转为换行', () => {
    const text = htmlToText('<div>第一段</div><div>第二段</div>');
    expect(text).toContain('第一段');
    expect(text).toContain('第二段');
  });

  it('去除剩余标签并解码实体', () => {
    const text = htmlToText('<p>hello &amp; goodbye</p>');
    expect(text).toBe('hello & goodbye');
  });

  it('空输入返回空', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('htmlToMarkdown', () => {
  it('标题转为 Markdown 标题', () => {
    const md = htmlToMarkdown('<h1>大标题</h1><h2>副标题</h2>');
    expect(md).toContain('# 大标题');
    expect(md).toContain('## 副标题');
  });

  it('链接转为 Markdown 链接', () => {
    const md = htmlToMarkdown('<a href="https://example.com">example</a>');
    expect(md).toContain('[example](https://example.com)');
  });

  it('代码块转为围栏代码', () => {
    const md = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
    expect(md).toContain('```');
    expect(md).toContain('const x = 1;');
  });

  it('列表项转为 - 列表', () => {
    const md = htmlToMarkdown('<ul><li>项目A</li><li>项目B</li></ul>');
    expect(md).toContain('- 项目A');
    expect(md).toContain('- 项目B');
  });

  it('加粗/斜体标签转换', () => {
    const md = htmlToMarkdown('<strong>加粗</strong><em>斜体</em>');
    expect(md).toContain('**加粗**');
    expect(md).toContain('*斜体*');
  });
});

describe('isBlockedPage', () => {
  it('短内容视为拦截页', () => {
    expect(isBlockedPage('<html></html>')).toBe(true);
  });

  it('Cloudflare 拦截特征', () => {
    const html = '<html><head><title>Just a moment...</title></head></html>'.repeat(5);
    expect(isBlockedPage(html)).toBe(true);
  });

  it('403 拦截特征', () => {
    const html = '<title>403 Forbidden</title>'.repeat(10);
    expect(isBlockedPage(html)).toBe(true);
  });

  it('验证码特征', () => {
    const html = '请启用JavaScript'.repeat(10);
    expect(isBlockedPage(html)).toBe(true);
  });

  it('正常长页面不视为拦截', () => {
    const html = '<html><body>' + '<p>正常内容</p>'.repeat(50) + '</body></html>';
    expect(isBlockedPage(html)).toBe(false);
  });
});

describe('computeRelevance', () => {
  it('无 query 返回中性 50 分', () => {
    expect(computeRelevance('', '标题', '摘要')).toBe(50);
  });

  it('CJK 关键词命中标题得高分', () => {
    const score = computeRelevance('rust 语言', 'Rust 语言教程', '本教程介绍 rust');
    expect(score).toBeGreaterThanOrEqual(25);
  });

  it('英文词命中标题得 15 分', () => {
    const score = computeRelevance('rust backend', 'rust backend guide', 'a guide');
    expect(score).toBeGreaterThanOrEqual(15);
  });

  it('完全无关标题得 0 分', () => {
    const score = computeRelevance('rust', 'cooking recipes', 'food');
    expect(score).toBe(0);
  });

  it('得分上限 100', () => {
    const score = computeRelevance('rust language guide', 'rust language guide', 'rust language guide');
    expect(score).toBeLessThanOrEqual(100);
  });
});
