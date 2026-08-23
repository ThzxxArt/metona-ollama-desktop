/**
 * Result Formatter — 工具结果 → 模型友好格式
 * 从 agent-engine.ts 拆分的纯格式化模块（无状态，便于测试与复用）。
 */

import type { ToolResult } from '../types.js';

/** 生成工具审计摘要 — 用于审计日志记录 */
function summarizeAuditResult(toolName: string, result: ToolResult): string {
  try {
    switch (toolName) {
      case 'write_file':
        return `写入 ${result.path || ''} (${result.bytesWritten || 0}B${result.created ? ', 新建' : ''})`;
      case 'edit_file':
        return `编辑 ${result.path || ''} (${result.replaceCount || 0} 处替换)`;
      case 'delete_file':
        return result.batch ? `批量删除 ${result.successCount}/${result.totalPaths}` : `删除 ${result.path || ''}`;
      case 'create_directory':
        return `创建目录 ${result.path || ''}`;
      case 'move_file':
        return `移动 ${(result as Record<string, unknown>).source} → ${(result as Record<string, unknown>).destination}`;
      case 'copy_file':
        return `复制 ${(result as Record<string, unknown>).source} → ${(result as Record<string, unknown>).destination}`;
      case 'run_command':
        return `命令执行 ${result.exitCode === 0 ? '成功' : '失败'} (exit ${result.exitCode})`;
      case 'git':
        return `git ${result.action}`;
      case 'download_file':
        return `下载 ${(result as Record<string, unknown>).url} → ${(result as Record<string, unknown>).destination}`;
      case 'compress':
        return `${result.action} → ${(result as Record<string, unknown>).outputPath || (result as Record<string, unknown>).destination}`;
      default:
        return `${toolName} 完成`;
    }
  } catch {
    return `${toolName} 完成`;
  }
}

export { summarizeAuditResult };

/** 格式化工具结果的通用默认路径 */
function formatDefaultToolResult(toolName: string, result: ToolResult): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'success' || k === 'formatted' || k === 'content_type' ||
        k === 'status' || k === 'length' || k === 'isDirectory') continue;
    clean[k] = v;
  }
  return JSON.stringify(clean);
}

/**
 * 格式化工具结果，生成模型友好的简洁表示
 */
