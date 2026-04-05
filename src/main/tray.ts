/**
 * Metona Ollama Desktop - 系统托盘
 */

import { Tray, Menu, nativeImage } from 'electron';
import { mainWindow, isQuitting, getIconPath } from './main.js';

let tray: Tray | null = null;

export function createTray(): void {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开 Metona',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    { type: 'separator' },
    {
      label: '新建会话',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send('tray-action', 'new-chat');
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        const main = require('./main.js');
        main.isQuitting = true;
        require('electron').app.quit();
      }
    }
  ]);

  tray.setToolTip('Metona Ollama');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}
