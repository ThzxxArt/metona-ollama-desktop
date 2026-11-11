import { describe, it, expect } from 'vitest';
import { formatToolResultForModel, summarizeAuditResult } from '../src/renderer/services/result-formatter.js';
import { parseToolCallsFromText } from '../src/renderer/services/tool-parsing.js';
import type { ToolResult } from '../src/renderer/types.js';

// ═══════════════════════════════════════════════════════════════
// result-formatter 分支
// ═══════════════════════════════════════════════════════════════

describe('formatToolResultForModel 分支', () => {
  it('失败且无 error 时使用默认错误文案', () => {
    const out = formatToolResultForModel('read_file', { success: false });
    expect(out).toContain('工具执行失败');
  });

  it('web_search 无结果', () => {
    expect(formatToolResultForModel('web_search', { success: true, results: [] })).toContain('未找到结果');
  });

  it('web_search 附带抓取内容', () => {
    const out = formatToolResultForModel('web_search', {
      success: true,
      query: 'q',
      total: 1,
      results: [{ title: 'T', url: 'u', snippet: 's' }],
      _fetched: [{ url: 'u', title: 'T', content: 'full body' }],
    });
    expect(out).toContain('已抓取 1/1');
    expect(out).toContain('full body');
  });

  it('run_command 成功格式', () => {
    const out = formatToolResultForModel('run_command', {
      success: true,
      stdout: 'o',
      stderr: 'e',
      exitCode: 1,
      duration: 2,
    });
    expect(JSON.parse(out)).toMatchObject({ stdout: 'o', stderr: 'e', exitCode: 1 });
  });

  it('web_search 无抓取内容时只返回结果列表', () => {
    const out = formatToolResultForModel('web_search', {
      success: true,
      query: 'q',
      total: 1,
      results: [{ title: 'T', url: 'u', snippet: 's' }],
    });
    expect(out).toContain('"shown":1');
    expect(out).not.toContain('已抓取');
  });

  it('web_fetch 缺 content 时返回空字符串', () => {
    const out = formatToolResultForModel('web_fetch', { success: true, url: 'u' });
    expect(JSON.parse(out)).toEqual({ success: true, url: 'u', content: '' });
  });

  it('read_file 批量文件格式', () => {
    const out = formatToolResultForModel('read_file', { success: true, files: [{ path: 'a' }], total: 1 });
    expect(JSON.parse(out)).toEqual({ success: true, files: [{ path: 'a' }], total: 1 });
  });

  it('list_directory 格式', () => {
    const out = formatToolResultForModel('list_directory', {
      success: true,
      path: '.',
      entries: [],
      total: 0,
      truncated: false,
    });
    expect(JSON.parse(out)).toMatchObject({ path: '.', total: 0 });
  });

  it('write_file 格式', () => {
    const out = formatToolResultForModel('write_file', { success: true, path: 'a', bytesWritten: 3, created: true });
    expect(JSON.parse(out)).toEqual({ success: true, path: 'a', bytesWritten: 3, created: true });
  });

  it('git 格式', () => {
    const out = formatToolResultForModel('git', {
      success: true,
      action: 'status',
      output: 'clean',
      branch: 'main',
      files: [],
      commits: [],
    });
    expect(JSON.parse(out)).toMatchObject({ action: 'status', branch: 'main' });
  });

  it('search_files 格式', () => {
    const out = formatToolResultForModel('search_files', {
      success: true,
      query: 'q',
      total_matches: 1,
      total_files: 1,
      results: [],
    });
    expect(JSON.parse(out)).toMatchObject({ query: 'q', total_matches: 1 });
  });

  it('memory duplicate 无 message 使用默认提示', () => {
    const out = formatToolResultForModel('memory', { success: true, duplicate: true });
    expect(out).toContain('相同内容已存在');
  });

  it('memory read_all 空结果', () => {
    const out = formatToolResultForModel('memory', { success: true, action: 'read_all', entries: [] });
    expect(out).toContain('记忆为空');
  });

  it('memory read_all 未知类型分组', () => {
    const out = formatToolResultForModel('memory', {
      success: true,
      action: 'read_all',
      entries: [{ id: 'm', type: 'custom', content: 'c', importance: 1, tags: [] }],
    });
    expect(out).toContain('--- custom ---');
    expect(out).toContain('标签: 无');
  });

  it('memory search 空结果与有结果', () => {
    expect(formatToolResultForModel('memory', { success: true, action: 'search', results: [] })).toContain(
      '未找到匹配',
    );
    const out = formatToolResultForModel('memory', {
      success: true,
      action: 'search',
      results: [{ id: 'm', type: 'fact', content: 'hello', importance: 5, score: 0.8 }],
    });
    expect(out).toContain('匹配度:1');
  });

  it('memory remove_batch 成功与失败条目', () => {
    const out = formatToolResultForModel('memory', {
      success: true,
      action: 'remove_batch',
      deleted: 1,
      failed: 1,
      results: [
        { old_text: 'a', matched: true, entry_id: 'm1' },
        { old_text: 'b', matched: false, error: 'not found' },
      ],
    });
    expect(out).toContain('成功 1 条, 失败 1 条');
    expect(out).toContain('✅');
    expect(out).toContain('❌');
  });

  it('memory 其他 action 走默认 JSON', () => {
    const out = formatToolResultForModel('memory', {
      success: true,
      action: 'add',
      id: 'm1',
      type: 'fact',
      content: 'x',
    });
    expect(JSON.parse(out)).toMatchObject({ action: 'add', id: 'm1' });
  });

  it('delete_file 批量与目录格式', () => {
    const batch = formatToolResultForModel('delete_file', {
      success: true,
      batch: true,
      totalPaths: 2,
      successCount: 1,
      failCount: 1,
      results: [],
    });
    expect(batch).toContain('批量删除完成');
    const dir = formatToolResultForModel('delete_file', {
      success: true,
      path: '/d',
      type: 'directory',
      deletedSize: 10,
      filesDeleted: 3,
    });
    expect(dir).toContain('已删除目录');
    expect(dir).toContain('filesDeleted');
  });

  it('file_transfer / download_file / compress 格式', () => {
    expect(
      formatToolResultForModel('file_transfer', {
        success: true,
        operation: 'move',
        source: 'a',
        destination: 'b',
        bytesCopied: 1,
      }),
    ).toContain('已处理');
    expect(
      formatToolResultForModel('download_file', { success: true, url: 'u', destination: 'd', bytesDownloaded: 2 }),
    ).toContain('已下载');
    expect(
      formatToolResultForModel('compress', {
        success: true,
        outputPath: 'o.zip',
        originalSize: 10,
        compressedSize: 5,
        filesProcessed: 2,
      }),
    ).toContain('已压缩');
  });

  it('diff 相同格式', () => {
    const out = formatToolResultForModel('diff', { success: true, identical: true });
    expect(JSON.parse(out)).toEqual({ success: true, identical: true, message: '文件内容完全相同，无差异' });
  });

  it('diff 非相同格式', () => {
    const out = formatToolResultForModel('diff', {
      success: true,
      mode: 'files',
      path1: 'a',
      path2: 'b',
      diff: '+x',
      additions: 1,
      deletions: 0,
      hunk_count: 1,
    });
    expect(JSON.parse(out)).toMatchObject({ identical: false, additions: 1 });
  });

  it('tree 格式', () => {
    const out = formatToolResultForModel('tree', {
      success: true,
      path: '.',
      entries: [],
      totalEntries: 0,
      truncated: false,
    });
    expect(JSON.parse(out)).toMatchObject({ path: '.', totalEntries: 0 });
  });

  it('默认格式剔除展示辅助字段', () => {
    const out = formatToolResultForModel('unknown', {
      success: true,
      formatted: 'f',
      content_type: 'text',
      status: 'ok',
      length: 1,
      isDirectory: false,
      value: 42,
    });
    expect(JSON.parse(out)).toEqual({ value: 42 });
  });
});

