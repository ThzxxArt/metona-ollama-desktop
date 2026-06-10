# search-proxy

部署在可直连 Google/Bing/DuckDuckGo 的云服务器上，通过 HTTP API 提供搜索引擎代理。

## 部署

```bash
# 1. 上传到服务器
scp search-proxy user@your-server:/opt/search-proxy/

# 2. 编译
cd /opt/search-proxy && go build -o search-proxy .

# 本地交叉编译：
# GOOS=linux GOARCH=amd64 go build -o search-proxy .

# 3. 启动（默认端口 18080）
PORT=18080 ./search-proxy &

# 4. 测试
curl "http://localhost:18080/health"
curl "http://localhost:18080/search?q=hello&n=5"

# 5. 安装 systemd 服务
sudo cp search-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now search-proxy
```

## API

```
GET /search?q=关键词&engine=google&n=10

engine: google | bing | ddg | baidu | all (默认)
n: 1-20，默认10
缓存: 5分钟
限流: 30 req/s

GET /health
→ {"status":"ok","engines":["google","bing","ddg","baidu","all"],"time":"..."}
```

## 本应用配置

设置面板 → 代理设置 → 填入 `http://服务器IP:18080` → 重启
