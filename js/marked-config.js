/**
 * Markdown 渲染器配置
 * 封装 marked.js，配置自定义渲染器和安全策略
 */

import { marked } from '../marked.esm.js';
import { SAFE_URI_SCHEMES } from './sanitizer.js';

// 配置 marked
marked.setOptions({
    breaks: true,  // 换行转 <br>
    gfm: true,     // GitHub 风格 Markdown
});

// 自定义渲染器：链接新窗口打开 + 安全属性
const renderer = new marked.Renderer();

renderer.link = function ({ href, title, text }) {
    const safe = SAFE_URI_SCHEMES.has(new URL(href, 'https://placeholder').protocol);
    const t = title ? ` title="${title}"` : '';
    if (!safe) {
        return `<span class="blocked-link" title="已阻止不安全链接">${text}</span>`;
    }
    return `<a href="${href}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

renderer.image = function ({ href, title, text }) {
    const safe = SAFE_URI_SCHEMES.has(new URL(href, 'https://placeholder').protocol);
    if (!safe && !/^data:image\//i.test(href)) {
        return `<span class="blocked-link">[已阻止不安全图片: ${text}]</span>`;
    }
    const t = title ? ` title="${title}"` : '';
    return `<img src="${href}" alt="${text}"${t} loading="lazy">`;
};

marked.use({ renderer });

export { marked };