describe('summarizeAuditResult 分支', () => {
  it('edit_file 摘要', () => {
    expect(summarizeAuditResult('edit_file', { success: true, path: '/a', replaceCount: 3 })).toContain('3 处替换');
  });

  it('delete_file 批量与单个摘要', () => {
    expect(
      summarizeAuditResult('delete_file', { success: true, batch: true, successCount: 1, totalPaths: 2 }),
    ).toContain('1/2');
    expect(summarizeAuditResult('delete_file', { success: true, path: '/a' })).toContain('删除 /a');
  });

  it('file_transfer 移动/复制摘要', () => {
    expect(
      summarizeAuditResult('file_transfer', { success: true, operation: 'move', source: 'a', destination: 'b' }),
    ).toContain('移动');
    expect(summarizeAuditResult('file_transfer', { success: true, source: 'a', destination: 'b' })).toContain('复制');
  });

  it('run_command / git / download / compress 摘要', () => {
    expect(summarizeAuditResult('run_command', { success: true, exitCode: 0 })).toContain('成功');
    expect(summarizeAuditResult('git', { success: true, action: 'commit' })).toContain('git commit');
    expect(summarizeAuditResult('download_file', { success: true, url: 'u', destination: 'd' })).toContain('u → d');
    expect(summarizeAuditResult('compress', { success: true, action: 'zip', outputPath: 'o.zip' })).toContain('o.zip');
    expect(summarizeAuditResult('compress', { success: true, action: 'unzip', destination: 'd' })).toContain('d');
  });

  it('未知工具与异常结果回退为完成', () => {
    expect(summarizeAuditResult('mystery', { success: true })).toBe('mystery 完成');
    const bad = new Proxy(
      { success: true },
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    expect(summarizeAuditResult('write_file', bad as ToolResult)).toBe('write_file 完成');
  });
});

// ═══════════════════════════════════════════════════════════════
// tool-parsing 分支
// ═══════════════════════════════════════════════════════════════

describe('parseToolCallsFromText 分支', () => {
  it('空内容返回空数组', () => {
    expect(parseToolCallsFromText('')).toEqual([]);
  });

  it('解析加粗 Action 与多行 Action Input', () => {
    const calls = parseToolCallsFromText('**Action:** read_file\n**Action Input:** {"path": "a"}');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('read_file');
  });

  it('Action Input 非法 JSON 时忽略', () => {
    expect(parseToolCallsFromText('Action: read_file\nAction Input: {bad}')).toEqual([]);
  });

  it('XML 支持 function.name / function.arguments 与代码围栏', () => {
    const content = `<tool_call>
\`\`\`json
{"function": {"name": "read_file", "arguments": {"path": "a"}}}
\`\`\`
</tool_call>`;
    const calls = parseToolCallsFromText(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('read_file');
  });

  it('XML 解析失败时回退提取 name/arguments', () => {
    const content = `<tool_call>
{ "name": "read_file", "arguments": {"path": "a"}
</tool_call>`;
    const calls = parseToolCallsFromText(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.arguments.path).toBe('a');
  });

  it('XML 无参数时默认空对象', () => {
    const content = '<tool_call>{ "name": "read_file" }</tool_call>';
    const calls = parseToolCallsFromText(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.arguments).toEqual({});
  });

  it('代码块中未知工具名忽略', () => {
    expect(parseToolCallsFromText('```json\n{"name": "not_real", "arguments": {}}\n```')).toEqual([]);
  });

  it('代码块 JSON 非法时忽略', () => {
    expect(parseToolCallsFromText('```json\n{"name": "read_file", "arguments": }\n```')).toEqual([]);
  });

  it('函数调用语法缺少闭合括号时忽略', () => {
    expect(parseToolCallsFromText('read_file({"path": "a"}')).toEqual([]);
  });

  it('函数调用参数非法 JSON 时忽略', () => {
    expect(parseToolCallsFromText('read_file({bad})')).toEqual([]);
  });

  it('函数调用支持字符串中的大括号', () => {
    const calls = parseToolCallsFromText('write_file({"path": "a", "content": "text { not json } end"})');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.arguments.content).toBe('text { not json } end');
  });

  it('接受 MCP 工具名前缀', () => {
    const calls = parseToolCallsFromText('mcp_srv__echo({"text": "hi"})');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('mcp_srv__echo');
  });

  it('同一文本中的多种格式都会解析', () => {
    const content = [
      'Action: read_file\nAction Input: {"path": "a"}',
      '```json\n{"name": "list_directory", "arguments": {"path": "."}}\n```',
      'web_search({"query": "x"})',
    ].join('\n');
    const names = parseToolCallsFromText(content).map((c) => c.function.name);
    expect(names).toEqual(['read_file', 'list_directory', 'web_search']);
  });
});
