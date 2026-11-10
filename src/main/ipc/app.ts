/**
 * 应用 / 文件对话框 / 系统信息 / 更新检查 IPC。
 */

import { ipcMain, dialog, shell, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mainWindow } from '../main.js';
import { showNotification } from '../utils.js';
import { checkPathAllowed } from '../tool-security.js';

export function registerAppIPC(): void {
  ipcMain.handle(
    'dialog:openFile',
    async (
      _,
      options?: { filters?: Array<{ name: string; extensions: string[] }>; properties?: string[]; multiple?: boolean },
    ) => {
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
    },
  );

  ipcMain.handle(
    'dialog:saveFile',
    async (_, options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: options?.defaultPath || 'export',
        filters: options?.filters || [{ name: '所有文件', extensions: ['*'] }],
      });
      if (result.canceled) return null;
      return result.filePath;
    },
  );

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
    if (result.canceled) return null;
    return result.filePaths;
  });

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    try {
      const check = checkPathAllowed(path.resolve(filePath), 'read');
      if (!check.ok) return { success: false, error: check.reason };
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { success: true, content, name: path.basename(filePath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:readFileBase64', async (_, filePath: string) => {
    try {
      const check = checkPathAllowed(path.resolve(filePath), 'read');
      if (!check.ok) return { success: false, error: check.reason };
      const buf = await fs.promises.readFile(filePath);
      return { success: true, content: buf.toString('base64'), size: buf.length, name: path.basename(filePath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string, encoding?: string) => {
    try {
      const check = checkPathAllowed(path.resolve(filePath), 'write');
      if (!check.ok) return { success: false, error: check.reason };
      await fs.promises.writeFile(filePath, content, (encoding as BufferEncoding) || 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('notify', (_: unknown, title: string, body: string) => {
    showNotification(title, body);
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    userDataPath: app.getPath('userData'),
  }));

  const sysInfo = () => ({
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    shell: process.env.SHELL || process.env.ComSpec || (process.platform === 'win32' ? 'cmd.exe' : 'bash'),
    arch: os.arch(),
    platform: os.platform(),
    hostname: os.hostname(),
    username: os.userInfo().username,
  });

  ipcMain.handle('app:sys', () => sysInfo());
  ipcMain.on('app:sys:sync', (event) => {
    event.returnValue = sysInfo();
  });

  ipcMain.handle('app:checkUpdate', async () => {
    try {
      const current = String(app.getVersion());
      const response = await fetch('https://api.github.com/repos/ThzxxArt/metona-ollama-desktop/releases/latest', {
        headers: { 'User-Agent': `Metona-Ollama/${current}`, Accept: 'application/vnd.github+json' },
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

  ipcMain.handle('app:readResource', (_, name: string) => {
    const safe = path.basename(String(name || ''));
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

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  ipcMain.handle('shell:openExternal', (_, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
      shell.openExternal(url);
    }
  });
}
