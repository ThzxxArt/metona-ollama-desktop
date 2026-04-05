/**
 * Metona Ollama Desktop - IPC 处理器
 */

import { ipcMain, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { mainWindow } from './main.js';
import { showNotification } from './utils.js';

export function setupIPC(): void {
  ipcMain.handle('dialog:openFile', async (_, options?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: options?.filters || [{ name: '所有文件', extensions: ['*'] }]
    });
    if (result.canceled) return null;
    return result.filePaths;
  });

  ipcMain.handle('dialog:saveFile', async (_, options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: options?.defaultPath || 'export',
      filters: options?.filters || [{ name: '所有文件', extensions: ['*'] }]
    });
    if (result.canceled) return null;
    return result.filePath;
  });

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { success: true, content, name: path.basename(filePath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('notify', (_: unknown, title: string, body: string) => {
    showNotification(title, body);
  });

  ipcMain.handle('app:info', () => ({
    version: require('electron').app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    userDataPath: require('electron').app.getPath('userData')
  }));

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
