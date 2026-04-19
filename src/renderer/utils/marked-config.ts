/**
 * Markdown 渲染器配置
 */

import { SAFE_URI_SCHEMES } from './sanitizer.js';

// 简化的 Markdown 解析器（内联，不依赖外部 marked 库）
// 支持基本 GFM 语法：标题、粗体、斜体、代码块、链接、列表、表格

function parseMarkdown(md: string): string {
  if (!md) return '';
  let html = escapeForMd(md);

  // 代码块 ```...```
  const codeBlockRe = new RegExp('```(\\w*)\\n([\\s\\S]*?)```', 'g');
  html = html.replace(codeBlockRe, (_m, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 标题
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // 粗体+斜体
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // 粗体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 斜体
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // 删除线
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // 链接 [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    try {
      const safe = SAFE_URI_SCHEMES.has(new URL(href, 'https://placeholder').protocol);
      if (!safe) return `<span class="blocked-link">${text}</span>`;
    } catch { /* allow relative */ }
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // 图片 ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');

  // 引用块
  html = html.replace(/^>\s+(.+)$/gm, '<blockquote><p>$1</p></blockquote>');

  // 水平线
  html = html.replace(/^---+$/gm, '<hr>');

  // 无序列表
  html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // 有序列表
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // 换行
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  // 包裹在 p 标签中
  if (!html.startsWith('<')) {
    html = '<p>' + html + '</p>';
  }

  return html;
}

function escapeForMd(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export { parseMarkdown as marked };
