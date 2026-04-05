/**
 * Metona Ollama Desktop - Preload 脚本
 *
 * 通过 contextBridge 安全暴露 IPC 接口给渲染进程
 * 所有 API 都是白名单模式，不暴露 Node.js 全局对象
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── 暴露 Desktop API ──
contextBridge.exposeInMainWorld('metonaDesktop', {
    // 是否在桌面环境中
    isDesktop: true,

    // 版本信息
    info: () => ipcRenderer.invoke('app:info'),

    // ── 文件对话框 ──
    dialog: {
        openFile: (filters) => ipcRenderer.invoke('dialog:openFile', { filters }),
        saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options)
    },

    // ── 文件系统 ──
    fs: {
        readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
        writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content)
    },

    // ── 系统通知 ──
    notify: (title, body) => ipcRenderer.invoke('notify', title, body),

    // ── 窗口控制 ──
    window: {
        minimize: () => ipcRenderer.invoke('window:minimize'),
        maximize: () => ipcRenderer.invoke('window:maximize'),
        close: () => ipcRenderer.invoke('window:close')
    },

    // ── 外部链接 ──
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

    // ── 主进程事件监听 ──
    onMenuAction: (callback) => {
        ipcRenderer.on('menu-action', (_, action) => callback(action));
    },
    onTrayAction: (callback) => {
        ipcRenderer.on('tray-action', (_, action) => callback(action));
    },
    // 移除监听
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    }
});
