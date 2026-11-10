# README 排版规范

## 1. 结构

1. SVG 横幅（`<picture>` 深浅色）
2. 标题 + 一句话定位 + 语言切换
3. 徽章（flat-square）
4. 为什么选择（4 张卡片）
5. 功能亮点
6. 截图
7. 下载安装表
8. 快速开始（本地 / 远程 / Cloud）
9. API Key 规则
10. 工具矩阵（`<details>`）
11. 架构图（Mermaid）
12. 安全与隐私
13. 开发
14. 发布
15. Roadmap
16. FAQ（`<details>`）
17. License / 致谢

## 2. 徽章

- 统一 `flat-square`，8–10 个。
- Release、CI、License、Platform、Electron、TypeScript、Ollama、Downloads、Stars。
- 链接必须指向 GitHub 仓库或 Releases。

## 3. SVG

- 横幅 1600×420，纯静态，无脚本、无外链图片。
- 浅色：`#FAF7F2` 背景 / `#2D2016` 文字 / `#E8734A` 强调。
- 深色：`#1A1B26` 背景 / `#E0E0E8` 文字 / `#E8734A` 强调。
- 字体：`Inter, 'Noto Sans SC', 'PingFang SC', system-ui, sans-serif`。
- 必须包含 `<title>` / `<desc>`。
- README 用 `<picture>` 切换深浅色。

## 4. 截图

- 路径：`docs/assets/screenshots/`。
- 主界面亮/暗、远程设置、工具面板。
- 优先由 E2E 生成；不得手工伪造真实产品截图。
- 当前仓库使用 SVG 界面示意图，后续可替换为 E2E PNG。

## 5. 文案

- 中文 README 不混入英文段落；英文版独立。
- 命令、路径、字段名用反引号。
- 破坏性变更必须用 `> [!WARNING]`。
- 不宣传已移除的 Plan Mode。
- 工具数量固定为 **18**。
