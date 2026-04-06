/**
 * Sanitizer - HTML 净化器
 */

export const SAFE_URI_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:', 'ftps:', 'xmpp:']);
const SAFE_DATA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div',
  'dl', 'dt', 'dd', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'i', 'img', 'ins', 'kbd', 'li', 'ol', 'p', 'pre', 'q', 'rp', 'rt',
  'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul', 'var', 'input',
]);

const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'width', 'height', 'align',
  'target', 'rel', 'class', 'id', 'type', 'checked', 'disabled',
  'start', 'value', 'scope', 'rowspan', 'colspan', 'lang',
]);

const DANGEROUS_PREFIXES = ['on', 'xlink:href', 'xmlns:'];

export function sanitize(html: string): string {
  try {
    const template = document.createElement('template');
    template.innerHTML = html;
    const root = template.content;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const comments: Comment[] = [];
    while (walker.nextNode()) comments.push(walker.currentNode as Comment);
    comments.forEach(c => c.remove());

    const elements = [...root.querySelectorAll('*')];
    for (const el of elements) {
      if (!el.parentNode) continue;
      const tag = el.tagName.toLowerCase();

      if (!ALLOWED_TAGS.has(tag)) {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
        continue;
      }

      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (DANGEROUS_PREFIXES.some(p => name.startsWith(p))) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (!ALLOWED_ATTRS.has(name)) {
          el.removeAttribute(attr.name);
          continue;
        }
        if ((name === 'href' || name === 'src' || name === 'action') && attr.value) {
          const val = attr.value.trim().toLowerCase();
          if (/^(javascript|vbscript|data|file):/i.test(val)) {
            const mimeMatch = val.match(/^data:([^;,]+)/i);
            if (!mimeMatch || !SAFE_DATA_TYPES.has(mimeMatch[1].toLowerCase())) {
              el.removeAttribute(attr.name);
            }
          }
        }
      }
    }

    return root.innerHTML;
  } catch (e) {
    console.warn('[Sanitizer] 净化失败:', e);
    return html;
  }
}
