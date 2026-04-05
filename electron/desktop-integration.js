/**
 * Metona Ollama Desktop - 桌面端集成
 *
 * 在 DOM 加载后执行，为现有 Web 应用添加桌面特性：
 * 1. 主进程菜单/托盘事件响应
 * 2. 原生文件对话框替换浏览器 input[type=file]
 * 3. 桌面端快捷键增强
 * 4. 标题栏集成
 */

(function () {
    'use strict';

    const bridge = window.__metonaBridge;
    if (!bridge || !bridge.isDesktop) {
        // 非桌面环境，跳过
        return;
    }

    console.log('[Desktop Integration] 初始化桌面集成...');

    // ── 1. 菜单/托盘事件响应 ──
    bridge.onMenuAction((action) => {
        switch (action) {
            case 'new-chat':
                document.querySelector('#btnNewChat')?.click();
                break;
            case 'import':
                document.querySelector('#btnImportSessions')?.click();
                break;
            case 'export':
                document.querySelector('#btnExportAll')?.click();
                break;
            case 'help':
                document.querySelector('#btnHelp')?.click();
                break;
        }
    });

    bridge.onTrayAction((action) => {
        switch (action) {
            case 'new-chat':
                document.querySelector('#btnNewChat')?.click();
                break;
        }
    });

    // ── 2. 增强文件上传 - 使用原生文件对话框 ──
    function setupNativeFilePicker(btnId, inputId, fileFilters) {
        const btn = document.querySelector(btnId);
        const input = document.querySelector(inputId);
        if (!btn || !input) return;

        // 拦截点击事件，使用原生对话框
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const filePaths = await bridge.openFile(fileFilters);
            if (!filePaths || filePaths.length === 0) return;

            // 读取所有文件
            for (const filePath of filePaths) {
                const result = await bridge.readFile(filePath);
                if (result.success) {
                    // 创建 File 对象注入到原有流程
                    const blob = new Blob([result.content], { type: 'text/plain' });
                    const file = new File([blob], result.name, { type: 'text/plain' });

                    // 使用 DataTransfer 注入文件到 input，触发 change 事件
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    input.files = dt.files;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }, true); // capture phase, 优先于原有事件
    }

    // DOM 就绪后设置
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupEnhancements);
    } else {
        setupEnhancements();
    }

    function setupEnhancements() {
        // 代码/文本文件上传
        setupNativeFilePicker(
            '#btnAttachFile',
            '#textFileInput',
            [
                { name: '代码文件', extensions: ['py', 'js', 'ts', 'tsx', 'java', 'go', 'rs', 'cpp', 'c', 'h', 'rb', 'php', 'sh', 'swift', 'kt', 'lua'] },
                { name: '配置文件', extensions: ['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'conf'] },
                { name: '文档', extensions: ['txt', 'md', 'log', 'csv', 'html', 'css'] },
                { name: '所有文件', extensions: ['*'] }
            ]
        );
    }

    // ── 3. 标题更新 - 显示连接/模型状态 ──
    const origTitle = document.title;
    window.addEventListener('metona:model-changed', (e) => {
        if (e.detail?.model) {
            document.title = `${e.detail.model} - Metona Ollama`;
        } else {
            document.title = origTitle;
        }
    });

    // ── 4. 桌面端键盘快捷键 ──
    document.addEventListener('keydown', (e) => {
        // Ctrl+N 新建会话（与菜单同步）
        if (e.ctrlKey && e.key === 'n') {
            e.preventDefault();
            document.querySelector('#btnNewChat')?.click();
        }
    });

    console.log('[Desktop Integration] 桌面集成完成 ✓');
})();