export function formatToolResultForModel(toolName: string, result: ToolResult): string {
  if (!result.success) {
    return JSON.stringify({ success: false, error: result.error || '工具执行失败' });
  }

  switch (toolName) {
    case 'web_search': {
      const raw = result.results as Array<{ title: string; url: string; snippet: string }> | undefined;
      if (!raw?.length) return JSON.stringify({ success: true, message: '未找到结果' });
      const top = raw.map((r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`
      ).join('\n\n');
      const fetched = (result as Record<string, unknown>)._fetched as Array<{ url: string; title: string; content: string }> | undefined;
      const body = JSON.stringify({
        success: true, query: result.query, total: result.total, shown: raw.length, results: top,
      });
      if (fetched && fetched.length > 0) {
        return body + '\n\n' + fetched.map((f, i) =>
          `\n=== 📄 已抓取 ${i + 1}/${fetched.length}: ${f.title} ===\n${f.content}\n`
        ).join('\n---\n');
      }
      return body;
    }

    case 'web_fetch': {
      const content = (result.content as string) || '';
      return JSON.stringify({ success: true, url: result.url, content });
    }

    case 'read_file': {
      return JSON.stringify({
        success: true,
        path: result.path,
        content: result.content,
        lines: result.lines,
        truncated: result.truncated,
        line_range: result.line_range
      });
    }

    case 'read_multiple_files': {
      return JSON.stringify({
        success: true,
        files: result.files,
        total: result.total
      });
    }

    case 'list_directory': {
      return JSON.stringify({
        success: true,
        path: result.path,
        entries: result.entries,
        total: result.total,
        truncated: result.truncated
      });
    }

    case 'write_file': {
      return JSON.stringify({
        success: true,
        path: result.path,
        bytesWritten: result.bytesWritten,
        created: result.created
      });
    }

    case 'run_command': {
      return JSON.stringify({
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: result.duration
      });
    }

    case 'git': {
      return JSON.stringify({
        success: true,
        action: result.action,
        output: result.output,
        branch: result.branch,
        files: result.files,
        commits: result.commits
      });
    }

    case 'search_files': {
      return JSON.stringify({
        success: true,
        query: result.query,
        total_matches: result.total_matches,
        total_files: result.total_files,
        results: result.results
      });
    }

    case 'memory': {
      // 去重信号改为软提醒，不触发强制终止
      if ((result as Record<string, unknown>).duplicate) {
        return JSON.stringify({ success: true, action: 'add', duplicate: true, message: `${(result as Record<string, unknown>).message || '相同内容已存在'}` });
      }
      // read_all / search 结果：包裹在 JSON 中以保持与其他工具一致的格式
      if ((result as Record<string, unknown>).action === 'read_all') {
        const entries = ((result as Record<string, unknown>).entries || []) as Array<{ id: string; type: string; content: string; importance: number; tags: string[] }>;
        if (entries.length === 0) return JSON.stringify({ success: true, action: 'read_all', message: '记忆为空，没有任何已保存的记忆条目。', total: 0 });
        const grouped: Record<string, typeof entries> = {};
        for (const e of entries) {
          const t = e.type || 'fact';
          (grouped[t] ||= []).push(e);
        }
        const lines: string[] = [`[记忆读取结果] 共 ${entries.length} 条记忆，按类型分组：`];
        const typeLabels: Record<string, string> = { rule: '规则（必须遵守）', preference: '偏好', fact: '事实' };
        for (const [t, items] of Object.entries(grouped)) {
          lines.push(`\n--- ${typeLabels[t] || t} ---`);
          for (const e of items) {
            lines.push(`  • [${e.type}] ${e.content}（重要性:${e.importance}, 标签: ${(e.tags || []).join(', ') || '无'}）`);
          }
        }
        return JSON.stringify({ success: true, action: 'read_all', formatted: lines.join('\n'), total: entries.length });
      }
      if ((result as Record<string, unknown>).action === 'search') {
        const results = ((result as Record<string, unknown>).results || []) as Array<{ id: string; type: string; content: string; importance: number; score: number }>;
        if (results.length === 0) return JSON.stringify({ success: true, action: 'search', message: '未找到匹配的记忆。', total: 0 });
        const lines = [`[记忆搜索结果] 共 ${results.length} 条：`];
        for (const r of results) {
          lines.push(`  • [${r.type || 'fact'}] ${r.content}（重要性:${r.importance}, 匹配度:${(r.score || 0).toFixed(0)}）`);
        }
        return JSON.stringify({ success: true, action: 'search', formatted: lines.join('\n'), total: results.length });
      }
      // remove_batch 结果：格式化每条匹配情况
      if ((result as Record<string, unknown>).action === 'remove_batch') {
        const items = ((result as Record<string, unknown>).results || []) as Array<{ old_text: string; matched: boolean; entry_id?: string; error?: string }>;
        const deleted = (result as Record<string, unknown>).deleted as number || 0;
        const failed = (result as Record<string, unknown>).failed as number || 0;
        const lines = [`[批量删除结果] 成功 ${deleted} 条${failed > 0 ? `, 失败 ${failed} 条` : ''}:`];
        for (const item of items) {
          if (item.matched) {
            lines.push(`  ✅ "${item.old_text}" → 已删除 (${item.entry_id})`);
          } else {
            lines.push(`  ❌ "${item.old_text}" → ${item.error || '失败'}`);
          }
        }
        return JSON.stringify({ success: (result as Record<string, unknown>).success, action: 'remove_batch', formatted: lines.join('\n'), deleted, failed });
      }
      // 其他 action（add/replace/remove）→ 保留完整 JSON，走 default 逻辑
      return formatDefaultToolResult(toolName, result);
    }

    case 'delete_file': {
      // 批量删除
      if ((result as Record<string, unknown>).batch) {
        return JSON.stringify({
          success: true,
          message: `批量删除完成：成功 ${result.successCount}/${result.totalPaths} 个路径`,
          batch: true,
          totalPaths: result.totalPaths,
          successCount: result.successCount,
          failCount: result.failCount,
          results: result.results,
        });
      }
      return JSON.stringify({
        success: true,
        message: `已删除${(result as Record<string, unknown>).type === 'directory' ? '目录' : '文件'}：${result.path}`,
        path: result.path,
        deleted: true,
        type: (result as Record<string, unknown>).type,
        deletedSize: result.deletedSize,
        ...((result as Record<string, unknown>).filesDeleted !== undefined && { filesDeleted: (result as Record<string, unknown>).filesDeleted }),
      });
    }

    case 'create_directory': {
      return JSON.stringify({
        success: true,
        message: `目录已创建：${result.path}`,
        path: result.path,
        created: (result as Record<string, unknown>).created,
      });
    }

    case 'move_file': {
      return JSON.stringify({
        success: true,
        message: `已移动：${(result as Record<string, unknown>).source} → ${(result as Record<string, unknown>).destination}`,
        source: (result as Record<string, unknown>).source,
        destination: (result as Record<string, unknown>).destination,
      });
    }

    case 'copy_file': {
      return JSON.stringify({
        success: true,
        message: `已复制：${(result as Record<string, unknown>).source} → ${(result as Record<string, unknown>).destination}`,
        source: (result as Record<string, unknown>).source,
        destination: (result as Record<string, unknown>).destination,
        bytesCopied: (result as Record<string, unknown>).bytesCopied,
      });
    }

    case 'download_file': {
      return JSON.stringify({
        success: true,
        message: `已下载：${(result as Record<string, unknown>).url} → ${(result as Record<string, unknown>).destination}`,
        url: (result as Record<string, unknown>).url,
        destination: (result as Record<string, unknown>).destination,
        bytesDownloaded: (result as Record<string, unknown>).bytesDownloaded,
      });
    }

    case 'compress': {
      return JSON.stringify({
        success: true,
        message: `已压缩：${(result as Record<string, unknown>).outputPath}`,
        outputPath: (result as Record<string, unknown>).outputPath,
        originalSize: (result as Record<string, unknown>).originalSize,
        compressedSize: (result as Record<string, unknown>).compressedSize,
        filesProcessed: (result as Record<string, unknown>).filesProcessed,
      });
    }

    case 'diff': {
      if ((result as Record<string, unknown>).identical) {
        return JSON.stringify({ success: true, identical: true, message: '文件内容完全相同，无差异' });
      }
      return JSON.stringify({
        success: true,
        mode: (result as Record<string, unknown>).mode,
        path1: (result as Record<string, unknown>).path1,
        path2: (result as Record<string, unknown>).path2,
        diff: (result as Record<string, unknown>).diff,
        additions: (result as Record<string, unknown>).additions,
        deletions: (result as Record<string, unknown>).deletions,
        hunk_count: (result as Record<string, unknown>).hunk_count,
        identical: false,
      });
    }

    case 'tree': {
      return JSON.stringify({
        success: true,
        message: `目录树：${result.path}（${(result as Record<string, unknown>).totalEntries} 项）`,
        path: result.path,
        entries: result.entries,
        totalEntries: (result as Record<string, unknown>).totalEntries,
        truncated: result.truncated,
      });
    }

    default: {
      return formatDefaultToolResult(toolName, result);
    }
  }
}
