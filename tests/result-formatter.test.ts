import { describe, it, expect } from 'vitest';
import {
  formatToolResultForModel,
  summarizeAuditResult,
} from '../src/renderer/services/result-formatter.js';
import type { ToolResult } from '../src/renderer/types.js';

describe('formatToolResultForModel', () => {
  it('失败结果返回统一错误 JSON', () => {
    const out = formatToolResultForModel('read_file', { success: false, error: 'boom' });
    expect(out).toContain('"success":false');
    expect(out).toContain('boom');
  });

  it('web_search 格式化结果列表与抓取内容', () => {
    const r: ToolResult = {
      success: true,
      query: 'rust',
      total: 1,
      results: [{ title: 'T', url: 'http://x', snippet: 'snippet' }],
      _fetched: [{ url: 'http://x', title: 'T', content: 'full content here' }],
    };
    const out = formatToolResultForModel('web_search', r);
    expect(out).toContain('T');
    expect(out).toContain('http://x');
    expect(out).toContain('已抓取');
  });

  it('web_fetch 返回内容', () => {
    const out = formatToolResultForModel('web_fetch', { success: true, url: 'http://x', content: 'body' });
    expect(out).toContain('body');
  });

  it('read_file 返回路径与内容', () => {
    const out = formatToolResultForModel('read_file', { success: true, path: '/a.txt', content: 'abc', lines: 1, truncated: false });
    expect(out).toContain('/a.txt');
    expect(out).toContain('abc');
  });

  it('run_command 返回 stdout/stderr', () => {
    const out = formatToolResultForModel('run_command', { success: true, stdout: 'out', stderr: '', exitCode: 0, duration: 10 });
    expect(out).toContain('out');
    expect(out).toContain('exitCode');
  });

  it('memory add 去重信号转为软提醒', () => {
    const out = formatToolResultForModel('memory', { success: true, action: 'add', duplicate: true, message: '相同内容已存在' });
    expect(out).toContain('相同内容已存在');
  });

  it('memory read_all 格式化分组', () => {
    const r: ToolResult = {
      success: true,
      action: 'read_all',
      entries: [
        { id: 'mem_1', type: 'rule', content: '规则一', importance: 9, tags: ['r1'] },
        { id: 'mem_2', type: 'fact', content: '事实一', importance: 5, tags: ['f1'] },
      ],
      total: 2,
    };
    const out = formatToolResultForModel('memory', r);
    expect(out).toContain('规则（必须遵守）');
    expect(out).toContain('事实一');
  });

  it('delete_file 单个返回删除信息', () => {
    const out = formatToolResultForModel('delete_file', { success: true, path: '/x', deleted: true, type: 'file', deletedSize: 100 });
    expect(out).toContain('已删除');
  });

  it('diff 相同返回 no-position', () => {
    const out = formatToolResultForModel('diff', { success: true, identical: true, message: '文件内容完全相同，无差异' });
    expect(out).toContain('完全相同');
  });

  it('未知工具走默认 JSON 序列化', () => {
    const out = formatToolResultForModel('unknown_tool', { success: true, someField: 'val' });
    expect(out).toContain('someField');
  });
});

describe('summarizeAuditResult', () => {
  it('write_file 摘要含路径与字节数', () => {
    const s = summarizeAuditResult('write_file', { success: true, path: '/a.txt', bytesWritten: 100, created: true });
    expect(s).toContain('/a.txt');
  });

  it('run_command 摘要在失败时含 exit code', () => {
    const s = summarizeAuditResult('run_command', { success: false, exitCode: 1 });
    expect(s).toContain('失败');
  });

  it('默认工具名返回完成', () => {
    expect(summarizeAuditResult('calculator', { success: true })).toContain('完成');
  });
});
