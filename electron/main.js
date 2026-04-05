/**
 * Metona Ollama Desktop - 主进程
 *
 * 职责：
 * 1. 应用生命周期管理
 * 2. BrowserWindow 创建与配置
 * 3. 原生菜单、系统托盘
 * 4. IPC 通信桥梁（文件对话框、通知、窗口控制）
 * 5. 单实例锁
 */

const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// ── 常量 ──
const APP_NAME = 'Metona Ollama';
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icons', 'llama.png');
const ICO_PATH = path.join(__dirname, '..', 'assets', 'icons', 'llama.ico');
const IS_DEV = !app.isPackaged;

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ── 单实例锁 ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

// ── 创建主窗口 ──
function createMainWindow() {
    // 读取上次窗口大小
    const userDataPath = app.getPath('userData');
    const configPath = path.join(userDataPath, 'window-state.json');
    let windowState = { width: 1200, height: 800, x: undefined, y: undefined, maximized: false };

    try {
        if (fs.existsSync(configPath)) {
            windowState = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }
    } catch { /* 使用默认值 */ }

    mainWindow = new BrowserWindow({
        width: windowState.width || 1200,
        height: windowState.height || 800,
        x: windowState.x,
        y: windowState.y,
        minWidth: 800,
        minHeight: 600,
        icon: process.platform === 'win32' ? ICO_PATH : ICON_PATH,
        title: APP_NAME,
        backgroundColor: '#0a0a1a',
        show: false, // 等 ready-to-show 再显示，避免闪烁
        autoHideMenuBar: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            // 关闭同源策略，避免 Ollama CORS 问题
            webSecurity: false,
            allowRunningInsecureContent: false
        }
    });

    // 加载应用
    mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

    // 窗口准备好后显示
    mainWindow.once('ready-to-show', () => {
        if (windowState.maximized) {
            mainWindow.maximize();
        }
        mainWindow.show();
    });

    // 保存窗口状态
    const saveWindowState = () => {
        if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
        const bounds = mainWindow.getBounds();
        try {
            fs.writeFileSync(configPath, JSON.stringify(bounds));
        } catch { /* 忽略写入错误 */ }
    };

    mainWindow.on('resize', saveWindowState);
    mainWindow.on('move', saveWindowState);

    mainWindow.on('maximize', () => {
        try {
            const state = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            state.maximized = true;
            fs.writeFileSync(configPath, JSON.stringify(state));
        } catch { /* 忽略 */ }
    });

    mainWindow.on('unmaximize', () => {
        try {
            const state = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            state.maximized = false;
            fs.writeFileSync(configPath, JSON.stringify(state));
        } catch { /* 忽略 */ }
    });

    // 关闭窗口时：最小化到托盘而非退出
    mainWindow.on('close', (e) => {
        if (!isQuitting && tray) {
            e.preventDefault();
            mainWindow.hide();
            // 首次最小化到托盘时显示通知
            if (!global._trayHintShown) {
                global._trayHintShown = true;
                showNotification('Metona 已最小化到系统托盘', '点击托盘图标可重新打开');
            }
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 外部链接用系统浏览器打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    return mainWindow;
}

// ── 创建系统托盘 ──
function createTray() {
    const icon = nativeImage.createFromPath(process.platform === 'win32' ? ICO_PATH : ICON_PATH);
    tray = new Tray(icon.resize({ width: 16, height: 16 }));

    const contextMenu = Menu.buildFromTemplate([
        {
            label: '打开 Metona',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        { type: 'separator' },
        {
            label: '新建会话',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                    mainWindow.webContents.send('tray-action', 'new-chat');
                }
            }
        },
        { type: 'separator' },
        {
            label: '退出',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip(APP_NAME);
    tray.setContextMenu(contextMenu);

    // 双击托盘图标打开窗口
    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// ── 原生菜单 ──
function createMenu() {
    const template = [
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
                    click: () => { isQuitting = true; app.quit(); }
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
                    click: (menuItem) => {
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
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: '关于 Metona Ollama',
                            message: 'Metona Ollama Desktop v1.0.0',
                            detail: '基于原生 JavaScript 的 Ollama AI 聊天客户端\n桌面版由 Electron 驱动\n\nhttps://gitee.com/thzxx/metona-ollama',
                            icon: process.platform === 'win32' ? ICO_PATH : ICON_PATH
                        });
                    }
                }
            ]
        }
    ];

    // 开发环境增加开发者工具菜单
    if (IS_DEV) {
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

// ── 系统通知 ──
function showNotification(title, body) {
    if (Notification.isSupported()) {
        new Notification({ title, body, icon: ICON_PATH }).show();
    }
}

// ── IPC 处理 ──
function setupIPC() {
    // 打开文件对话框
    ipcMain.handle('dialog:openFile', async (_, options) => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile', 'multiSelections'],
            filters: options?.filters || [
                { name: '所有文件', extensions: ['*'] }
            ]
        });
        if (result.canceled) return null;
        return result.filePaths;
    });

    // 保存文件对话框
    ipcMain.handle('dialog:saveFile', async (_, options) => {
        const result = await dialog.showSaveDialog(mainWindow, {
            defaultPath: options?.defaultPath || 'export',
            filters: options?.filters || [
                { name: '所有文件', extensions: ['*'] }
            ]
        });
        if (result.canceled) return null;
        return result.filePath;
    });

    // 读取文件内容
    ipcMain.handle('fs:readFile', async (_, filePath) => {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return { success: true, content, name: path.basename(filePath) };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // 写入文件
    ipcMain.handle('fs:writeFile', async (_, filePath, content) => {
        try {
            await fs.promises.writeFile(filePath, content, 'utf-8');
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // 发送系统通知
    ipcMain.handle('notify', (_, title, body) => {
        showNotification(title, body);
    });

    // 获取应用信息
    ipcMain.handle('app:info', () => ({
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron,
        userDataPath: app.getPath('userData')
    }));

    // 窗口控制
    ipcMain.handle('window:minimize', () => mainWindow?.minimize());
    ipcMain.handle('window:maximize', () => {
        if (mainWindow?.isMaximized()) mainWindow.unmaximize();
        else mainWindow?.maximize();
    });
    ipcMain.handle('window:close', () => mainWindow?.close());

    // 打开外部链接
    ipcMain.handle('shell:openExternal', (_, url) => {
        if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
            shell.openExternal(url);
        }
    });
}

// ── 应用生命周期 ──
app.whenReady().then(() => {
    setupIPC();
    createMainWindow();
    createTray();
    createMenu();

    // macOS: 点击 Dock 图标时重新创建窗口
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        } else if (mainWindow) {
            mainWindow.show();
        }
    });
});

// 所有窗口关闭时不退出（有托盘）
app.on('window-all-closed', () => {
    // macOS 习惯保留
    if (process.platform !== 'darwin') {
        // 有托盘时不退出
        if (!tray) app.quit();
    }
});

app.on('before-quit', () => {
    isQuitting = true;
});

// 移除默认菜单（Windows 生产环境）
if (process.platform === 'win32' && !IS_DEV) {
    app.on('browser-window-created', (_, win) => {
        // 保留自定义菜单
    });
}
