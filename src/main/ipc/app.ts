/**
 * 应用 / 文件对话框 / 系统信息 / 更新检查 IPC。
 * 所有通道均经过发送方校验与入参校验。
 */

import { dialog, shell, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { mainWindow } from '../window-state.js';
import { showNotification } from '../utils.js';
import { checkPathAllowed } from '../tool-security.js';
import { handleTrusted, onTrusted, parseArgs } from './register.js';

const filePathSchema = z.string().min(1).max(4096);
const openExternalSchema = z
  .string()
  .max(4096)
  .refine((url) => /^(https?:\/\/|mailto:)/i.test(url), '仅允许 http/https/mailto 链接');

const dialogFiltersSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(128),
      extensions: z.array(z.string().min(1).max(32)).min(1).max(128),
    }),
  )
  .max(32);

const openFileOptionsSchema = z
  .object({
    filters: dialogFiltersSchema.optional(),
    properties: z.array(z.string().max(64)).max(16).optional(),
    multiple: z.boolean().optional(),
  })
  .strict();

const saveFileOptionsSchema = z
  .object({
    defaultPath: z.string().max(4096).optional(),
    filters: dialogFiltersSchema.optional(),
  })
  .strict();

function sysInfo() {
  return {
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    shell: process.env.SHELL || process.env.ComSpec || (process.platform === 'win32' ? 'cmd.exe' : 'bash'),
    arch: os.arch(),
    platform: os.platform(),
    hostname: os.hostname(),
    username: os.userInfo().username,
  };
}

export function registerAppIPC(): void {
  handleTrusted('dialog:openFile', async (_, rawOptions?: unknown) => {
    const options = rawOptions === undefined ? undefined : parseArgs(openFileOptionsSchema, rawOptions);
    const dialogProperties: Array<'openFile' | 'multiSelections' | 'openDirectory'> = ['openFile'];
    if (options?.multiple !== false && !options?.properties?.includes('openFile')) {
      dialogProperties.push('multiSelections');
    }
    if (options?.properties) {
      for (const p of options.properties) {
        if (p === 'multiSelections' && !dialogProperties.includes('multiSelections')) {
          dialogProperties.push('multiSelections');
        }
      }
    }
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: dialogProperties,
      filters: options?.filters || [{ name: '所有文件', extensions: ['*'] }],
    });
    if (result.canceled) return null;
    return result.filePaths;
  });

  handleTrusted('dialog:saveFile', async (_, rawOptions?: unknown) => {
    const options = rawOptions === undefined ? undefined : parseArgs(saveFileOptionsSchema, rawOptions);
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: options?.defaultPath || 'export',
      filters: options?.filters || [{ name: '所有文件', extensions: ['*'] }],
    });
    if (result.canceled) return null;
    return result.filePath;
  });

  handleTrusted('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
    if (result.canceled) return null;
    return result.filePaths;
  });

  handleTrusted('fs:readFile', async (_, rawPath: unknown) => {
    const filePath = parseArgs(filePathSchema, rawPath);
    try {
      const check = checkPathAllowed(path.resolve(filePath), 'read');
      if (!check.ok) return { success: false, error: check.reason };
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { success: true, content, name: path.basename(filePath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  handleTrusted('fs:readFileBase64', async (_, rawPath: unknown) => {
    const filePath = parseArgs(filePathSchema, rawPath);
    try {
      const check = checkPathAllowed(path.resolve(filePath), 'read');
      if (!check.ok) return { success: false, error: check.reason };
      const buf = await fs.promises.readFile(filePath);
      return { success: true, content: buf.toString('base64'), size: buf.length, name: path.basename(filePath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  handleTrusted('fs:writeFile', async (_, rawPath: unknown, rawContent: unknown, encoding?: unknown) => {
    const filePath = parseArgs(filePathSchema, rawPath);
    const content = parseArgs(z.string().max(128 * 1024 * 1024), rawContent);
    const enc = encoding === undefined ? 'utf-8' : parseArgs(z.enum(['utf-8', 'latin1', 'base64']), encoding);
    try {
      const check = checkPathAllowed(path.resolve(filePath), 'write');
      if (!check.ok) return { success: false, error: check.reason };
      await fs.promises.writeFile(filePath, content, enc);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  handleTrusted('notify', (_, title: unknown, body: unknown) => {
    showNotification(parseArgs(z.string().max(200), title), parseArgs(z.string().max(2000), body));
  });

  handleTrusted('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    userDataPath: app.getPath('userData'),
  }));

  onTrusted('app:sys:sync', (event) => {
    event.returnValue = sysInfo();
  });

  handleTrusted('app:checkUpdate', async () => {
    try {
      const current = String(app.getVersion());
      const response = await fetch('https://api.github.com/repos/ThzxxArt/metona-ollama-desktop/releases/latest', {
        headers: { 'User-Agent': `Metona-Ollama/${current}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return { hasUpdate: false, current };
      const release = (await response.json()) as { tag_name?: string; html_url?: string };
      const latest = String(release.tag_name || '').replace(/^v/, '');
      if (!latest) return { hasUpdate: false, current };
      const cmp = (a: string, b: string): number => {
        const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
        const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pa[i] || 0) - (pb[i] || 0);
          if (d !== 0) return d;
        }
        return 0;
      };
      return {
        hasUpdate: cmp(latest, current) > 0,
        current,
        latest,
        url: release.html_url || 'https://github.com/ThzxxArt/metona-ollama-desktop/releases/latest',
      };
    } catch (err) {
      return { hasUpdate: false, error: (err as Error).message };
    }
  });

  handleTrusted('app:readResource', (_, rawName: unknown) => {
    const name = parseArgs(z.string().min(1).max(256), rawName);
    const safe = path.basename(name);
    if (!safe || safe.startsWith('.')) {
      return { success: false, error: `非法资源名: ${name}` };
    }
    const base = app.isPackaged
      ? path.join(app.getAppPath(), 'dist', 'renderer')
      : path.join(app.getAppPath(), 'src', 'renderer', 'public');
    const filePath = path.join(base, safe);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, content };
    } catch {
      return { success: false, error: `资源不存在: ${safe}` };
    }
  });

  handleTrusted('window:minimize', () => mainWindow?.minimize());
  handleTrusted('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  handleTrusted('window:close', () => mainWindow?.close());

  handleTrusted('shell:openExternal', (_, rawUrl: unknown) => {
    const url = parseArgs(openExternalSchema, rawUrl);
    void shell.openExternal(url);
  });
}
