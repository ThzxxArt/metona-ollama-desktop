/**
 * Markdown 渲染器配置 — 基于 marked 库
 */

import { marked as markedLib, Renderer } from '../../vendor/marked.js';
import { sanitize } from './sanitizer.js';

// 自定义渲染器：链接安全检查
const renderer = new Renderer();
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:', 'ftps:', 'xmpp:']);

renderer.link = function ({ href, text, tokens }) {
  try {
    const protocol = new URL(href, 'https://placeholder').protocol;
    if (!SAFE_SCHEMES.has(protocol)) {
      return `<span class="blocked-link">${text}</span>`;
    }
  } catch { /* 允许相对路径 */ }
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
};

renderer.image = function ({ href, text }) {
  try {
    const protocol = new URL(href, 'https://placeholder').protocol;
    if (!SAFE_SCHEMES.has(protocol)) {
      return `<span class="blocked-link">${text || '图片'}</span>`;
    }
  } catch { /* 允许相对路径 */ }
  return `<img src="${href}" alt="${text || ''}" loading="lazy">`;
};

// 配置 marked
markedLib.use({
  renderer,
  gfm: true,
  breaks: true,
});

/**
 * 解析 Markdown 并净化 HTML 输出
 */
export function marked(md: string): string {
  if (!md) return '';
  const raw = markedLib.parse(md) as string;
  return sanitize(raw);
}
