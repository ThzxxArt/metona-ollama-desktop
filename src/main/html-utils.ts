/**
 * HTML 工具函数 — 从 tool-handlers-system.ts 抽取的纯函数（无 electron/fs 依赖）
 * 便于单元测试与复用：实体解码、HTML→文本、HTML→Markdown、拦截页检测、搜索相关性评分。
 */

/** 完整 HTML 实体映射（常见实体） */
const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&ensp;': ' ', '&emsp;': ' ',
  '&copy;': '\u00A9', '&reg;': '\u00AE', '&trade;': '\u2122', '&euro;': '\u20AC',
  '&pound;': '\u00A3', '&yen;': '\u00A5', '&deg;': '\u00B0', '&middot;': '\u00B7',
  '&hellip;': '\u2026', '&mdash;': '\u2014', '&ndash;': '\u2013',
  '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
  '&bull;': '\u2022',
  '&times;': '\u00D7', '&divide;': '\u00F7', '&plusmn;': '\u00B1', '&micro;': '\u00B5',
  '&para;': '\u00B6', '&sect;': '\u00A7', '&laquo;': '\u00AB', '&raquo;': '\u00BB',
  '&iexcl;': '\u00A1', '&iquest;': '\u00BF', '&not;': '\u00AC', '&shy;': '\u00AD',
  '&macr;': '\u00AF', '&acute;': '\u00B4', '&cedil;': '\u00B8',
  '&OElig;': '\u0152', '&oelig;': '\u0153', '&Scaron;': '\u0160', '&scaron;': '\u0161',
  '&Yuml;': '\u0178', '&circ;': '\u02C6', '&tilde;': '\u02DC',
};

/** 解码 HTML 实体 */
export function decodeHTMLEntities(text: string): string {
  let result = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    result = result.replaceAll(entity, char);
  }
  // 数字实体: &#123; 和 &#x1F;
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  result = result.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  return result;
}

/** 将 HTML 转换为可读文本（保留结构） */
export function htmlToText(html: string): string {
  let text = html;
  // 移除 script/style/nav/header/footer 等噪音标签及其内容
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
  text = text.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  // 移除 HTML 注释
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // 块级标签转为换行
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre|br|hr)[^>]*>/gi, '\n');
  text = text.replace(/<(br|hr)[^>]*\/?>/gi, '\n');
  // 表格单元用制表符分隔
  text = text.replace(/<\/(td|th)[^>]*>/gi, '\t');
  // 移除剩余标签
  text = text.replace(/<[^>]+>/g, '');
  // 解码 HTML 实体
  text = decodeHTMLEntities(text);
  // 清理多余空白（保留换行结构）
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  text = text.split('\n').map(l => l.trim()).join('\n');
  return text.trim();
}

/** HTML → Markdown 转换（保留标题、列表、链接、代码块等结构） */
export function htmlToMarkdown(html: string): string {
  let text = html;
  // 移除 script/style/nav/header/footer 等噪音标签
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
  text = text.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 标题 → Markdown 标题
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

  // 代码块
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // 链接和图片
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, '![$2]($1)');
  text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![]($1)');

  // 列表
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');

  // 引用块
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');

  // 表格行
  text = text.replace(/<\/tr>/gi, '|\n');
  text = text.replace(/<tr[^>]*>/gi, '|');
  text = text.replace(/<\/?(td|th)[^>]*>/gi, '');

  // 块级标签转为换行
  text = text.replace(/<\/(p|div|section|article)[^>]*>/gi, '\n');
  text = text.replace(/<(br|hr)[^>]*\/?>/gi, '\n');

  // 加粗/斜体
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

  // 移除剩余标签
  text = text.replace(/<[^>]+>/g, '');
  // 解码 HTML 实体
  text = decodeHTMLEntities(text);
  // 清理多余空白
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  text = text.split('\n').map(l => l.trim()).join('\n');
  return text.trim();
}

/** 被拦截页面特征模式 */
const BLOCKED_PATTERNS = [
  /<title>\s*(Just a moment\.\.\.|Attention Required!|Cloudflare)\s*<\/title>/i,
  /challenge-platform/i,
  /\.cf-challenge-/i,
  /<title>\s*Access Denied\s*<\/title>/i,
  /<title>\s*403 Forbidden\s*<\/title>/i,
  /请启用JavaScript/i,
  /Please enable JavaScript/i,
  /Checking your browser/i,
  /DDoS protection/i,
];

/** 检测是否为被拦截页面（Cloudflare/403/验证码/空白页） */
export function isBlockedPage(html: string): boolean {
  if (html.length < 80) return true;
  for (const p of BLOCKED_PATTERNS) { if (p.test(html)) return true; }
  return false;
}

/** 计算搜索结果标题与搜索 query 的相关性得分
 *  提取 query 中的关键词（CJK 字符取 2-4 字片段，英文取单词），
 *  检查标题中是否包含这些关键词。返回 0-100 的得分 */
export function computeRelevance(query: string, title: string, snippet: string): number {
  if (!query) return 50; // 无 query 信息时不做过滤
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  const s = (snippet || '').toLowerCase();
  let score = 0;

  // 1) 提取 query 中的 CJK 双/三字片段
  const cjkTokens: string[] = [];
  for (let i = 0; i < q.length; i++) {
    if (/[\u4e00-\u9fff]/.test(q[i])) {
      if (i + 1 < q.length && /[\u4e00-\u9fff]/.test(q[i + 1])) {
        cjkTokens.push(q.slice(i, i + 2));
        if (i + 2 < q.length && /[\u4e00-\u9fff]/.test(q[i + 2])) {
          cjkTokens.push(q.slice(i, i + 3));
        }
      }
    }
  }
  // 去重
  const uniqueCJK = [...new Set(cjkTokens)];

  // 2) 提取英文单词（≥2 个字符）
  const enWords = q.match(/[a-z]{2,}/g) || [];

  // 3) 标题匹配计分
  for (const token of uniqueCJK) {
    if (t.includes(token)) { score += 25; break; } // 命中一个 CJK 片段即可
  }
  for (const word of enWords) {
    if (t.includes(word)) score += 15;
  }
  // 摘要匹配加成
  for (const token of uniqueCJK.slice(0, 3)) {
    if (s.includes(token)) score += 5;
  }
  for (const word of enWords.slice(0, 3)) {
    if (s.includes(word)) score += 3;
  }

  return Math.min(100, score);
}
