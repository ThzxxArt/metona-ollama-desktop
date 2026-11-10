import { describe, it, expect } from 'vitest';
import {
  validateToolArgs,
  coerceToolArgs,
  truncateToolResult,
  suggestToolFix,
  validateToolSecurity,
  getRelevantToolDefinitions,
  getEnabledToolDefinitions,
  formatToolName,
  getToolIcon,
} from '../src/renderer/services/tool-registry.js';
import type { ToolResult } from '../src/renderer/types.js';

describe('validateToolArgs', () => {
  it('write_file 缺少 path 报错', () => {
    const errors = validateToolArgs('write_file', {});
    expect(errors.some((e) => e.includes('path'))).toBe(true);
  });

  it('read_file 合法参数不报错', () => {
    expect(validateToolArgs('read_file', { path: 'a.txt' })).toEqual([]);
    expect(validateToolArgs('read_file', { paths: ['a.txt', 'b.txt'] })).toEqual([]);
  });

  it('web_search 缺少 query 报错', () => {
    const errors = validateToolArgs('web_search', {});
    expect(errors.some((e) => e.includes('query'))).toBe(true);
  });

  it('枚举值校验：git action 非法', () => {
    const errors = validateToolArgs('git', { action: 'frobnicate' });
    expect(errors.some((e) => e.includes('不在允许范围'))).toBe(true);
  });

  it('类型校验：max_results 应为整数', () => {
    const errors = validateToolArgs('web_search', { query: 'x', max_results: 'not-a-number' });
    expect(errors.some((e) => e.includes('应为整数'))).toBe(true);
  });

  it('未知工具跳过校验（MCP 工具）', () => {
    expect(validateToolArgs('mcp_unknown__foo', {})).toEqual([]);
  });
});

describe('coerceToolArgs', () => {
  it('字符串数字转整数', () => {
    expect(coerceToolArgs('read_file', { start_line: '5' }).start_line).toBe(5);
  });

  it('字符串布尔转布尔', () => {
    expect(coerceToolArgs('web_fetch', { mobile_ua: 'true' }).mobile_ua).toBe(true);
    expect(coerceToolArgs('web_fetch', { mobile_ua: 'false' }).mobile_ua).toBe(false);
  });

  it('逗号分隔字符串转数组', () => {
    expect(coerceToolArgs('search_files', { file_extensions: '.ts,.js' }).file_extensions).toEqual(['.ts', '.js']);
  });

  it('JSON 字符串转数组', () => {
    expect(coerceToolArgs('search_files', { file_extensions: '[".ts"]' }).file_extensions).toEqual(['.ts']);
  });

  it('保持未知参数原样', () => {
    expect(coerceToolArgs('read_file', { weird: 'value' }).weird).toBe('value');
  });
});

describe('truncateToolResult', () => {
  it('小结果原样返回', () => {
    const r: ToolResult = { success: true, content: 'short' };
    expect(truncateToolResult(r, 'read_file')).toBe(r);
  });

  it('大字符串字段截断保留头尾', () => {
    // content 属于截断字段；需让整体 JSON 超过 100KB 才会触发截断
    const big = 'a'.repeat(120000);
    const out = truncateToolResult({ success: true, content: big }, 'read_file');
    expect((out as Record<string, unknown>).content).toContain('已截断');
  });

  it('字段截断后仍超限时暴力截断为 preview', () => {
    // 多个非截断字段的大值使总和远超 100KB，触发 preview 兜底
    const r: ToolResult = { success: true, a: 'x'.repeat(60000), b: 'y'.repeat(60000) };
    const out = truncateToolResult(r, 'read_file');
    expect(typeof (out as Record<string, unknown>).preview).toBe('string');
    expect((out as Record<string, unknown>)._omitted_chars).toBeGreaterThan(0);
  });
});

describe('suggestToolFix', () => {
  it('文件未找到建议检查路径', () => {
    const s = suggestToolFix('read_file', { path: '/nope' }, 'ENOENT: no such file');
    expect(s).toContain('路径');
  });

  it('权限拒绝建议检查权限', () => {
    const s = suggestToolFix('read_file', {}, 'EACCES: permission denied');
    expect(s).toContain('权限');
  });

  it('网络错误建议检查网络', () => {
    const s = suggestToolFix('web_fetch', { url: 'http://x' }, 'ECONNREFUSED');
    expect(s).toContain('网络');
  });

  it('通用错误返回空串', () => {
    expect(suggestToolFix('read_file', {}, 'something else')).toBe('');
  });
});

