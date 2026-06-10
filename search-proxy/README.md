# metona-search-proxy

部署在可直连 Google/Bing/DuckDuckGo/Baidu 的云服务器上，通过 HTTP API 提供搜索引擎代理。

```
本应用(web_search) → HTTP → metona-search-proxy(:7899) → Google/Bing/DDG/Baidu → JSON
```

---

## 前置要求

| 依赖 | 说明 |
|------|------|
| **Go** | 1.21+（编译用，运行不需要） |
| **服务器** | 能直连 Google/Bing/DDG（海外云服务器/VPS） |
| **系统** | Linux (Ubuntu/Debian/CentOS) / macOS |

### 安装 Go（服务器上没有的话）

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y golang-go

# CentOS/RHEL
sudo yum install -y golang
```

---

## 编译

```bash
cd /opt
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop/search-proxy
go build -o metona-search-proxy .
```

### 本地交叉编译（编译好再上传）

```bash
# 编译 Linux 版本
GOOS=linux GOARCH=amd64 go build -o metona-search-proxy .

# 上传到服务器
scp metona-search-proxy user@your-server:/opt/metona-search-proxy/
```

---

## 全局命令

```bash
sudo cp metona-search-proxy /usr/local/bin/
sudo chmod +x /usr/local/bin/metona-search-proxy
```

之后任何目录都可以直接用：

```bash
metona-search-proxy --version
metona-search-proxy -status
```

---

## CLI 命令

### 服务管理

```bash
metona-search-proxy -start          # 后台启动
metona-search-proxy -stop           # 停止
metona-search-proxy -status         # 查看状态
metona-search-proxy -restart        # 重启
```

### 运行参数

```bash
metona-search-proxy [选项]

选项:
  -port int      监听端口 (默认 7899)
  -cache int     缓存时间/分钟 (默认 5)
  -rate int      限流速率 req/s (默认 30)
  -burst int     限流突发容量 (默认 60)
  -timeout int   搜索引擎超时/秒 (默认 12)
  -version       显示版本号
  -start         后台启动
  -stop          停止后台实例
  -status        查看运行状态
  -restart       重启后台实例
```

### 示例

```bash
# 查看状态
metona-search-proxy -status
# ● 运行中  PID: 12345  端口: 7899
#   健康检查: http://localhost:7899/health

# 前台运行（调试用，Ctrl+C 停止）
metona-search-proxy

# 后台启动
metona-search-proxy -start
# 已后台启动 (PID: 12345)

# 停止
metona-search-proxy -stop
# 已停止 (PID: 12345)
```

---

## 部署方式（二选一）

### 方式一：systemd 服务（推荐—生产环境）

```bash
# 1. 安装二进制
sudo mkdir -p /opt/metona-search-proxy
sudo cp metona-search-proxy /opt/metona-search-proxy/
sudo chmod +x /opt/metona-search-proxy/metona-search-proxy

# 2. 创建服务
sudo cp metona-search-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now metona-search-proxy

# 3. 管理
sudo systemctl status metona-search-proxy   # 状态
sudo systemctl stop metona-search-proxy     # 停止
sudo journalctl -u metona-search-proxy -f   # 日志
```

> ⚠️ 使用 systemd 后不要再用 `-start/-stop` CLI 命令，会冲突。

### 方式二：CLI 管理（轻量—个人开发）

```bash
# 安装全局命令
sudo cp metona-search-proxy /usr/local/bin/

# 启动
metona-search-proxy -start

# 查看状态
metona-search-proxy -status

# 停止
metona-search-proxy -stop

# 设置开机自启（加到 crontab）
(crontab -l 2>/dev/null; echo "@reboot metona-search-proxy -start") | crontab -
```

> ⚠️ 使用 CLI 管理前确保 systemd 服务已停止：`sudo systemctl stop metona-search-proxy`

---

## 测试

```bash
curl http://localhost:7899/health
curl "http://localhost:7899/search?q=hello&engine=google&n=5"
curl "http://localhost:7899/search?q=天气&engine=all&n=10"
```

---

## API

```
GET /search?q=关键词&engine=all&n=10

engine: google | bing | ddg | baidu | all (默认)
n: 1-20，默认10
缓存: 5分钟（可配）
限流: 30 req/s（可配）

GET /health
```

---

## 本应用配置

Metona Ollama Desktop → 设置 → 代理 → 填入：

```
http://服务器IP:7899
```

重启应用即可。
