import { describe, it, expect, beforeEach } from 'vitest';
import {
  truncateToolResult,
  formatToolResult,
  getToolIcon,
  formatToolName,
} from '../src/renderer/services/tools/format.js';
import {
  recordToolAnalytics,
  getToolAnalytics,
  resetToolAnalytics,
  getToolHeatmap,
} from '../src/renderer/services/tools/analytics.js';
import {
  validateToolSecurity,
  validateToolArgs,
  coerceToolArgs,
  suggestToolFix,
} from '../src/renderer/services/tools/validate.js';
import { TOOL_DEFINITIONS, MODE_TOOLS } from '../src/renderer/services/tools/catalog.js';
import type { ToolResult } from '../src/renderer/types.js';

beforeEach(() => resetToolAnalytics());

describe('工具结果格式化', () => {
  it('小结果原样返回', () => {
    const r = { success: true, content: 'x' } as ToolResult;
    expect(truncateToolResult(r, 'read_file')).toBe(r);
  });

  it('大字符串截断保留首尾', () => {
    const r = { success: true, content: 'a'.repeat(150000) } as ToolResult;
    const out = truncateToolResult(r, 'read_file') as Record<string, unknown>;
    expect(String(out.content)).toContain('已截断');
  });

  it('大数组裁剪并截断内部字段', () => {
    const small = {
      success: true,
      results: Array.from({ length: 60 }, () => ({ content: 'b'.repeat(1800) })),
    } as unknown as ToolResult;
    const sliced = truncateToolResult(small, 'web_search') as Record<string, unknown>;
    expect((sliced.results as unknown[]).length).toBe(50);
    expect(sliced._original_results_count).toBe(60);

    const long = {
      success: true,
      results: Array.from({ length: 10 }, () => ({ content: 'b'.repeat(12000) })),
    } as unknown as ToolResult;
    const truncated = truncateToolResult(long, 'web_search') as Record<string, unknown>;
    expect(String((truncated.results as Array<{ content: string }>)[0].content)).toContain('已截断');
  });

  it('兜底预览对象', () => {
    const r = {
      success: true,
      results: Array.from({ length: 200 }, () => ({ content: 'x'.repeat(5000) })),
    } as unknown as ToolResult;
    const out = truncateToolResult(r, 'x') as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(out.preview).toBeTruthy();
  });

  it('formatToolResult 为目录/搜索/读取/搜索网页添加摘要', () => {
    expect(
      (
        formatToolResult('list_directory', {
          success: true,
          entries: [{ type: 'directory' }, { type: 'file' }],
        }) as Record<string, unknown>
      )._summary,
    ).toContain('1 个目录');
    expect(
      (formatToolResult('list_directory', { success: true, items: [{ type: 'file' }] }) as Record<string, unknown>)
        ._summary,
    ).toContain('1 项');
    expect(
      (formatToolResult('search_files', { success: true, results: [1, 2] }) as Record<string, unknown>)._summary,
    ).toContain('2 个匹配');
    expect(
      (formatToolResult('search_files', { success: true, matches: [1] }) as Record<string, unknown>)._summary,
    ).toContain('1 个匹配');
    expect(
      (formatToolResult('read_file', { success: true, content: 'a\nb' }) as Record<string, unknown>)._meta,
    ).toContain('2 行');
    expect(
      (formatToolResult('web_search', { success: true, results: [1] }) as Record<string, unknown>)._summary,
    ).toContain('1 条结果');
    expect(formatToolResult('unknown', { success: true })).toEqual({ success: true });
    expect(formatToolResult('read_file', { success: false, error: 'x' })).toEqual({ success: false, error: 'x' });
  });

  it('图标与中文名', () => {
    expect(getToolIcon('read_file')).toBe('📄');
    expect(getToolIcon('unknown')).toBe('🔧');
    expect(formatToolName('read_file')).toBe('读取文件');
    expect(formatToolName('unknown')).toBe('unknown');
  });
});

