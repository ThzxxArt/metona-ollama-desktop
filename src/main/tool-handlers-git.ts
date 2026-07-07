/**
 * Tool Handlers - Git 操作
 */

import * as path from 'path';
import { spawn } from 'child_process';
import { checkPathAllowed } from './tool-security.js';
import { sendLog, resolvePath, type ToolResult } from './tool-handlers-shared.js';
import { getWorkspaceDir } from './workspace.js';

export async function handleGit(params: { action: string; path?: string; files?: string[]; message?: string; branch?: string; remote?: string; remote_url?: string; count?: number; all?: boolean; staged?: boolean; new_branch?: boolean; delete_branch?: boolean; force?: boolean; url?: string }): Promise<ToolResult> {
  try {
    const cwd = params.path ? path.resolve(params.path) : getWorkspaceDir();

    // 安全检查：验证工作目录路径
    const dirCheck = checkPathAllowed(cwd, 'read');
    if (!dirCheck.ok) return { success: false, error: dirCheck.reason };

    async function runGit(args: string[], timeoutMs = 0): Promise<{ stdout: string; stderr: string; code: number }> {
      return new Promise((resolve) => {
        const git = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LANG: 'en_US.UTF-8' } });
        let stdout = '';
        let stderr = '';
        let timer: ReturnType<typeof setTimeout> | null = null;

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            git.kill('SIGTERM');
            resolve({ stdout, stderr: `操作超时 (${timeoutMs / 1000}s)`, code: 1 });
          }, timeoutMs);
        }

        git.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        git.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        git.on('close', (code) => {
          if (timer) clearTimeout(timer);
          resolve({ stdout, stderr, code: code ?? 1 });
        });
        git.on('error', (err) => {
          if (timer) clearTimeout(timer);
          resolve({ stdout, stderr: err.message, code: 1 });
        });
      });
    }

    switch (params.action) {
      case 'status': {
        const r = await runGit(['status', '--porcelain=v1', '-b']);
        if (r.code !== 0) return { success: false, error: r.stderr || '不是 git 仓库' };

        const lines = r.stdout.split('\n').filter(l => l.trim());
        const branchLine = lines.find(l => l.startsWith('##')) || '';
        const branch = branchLine.replace('## ', '').split('...')[0] || 'unknown';
        const tracking = branchLine.includes('...') ? branchLine.split('...')[1] : '';

        const modified: string[] = [];
        const staged: string[] = [];
        const untracked: string[] = [];
        const deleted: string[] = [];
        const renamed: string[] = [];

        for (const line of lines) {
          if (line.startsWith('##')) continue;
          const status = line.slice(0, 2);
          const file = line.slice(3);
          if (status === '??') untracked.push(file);
          else {
            if (status[0] === 'D') deleted.push(file);
            else if (status[0] === 'R') renamed.push(file);
            else if (status[0] !== ' ' && status[0] !== '?') staged.push(file);
            if (status[1] === 'M') modified.push(file);
            else if (status[1] === 'D') deleted.push(file);
          }
        }

        return {
          success: true, branch, tracking, modified, staged, untracked, deleted, renamed,
          isClean: modified.length === 0 && staged.length === 0 && untracked.length === 0 && deleted.length === 0
        };
      }

      case 'log': {
        const count = params.count || 20;
        const format = '--oneline';
        const r = await runGit(['log', format, `--max-count=${count}`, ...(params.all ? ['--all'] : [])]);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const commits = r.stdout.split('\n').filter(l => l.trim()).map(l => {
          const spaceIdx = l.indexOf(' ');
          return { hash: l.slice(0, spaceIdx), message: l.slice(spaceIdx + 1) };
        });
        return { success: true, commits, total: commits.length };
      }

      case 'diff': {
        const args = ['diff'];
        if (params.staged) args.push('--cached');
        if (params.files?.length) args.push('--', ...params.files);
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const hasChanges = r.stdout.trim().length > 0;
        return { success: true, diff: r.stdout, hasChanges, staged: !!params.staged };
      }

      case 'add': {
        if (!params.files?.length) return { success: false, error: '请指定要暂存的文件' };
        const r = await runGit(['add', ...params.files]);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'add', files: params.files };
      }

      case 'commit': {
        if (!params.message) return { success: false, error: '请提供提交信息' };
        const r = await runGit(['commit', '-m', params.message]);
        if (r.code !== 0) return { success: false, error: r.stderr || '提交失败（可能没有暂存的更改）' };
        return { success: true, action: 'commit', message: params.message, output: r.stdout.trim() };
      }

      case 'push': {
        const args = ['push'];
        if (params.remote) args.push(params.remote);
        if (params.branch) args.push(params.branch);
        if (params.force) args.push('--force');
        const r = await runGit(args, 60_000); // 60s 超时
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'push', output: r.stderr.trim() || r.stdout.trim() };
      }

      case 'pull': {
        const args = ['pull'];
        if (params.remote) args.push(params.remote);
        if (params.branch) args.push(params.branch);
        const r = await runGit(args, 60_000); // 60s 超时
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'pull', output: r.stdout.trim() };
      }

      case 'branch': {
        if (params.new_branch && params.branch) {
          const r = await runGit(['checkout', '-b', params.branch]);
          if (r.code !== 0) return { success: false, error: r.stderr };
          return { success: true, action: 'branch', created: params.branch };
        }
        if (params.delete_branch && params.branch) {
          const r = await runGit(['branch', '-d', params.branch]);
          if (r.code !== 0) return { success: false, error: r.stderr };
          return { success: true, action: 'branch', deleted: params.branch };
        }
        const r = await runGit(['branch', ...(params.all ? ['-a'] : [])]);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const branches = r.stdout.split('\n').filter(l => l.trim()).map(l => ({
          name: l.replace(/^\*?\s*/, '').trim(),
          current: l.startsWith('*')
        }));
        return { success: true, action: 'branch', branches };
      }

      case 'checkout': {
        if (!params.branch) return { success: false, error: '请指定分支名' };
        const args = ['checkout'];
        if (params.force) args.push('-f');
        args.push(params.branch);
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'checkout', branch: params.branch };
      }

      case 'merge': {
        if (!params.branch) return { success: false, error: '请指定要合并的分支' };
        const r = await runGit(['merge', params.branch]);
        if (r.code !== 0) return { success: false, error: r.stderr || '合并冲突' };
        return { success: true, action: 'merge', branch: params.branch, output: r.stdout.trim() };
      }

      case 'stash': {
        // stash 子命令（push/pop/apply/list/drop）
        // 支持 message 中的 stash 子命令或默认 push
        const stashSub = (params as any).stash_sub || 'push';
        const stashArgs = ['stash', stashSub];
        if ((stashSub === 'push') && params.message) {
          stashArgs.push('-m', params.message);
        }
        const r = await runGit(stashArgs);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'stash', subAction: stashSub, output: r.stdout.trim() };
      }

      case 'remote': {
        if (params.remote_url && params.remote) {
          const r = await runGit(['remote', 'add', params.remote, params.remote_url]);
          if (r.code !== 0) return { success: false, error: r.stderr };
          return { success: true, action: 'remote', added: params.remote, url: params.remote_url };
        }
        const args = ['remote', '-v'];
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const remotes = r.stdout.split('\n').filter(l => l.trim()).map(l => {
          const [name, url] = l.split(/\s+/);
          return { name, url };
        });
        return { success: true, action: 'remote', remotes };
      }

      case 'clone': {
        if (!params.url) return { success: false, error: '请提供仓库 URL' };
        const destDir = params.path ? path.resolve(params.path) : getWorkspaceDir();
        const cloneDirCheck = checkPathAllowed(destDir, 'write');
        if (!cloneDirCheck.ok) return { success: false, error: cloneDirCheck.reason };
        const r = await runGit(['clone', params.url, destDir], 120_000); // 120s 超时（clone 可能较大）
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'clone', url: params.url, destination: destDir };
      }

      case 'init': {
        const r = await runGit(['init']);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'init', output: r.stdout.trim() };
      }

      case 'reset': {
        const args = ['reset'];
        if (params.staged) args.push('--cached');
        if (params.force) args.push('--hard');
        if (params.files?.length) args.push('--', ...params.files);
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'reset', output: r.stdout.trim() };
      }

      case 'tag': {
        // 支持显式 tag_name 参数，回退兼容旧的 branch 参数
        const tagName = (params as any).tag_name || params.branch;
        if (tagName) {
          const tagArgs = ['tag'];
          if (params.message) tagArgs.push('-a', tagName, '-m', params.message);
          else tagArgs.push(tagName);
          const r = await runGit(tagArgs);
          if (r.code !== 0) return { success: false, error: r.stderr };
          return { success: true, action: 'tag', created: tagName };
        }
        const r = await runGit(['tag', '-l']);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const tags = r.stdout.split('\n').filter(l => l.trim());
        return { success: true, action: 'tag', tags };
      }

      default:
        return { success: false, error: `未知 git 操作: ${params.action}` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