describe('validateToolSecurity', () => {
  it('本地文件工具拒绝 URL 路径', () => {
    const r = validateToolSecurity('read_file', { path: 'http://example.com/x' });
    expect(r).toBeTruthy();
    expect(r).toContain('web_fetch');
  });

  it('拒绝 file:// 协议', () => {
    const r = validateToolSecurity('web_fetch', { url: 'file:///etc/passwd' });
    expect(r).toContain('file://');
  });

  it('路径遍历检测', () => {
    const r = validateToolSecurity('read_file', { path: '../../../../etc/passwd' });
    expect(r).toContain('路径遍历');
  });

  it('命令注入检测', () => {
    const r = validateToolSecurity('run_command', { command: 'echo a; rm -rf /' });
    expect(r).toContain('注入');
  });

  it('正常参数返回 null', () => {
    expect(validateToolSecurity('read_file', { path: 'a.txt' })).toBeNull();
  });

  it('read_file paths 数组含 URL 拒绝', () => {
    const r = validateToolSecurity('read_file', { paths: ['http://x/a', '/local/b'] });
    expect(r).toContain('URL');
  });
});

describe('0.18.0 工具矩阵', () => {
  it('内置工具严格为 18 个', () => {
    expect(getEnabledToolDefinitions().filter((t) => !t.function.name.startsWith('mcp_'))).toHaveLength(18);
  });

  it('不再暴露已删除/合并的旧工具名', () => {
    const names = getEnabledToolDefinitions().map((t) => t.function.name);
    for (const legacy of [
      'read_multiple_files',
      'create_directory',
      'tree',
      'copy_file',
      'move_file',
      'browser_open',
      'browser_screenshot',
      'browser_evaluate',
      'browser_extract',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_wait',
      'browser_close',
      'session_list',
      'session_read',
      'calculator',
      'plan_track',
    ]) {
      expect(names).not.toContain(legacy);
    }
  });

  it('合并工具 schema 正确', () => {
    const byName = new Map(getEnabledToolDefinitions().map((t) => [t.function.name, t]));
    expect(byName.get('file_transfer')?.function.parameters.properties.operation.enum).toEqual(['copy', 'move']);
    expect(byName.get('list_directory')?.function.parameters.properties.format.enum).toEqual(['list', 'tree']);
    expect(byName.get('browser')?.function.parameters.properties.action.enum).toEqual([
      'open',
      'extract',
      'screenshot',
      'click',
      'type',
      'scroll',
      'wait',
      'evaluate',
      'close',
    ]);
    expect(byName.get('session')?.function.parameters.properties.action.enum).toEqual(['list', 'read']);
  });
});

describe('getRelevantToolDefinitions', () => {
  it('短查询返回全部已启用工具', () => {
    const tools = getRelevantToolDefinitions('hi');
    expect(tools).toHaveLength(getEnabledToolDefinitions().length);
  });

  it('空查询返回全部已启用工具', () => {
    expect(getRelevantToolDefinitions('')).toHaveLength(getEnabledToolDefinitions().length);
  });

  it('包含核心工具', () => {
    const names = getRelevantToolDefinitions('请读取这个文件并搜索内容').map((t) => t.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('search_files');
  });

  it('匹配到足够多时不返回全部（含 web 相关）', () => {
    const names = getRelevantToolDefinitions('帮我搜索网页并抓取内容').map((t) => t.function.name);
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
  });

  it('过滤后过少时回退到全部', () => {
    // 极小匹配场景 → 保留核心 + 至少 60% 规则，回退为全部
    const tools = getRelevantToolDefinitions('随便问点什么奇怪的内容呢');
    expect(tools.length).toBeGreaterThanOrEqual(8);
  });
});

describe('formatToolName / getToolIcon', () => {
  it('已知工具返回中文名', () => {
    expect(formatToolName('read_file')).toBe('读取文件');
    expect(formatToolName('web_search')).toBe('联网搜索');
  });

  it('未知工具返回原名字', () => {
    expect(formatToolName('mcp_unknown')).toBe('mcp_unknown');
  });

  it('已知工具返回图标', () => {
    expect(getToolIcon('read_file')).toBe('📄');
  });

  it('未知工具返回默认图标', () => {
    expect(getToolIcon('mcp_unknown')).toBe('🔧');
  });
});
