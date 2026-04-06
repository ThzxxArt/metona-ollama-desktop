/**
 * Utils - 通用工具函数
 */

/** 生成唯一 ID */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/** 格式化时间戳 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 截断文本 */
export function truncate(str: string, len = 50): string {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

/** 防抖 */
export function debounce<T extends (...args: unknown[]) => unknown>(fn: T, ms = 300): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** 格式化字节大小 */
export function formatSize(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

/** HTML 转义 */
export function escapeHtml(str: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, (c) => map[c]);
}

/** 根据文件名检测语言标识（用于 Markdown 代码块） */
export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    py: 'python', pyw: 'python', pyi: 'python',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
    java: 'java', class: 'java',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
    sql: 'sql', html: 'html', htm: 'html', css: 'css',
    json: 'json', jsonl: 'json',
    xml: 'xml', svg: 'svg',
    yaml: 'yaml', yml: 'yaml', toml: 'toml',
    ini: 'ini', cfg: 'ini', conf: 'ini',
    md: 'markdown', markdown: 'markdown', rst: 'rst',
    txt: '', csv: 'csv', tsv: 'csv', log: '',
    swift: 'swift', kt: 'kotlin', kts: 'kotlin',
    scala: 'scala', lua: 'lua', pl: 'perl', r: 'r',
    m: 'matlab', mm: 'objectivec',
    cs: 'csharp', fs: 'fsharp', vb: 'vbnet',
    ex: 'elixir', exs: 'elixir', erl: 'erlang',
    hs: 'haskell', clj: 'clojure', lisp: 'lisp',
    dockerfile: 'dockerfile', makefile: 'makefile',
    diff: 'diff', patch: 'diff',
  };
  return map[ext] ?? ext;
}
