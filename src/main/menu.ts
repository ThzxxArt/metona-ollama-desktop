/**
 * Metona Ollama Desktop - 原生菜单
 */

import { Menu, dialog, shell, app } from 'electron';
import { mainWindow, setQuitting, getIconPath } from './main.js';

export function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'Ctrl+N',
          click: () => mainWindow?.webContents.send('menu-action', 'new-chat')
        },
        { type: 'separator' },
        {
          label: '导入会话',
          click: () => mainWindow?.webContents.send('menu-action', 'import')
        },
        {
          label: '导出会话',
          accelerator: 'Ctrl+Shift+E',
          click: () => mainWindow?.webContents.send('menu-action', 'export')
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'Ctrl+Q',
          click: () => {
            setQuitting();
            app.quit();
          }
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '重置缩放' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        {
          label: '最大化/还原',
          click: () => {
            if (mainWindow?.isMaximized()) mainWindow.unmaximize();
            else mainWindow?.maximize();
          }
        },
        { type: 'separator' },
        {
          label: '置顶',
          type: 'checkbox',
          checked: false,
          click: (menuItem: Electron.MenuItem) => {
            mainWindow?.setAlwaysOnTop(menuItem.checked);
          }
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '使用帮助',
          click: () => mainWindow?.webContents.send('menu-action', 'help')
        },
        { type: 'separator' },
        {
          label: '关于 Ollama',
          click: () => shell.openExternal('https://ollama.com')
        },
        {
          label: '关于 Metona',
          click: () => {
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: '关于 Metona Ollama',
              message: 'Metona Ollama Desktop v0.11.1',
              detail: 'TypeScript + Electron Ollama AI 聊天客户端\n\nhttps://gitee.com/thzxx/metona-ollama',
              icon: getIconPath()
            });
          }
        }
      ]
    }
  ];

  if (!app.isPackaged) {
    template.push({
      label: 'Dev',
      submenu: [
        {
          label: '切换开发者工具',
          accelerator: 'F12',
          click: () => mainWindow?.webContents.toggleDevTools()
        }
      ]
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