describe('工具分析', () => {
  it('记录成功/失败/平均耗时/常见错误', () => {
    recordToolAnalytics('read_file', true, 10);
    recordToolAnalytics('read_file', true, 20);
    recordToolAnalytics('read_file', false, 30, 'ENOENT');
    const analytics = getToolAnalytics();
    const read = analytics.find((a) => a.toolName === 'read_file')!;
    expect(read.totalCalls).toBe(3);
    expect(read.successRate).toBeCloseTo(2 / 3);
    expect(read.commonErrorsArray[0].error).toBe('ENOENT');
    expect(getToolHeatmap().find((h) => h.toolName === 'read_file')?.heatLevel).toBe(4);
  });

  it('热力图包含未使用工具与未知工具', () => {
    recordToolAnalytics('mcp_custom', true, 1);
    recordToolAnalytics('read_file', true, 1);
    recordToolAnalytics('read_file', true, 1);
    recordToolAnalytics('read_file', true, 1);
    recordToolAnalytics('read_file', true, 1);
    recordToolAnalytics('write_file', true, 1);
    recordToolAnalytics('write_file', true, 1);
    recordToolAnalytics('write_file', false, 1);
    recordToolAnalytics('memory', true, 1);
    recordToolAnalytics('memory', true, 1);
    const heat = getToolHeatmap();
    expect(heat.some((h) => h.toolName === 'mcp_custom')).toBe(true);
    expect(heat.some((h) => h.toolName === 'read_file' && h.heatLevel === 4)).toBe(true);
    expect(heat.some((h) => h.heatLevel === 3)).toBe(true);
    expect(heat.some((h) => h.heatLevel === 2)).toBe(true);
    expect(heat.some((h) => h.heatLevel === 1)).toBe(true);
    expect(heat.some((h) => h.heatLevel === 0)).toBe(true);
  });
});

describe('工具安全与参数校验', () => {
  it('本地文件工具拒绝 URL', () => {
    expect(validateToolSecurity('read_file', { path: 'https://x.com' })).toContain('web_fetch');
    expect(validateToolSecurity('read_file', { paths: ['https://a', 'https://b'] })).toContain('2 个 URL');
    expect(validateToolSecurity('read_file', { path: '/tmp/a' })).toBeNull();
  });

  it('路径遍历与命令注入', () => {
    expect(validateToolSecurity('read_file', { path: '../../../../etc/passwd' })).toContain('路径遍历');
    expect(validateToolSecurity('read_file', { paths: ['../../../../x'] })).toContain('路径遍历');
    expect(validateToolSecurity('run_command', { command: 'echo $(rm -rf /)' })).toContain('注入');
    expect(validateToolSecurity('run_command', { command: 'echo $(date)' })).toBeNull();
    expect(validateToolSecurity('web_fetch', { url: 'file:///etc/passwd' })).toContain('file://');
    expect(validateToolSecurity('web_fetch', { url: 'http://192.168.1.1' })).toBeNull();
  });

  it('schema 必填/类型/枚举校验', () => {
    expect(validateToolArgs('write_file', {})).toEqual(expect.arrayContaining([expect.stringContaining('path')]));
    expect(validateToolArgs('read_file', { path: 1 })).toEqual(
      expect.arrayContaining([expect.stringContaining('字符串')]),
    );
    expect(validateToolArgs('read_file', { path: '/a', start_line: 1.5 })).toEqual(
      expect.arrayContaining([expect.stringContaining('整数')]),
    );
    expect(validateToolArgs('read_file', { path: '/a', mode: 'bad' })).toEqual(
      expect.arrayContaining([expect.stringContaining('不在允许范围')]),
    );
    expect(validateToolArgs('unknown_tool', {})).toEqual([]);
  });

  it('参数类型转换', () => {
    expect(coerceToolArgs('read_file', { path: '/a', start_line: '1' })).toMatchObject({ start_line: 1 });
    expect(coerceToolArgs('read_file', { path: '/a', mode: 'text' })).toMatchObject({ mode: 'text' });
    expect(coerceToolArgs('read_file', { path: '/a', start_line: 'bad' })).toMatchObject({ start_line: 'bad' });
    expect(coerceToolArgs('read_file', { path: '/a', limit_bytes: '2.5' })).toMatchObject({ limit_bytes: 2 });
    expect(coerceToolArgs('unknown', { x: 1 })).toEqual({ x: 1 });
    expect(coerceToolArgs('read_file', { path: '/a', paths: '["x"]' })).toMatchObject({ paths: ['x'] });
    expect(coerceToolArgs('read_file', { path: '/a', paths: 'x,y' })).toMatchObject({ paths: ['x', 'y'] });
  });

  it('错误建议覆盖文件/权限/路径/网络/JSON/Git/命令', () => {
    expect(suggestToolFix('read_file', { path: '/x' }, 'ENOENT')).toContain('list_directory');
    expect(suggestToolFix('read_file', {}, 'EACCES')).toContain('权限');
    expect(suggestToolFix('read_file', {}, 'invalid path')).toContain('路径');
    expect(suggestToolFix('web_fetch', {}, 'timeout')).toContain('网络');
    expect(suggestToolFix('x', {}, 'JSON parse')).toContain('JSON');
    expect(suggestToolFix('git', {}, 'not a repository')).toContain('Git');
    expect(suggestToolFix('run_command', {}, 'exit code 1')).toContain('命令');
    expect(suggestToolFix('x', {}, 'other')).toBe('');
  });

  it('工具目录 18 个且 MODE_TOOLS 为写操作', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(18);
    expect(MODE_TOOLS).toContain('write_file');
    expect(MODE_TOOLS).not.toContain('read_file');
  });
});
