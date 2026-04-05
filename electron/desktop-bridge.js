/**
 * Metona Ollama Desktop - 渲染进程桥接模块
 *
 * 在 Web 应用启动前加载，将桌面能力注入到 window 对象
 * 提供优雅降级：Web 环境下所有 desktop API 返回 null/空函数
 */

// Desktop API 由 preload.js 通过 contextBridge 注入
// 这里做一层封装，提供统一的降级处理

const desktop = window.metonaDesktop || null;

const bridge = {
    /** 是否在 Electron 桌面环境中 */
    isDesktop: !!desktop,

    /** 应用信息 */
    async getInfo() {
        if (!desktop) return { platform: 'web', version: '1.0.0' };
        return desktop.info();
    },

    /** 打开原生文件选择对话框 */
    async openFile(filters) {
        if (!desktop) return null;
        return desktop.dialog.openFile(filters);
    },

    /** 打开原生保存对话框 */
    async saveFile(options) {
        if (!desktop) return null;
        return desktop.dialog.saveFile(options);
    },

    /** 读取文件内容 */
    async readFile(filePath) {
        if (!desktop) return { success: false, error: 'Not in desktop' };
        return desktop.fs.readFile(filePath);
    },

    /** 写入文件 */
    async writeFile(filePath, content) {
        if (!desktop) return { success: false, error: 'Not in desktop' };
        return desktop.fs.writeFile(filePath, content);
    },

    /** 发送系统通知 */
    notify(title, body) {
        if (desktop) {
            desktop.notify(title, body);
        } else if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body });
        }
    },

    /** 最小化窗口 */
    minimize() {
        desktop?.window.minimize();
    },

    /** 最大化/还原 */
    maximize() {
        desktop?.window.maximize();
    },

    /** 关闭窗口 */
    close() {
        desktop?.window.close();
    },

    /** 打开外部链接 */
    openExternal(url) {
        if (desktop) {
            desktop.openExternal(url);
        } else {
            window.open(url, '_blank');
        }
    },

    /** 监听主进程菜单事件 */
    onMenuAction(callback) {
        desktop?.onMenuAction(callback);
    },

    /** 监听托盘事件 */
    onTrayAction(callback) {
        desktop?.onTrayAction(callback);
    },

    /** 注销监听 */
    off(channel) {
        desktop?.removeAllListeners(channel);
    }
};

// 暴露到全局
window.__metonaBridge = bridge;

// 打印环境信息
if (bridge.isDesktop) {
    bridge.getInfo().then(info => {
        console.log('[Desktop] Metona Ollama Desktop');
        console.log('[Desktop] Platform:', info.platform, info.arch);
        console.log('[Desktop] Electron:', info.electronVersion);
        console.log('[Desktop] User Data:', info.userDataPath);
    });
}
