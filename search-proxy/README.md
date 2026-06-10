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

# 或手动安装最新版
wget https://go.dev/dl/go1.22.0.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.22.0.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc && source ~/.bashrc
```

---

## 安装与编译

```bash
# 1. 克隆仓库
cd /opt
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop/search-proxy

# 2. 编译
go build -o metona-search-proxy .

# 3. 验证
./metona-search-proxy --version
# metona-search-proxy v2.0.0  go/go1.22.0
```

### 本地交叉编译（在本地编译好上传）

```bash
# Windows 上编译 Linux 版本
GOOS=linux GOARCH=amd64 go build -o metona-search-proxy .

# macOS 上编译 Linux 版本
GOOS=linux GOARCH=amd64 go build -o metona-search-proxy .

# 上传到服务器
scp metona-search-proxy user@your-server:/opt/metona-search-proxy/
```

---

## CLI 命令

```bash
./metona-search-proxy [选项]

选项:
  -port int      监听端口 (默认 7899)
  -cache int     缓存时间/分钟 (默认 5)
  -rate int      限流速率 req/s (默认 30)
  -burst int     限流突发容量 (默认 60)
  -timeout int   搜索引擎超时/秒 (默认 12)
  -version       显示版本号

示例:
  ./metona-search-proxy                                   # 默认配置
  ./metona-search-proxy -port 7899 -cache 10              # 自定义端口和缓存
  ./metona-search-proxy -port 7899 -rate 50 -burst 100    # 高并发配置
  PORT=7899 ./metona-search-proxy                          # 也可用环境变量
```

---

## 测试

```bash
# 启动
./metona-search-proxy &

# 健康检查
curl http://localhost:7899/health

# 单引擎搜索
curl "http://localhost:7899/search?q=hello+world&engine=google&n=5"

# 四引擎并行
curl "http://localhost:7899/search?q=今天天气&engine=all&n=10"

# 百度搜索
curl "http://localhost:7899/search?q=春节&engine=baidu&n=5"
```

### 响应格式

```json
{
  "success": true,
  "query": "hello world",
  "engine": "google",
  "total": 5,
  "results": [
    {
      "title": "...",
      "url": "https://...",
      "snippet": "...",
      "engine": "google"
    }
  ]
}
```

---

## 安装为系统服务（开机自启）

### 1. 拷贝二进制文件

```bash
sudo mkdir -p /opt/metona-search-proxy
sudo cp metona-search-proxy /opt/metona-search-proxy/
sudo chmod +x /opt/metona-search-proxy/metona-search-proxy
```

### 2. 创建 systemd 服务文件

```bash
sudo tee /etc/systemd/system/metona-search-proxy.service << 'EOF'
[Unit]
Description=Metona Search Proxy - Google/Bing/DDG/Baidu API
After=network.target

[Service]
Type=simple
ExecStart=/opt/metona-search-proxy/metona-search-proxy
Restart=always
RestartSec=5
Environment=PORT=7899

[Install]
WantedBy=multi-user.target
EOF
```

### 3. 启动服务

```bash
sudo systemctl daemon-reload
sudo systemctl enable metona-search-proxy   # 开机自启
sudo systemctl start metona-search-proxy    # 立即启动

# 查看状态
sudo systemctl status metona-search-proxy

# 查看日志
sudo journalctl -u metona-search-proxy -f
```

### 4. 验证

```bash
curl http://localhost:7899/health
# {"engines":["google","bing","ddg","baidu","all"],"status":"ok","time":"...","version":"2.0.0"}
```

---

## 本应用配置

Metona Ollama Desktop 设置面板 → 代理设置 → 填入：

```
http://你的服务器IP:7899
```

重启应用即可。web_search 的 Google/DDG/Bing/百度 四引擎请求会自动路由到这台服务器。

---

## 常用管理命令

```bash
sudo systemctl start metona-search-proxy     # 启动
sudo systemctl stop metona-search-proxy      # 停止
sudo systemctl restart metona-search-proxy   # 重启
sudo systemctl status metona-search-proxy    # 状态
sudo journalctl -u metona-search-proxy -f    # 实时日志
sudo journalctl -u metona-search-proxy --since today  # 今日日志
```
