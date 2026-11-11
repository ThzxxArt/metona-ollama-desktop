/** 文件下载与压缩/解压。 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { checkPathAllowed } from '../tool-security.js';
import { sendLog, resolvePath, type ToolResult } from '../tool-handlers-shared.js';
import { checkPublicHttpUrl } from '../net-guard.js';
import { getHTTPTimeout } from './web.js';

export async function handleDownloadFile(params: { url: string; destination: string }): Promise<ToolResult> {
  const timeoutMs = getHTTPTimeout() > 0 ? getHTTPTimeout() : 60_000;
  try {
    const destPath = resolvePath(params.destination);
    const allowed = checkPathAllowed(destPath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    if (!params.url.startsWith('http://') && !params.url.startsWith('https://')) {
      return { success: false, error: '仅支持 http/https 协议' };
    }

    const netCheck = await checkPublicHttpUrl(params.url);
    if (!netCheck.ok) {
      sendLog('warn', `⬇️ download_file 安全拦截`, netCheck.reason || '');
      return { success: false, error: `安全拦截: ${netCheck.reason}` };
    }

    sendLog('info', `⬇️ download_file`, `${params.url} → ${destPath}`);

    const MAX_RETRIES = 3;
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    let resp: Response | null = null;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        resp = await fetch(params.url, {
          signal: controller.signal,
          headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br' },
          redirect: 'follow',
        });
        clearTimeout(timeoutId);
        if (resp.ok) break;
        lastError = `HTTP ${resp.status}: ${resp.statusText}`;
        if (resp.status >= 400 && resp.status < 500) break;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = (err as Error).message;
        if (lastError.includes('abort')) lastError = `下载超时 (${Math.round(timeoutMs / 1000)}s)`;
      }
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        sendLog('warn', `⬇️ download_file 重试`, `第 ${attempt + 1} 次: ${params.url}`);
      }
    }

    if (!resp || !resp.ok) return { success: false, error: lastError || '下载失败' };

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 50 * 1024 * 1024) return { success: false, error: '文件超过 50MB 限制' };

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, buf);

    sendLog('success', `⬇️ download_file 完成`, `${buf.length} bytes`);
    return {
      success: true,
      url: params.url,
      destination: destPath,
      size: buf.length,
      content_type: resp.headers.get('content-type') || 'unknown',
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    return {
      success: false,
      error: errMsg.includes('abort') ? `下载超时 (${Math.round(timeoutMs / 1000)}s)` : errMsg,
    };
  }
}

export async function handleCompress(params: {
  action: string;
  path: string;
  destination?: string;
  format?: string;
}): Promise<ToolResult> {
  try {
    const format = params.format || 'tar.gz';
    const isWin = process.platform === 'win32';

    if (params.action === 'create') {
      const srcPath = resolvePath(params.path);
      const check = checkPathAllowed(srcPath, 'read');
      if (!check.ok) return { success: false, error: check.reason };

      const destPath = params.destination
        ? resolvePath(params.destination)
        : srcPath + (format === 'zip' ? '.zip' : '.tar.gz');
      const destCheck = checkPathAllowed(destPath, 'write');
      if (!destCheck.ok) return { success: false, error: destCheck.reason };

      return new Promise((resolve) => {
        let child;
        const srcName = path.basename(srcPath);
        const cwd = path.dirname(srcPath);

        if (format === 'zip') {
          if (isWin) {
            const safeSrc = srcName.replace(/'/g, "''");
            const safeDest = destPath.replace(/'/g, "''");
            child = spawn(
              'powershell',
              ['-NoProfile', '-Command', `Compress-Archive -Path '${safeSrc}' -DestinationPath '${safeDest}' -Force`],
              { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
            );
          } else {
            child = spawn('zip', ['-r', destPath, srcName], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
          }
        } else {
          child = spawn('tar', ['czf', destPath, srcName], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        }

        let stderr = '';
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        child.on('close', (code) => {
          if (code === 0) {
            fs.stat(destPath)
              .then((s) => resolve({ success: true, action: 'create', archive: destPath, size: s.size }))
              .catch(() => resolve({ success: true, action: 'create', archive: destPath }));
          } else {
            resolve({ success: false, error: stderr || `压缩失败 (exit ${code})` });
          }
        });
        child.on('error', (err) => resolve({ success: false, error: err.message }));
      });
    }

    const archivePath = resolvePath(params.path);
    const check = checkPathAllowed(archivePath, 'read');
    if (!check.ok) return { success: false, error: check.reason };

    const destDir = params.destination ? resolvePath(params.destination) : path.dirname(archivePath);
    const destCheck = checkPathAllowed(destDir, 'write');
    if (!destCheck.ok) return { success: false, error: destCheck.reason };

    await fs.mkdir(destDir, { recursive: true });

    return new Promise((resolve) => {
      let child;
      const isZip = archivePath.endsWith('.zip');

      if (isZip) {
        if (isWin) {
          const safeArchive = archivePath.replace(/'/g, "''");
          const safeDest = destDir.replace(/'/g, "''");
          child = spawn(
            'powershell',
            ['-NoProfile', '-Command', `Expand-Archive -Path '${safeArchive}' -DestinationPath '${safeDest}' -Force`],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
        } else {
          child = spawn('unzip', ['-o', archivePath, '-d', destDir], { stdio: ['pipe', 'pipe', 'pipe'] });
        }
      } else {
        child = spawn('tar', ['xzf', archivePath, '-C', destDir], { stdio: ['pipe', 'pipe', 'pipe'] });
      }

      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('close', (code) => {
        resolve(
          code === 0
            ? { success: true, action: 'extract', destination: destDir }
            : { success: false, error: stderr || `解压失败 (exit ${code})` },
        );
      });
      child.on('error', (err) => resolve({ success: false, error: err.message }));
    });
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
