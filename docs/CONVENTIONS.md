# 📏 开发规范

## 版本管理

### 版本号更新

更新版本号时，需同步修改以下文件：

| 文件 | 内容 |
|------|------|
| `package.json` | `"version": "X.Y.Z"` |
| `src/renderer/index.html` | `<span class="app-version">vX.Y.Z</span>` |
| `README.md` | 版本徽章、下载文件名、构建分支引用 |
| `docs/BUILD.md` | 构建分支引用、新增构建日志条目 |
| `docs/CHANGELOG.md` | 版本分支结构链、新增版本说明条目 |

### 更新日志

- **所有更新日志只写在 `docs/CHANGELOG.md`**
- `README.md` 不写历史版本记录，只保留一行链接指向 `docs/CHANGELOG.md`
- 版本分支结构链在 `docs/CHANGELOG.md` 顶部维护

## 分支策略

- `master` — 稳定发布分支
- `develop` — 日常开发分支
- `metona-ollama-desktop-vX.Y.Z` — 每个版本对应的发布分支

**提交规则：**
- 默认只推送到当前所在分支
- 需要同步到其他分支时，用户会明确指定
- 不要自作主张往多个分支推送

## 项目结构

```
metona-ollama-desktop/
├── src/
│   ├── main/          # Electron 主进程
│   └── renderer/      # 渲染进程
├── assets/icons/      # 图标资源
├── docs/
│   ├── BUILD.md       # 构建指南
│   ├── CHANGELOG.md   # 更新日志（唯一）
│   ├── CONVENTIONS.md # 本文档
│   └── DEVELOPMENT.md # 开发说明
├── package.json
├── README.md
└── ...
```
