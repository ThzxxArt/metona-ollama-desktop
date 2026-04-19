/**
 * Sanitizer — 基于 DOMPurify 的 HTML 净化器
 */

import DOMPurify from '../../vendor/dompurify.js';

// 允许的 data URI 类型
const SAFE_DATA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

/**
 * 净化 HTML，移除危险标签和属性
 */
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div',
      'dl', 'dt', 'dd', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
      'i', 'img', 'ins', 'kbd', 'li', 'ol', 'p', 'pre', 'q', 'rp', 'rt',
      'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub',
      'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
      'tr', 'u', 'ul', 'var', 'input',
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'width', 'height', 'align',
      'target', 'rel', 'class', 'id', 'type', 'checked', 'disabled',
      'start', 'value', 'scope', 'rowspan', 'colspan', 'lang',
    ],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|ftp|ftps|mailto|tel|xmpp):|data:image\/(?:png|jpeg|gif|webp|svg\+xml);)/i,
    ADD_ATTR: ['target'],
  });
}
