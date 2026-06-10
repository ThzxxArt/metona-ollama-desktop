# search-proxy

香港服务器上的搜索引擎代理。本应用通过 HTTP API 调用，直连 Google/Bing/DDG。

## 部署

```bash
# 1. 拷贝到服务器
scp search-proxy user@your-server:/opt/search-proxy/

# 2. 编译（如果有 Go 环境）
cd /opt/search-proxy && go build -o search-proxy .

# 或者本地交叉编译后上传：
# GOOS=linux GOARCH=amd64 go build -o search-proxy .

# 3. 测试
./search-proxy &
curl "http://localhost:8080/health"
curl "http://localhost:8080/search?q=hello&engine=google&n=5"

# 4. 安装 systemd 服务（可选，开机自启）
sudo cp search-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now search-proxy
```

## API

```
GET /search?q=关键词&engine=google&n=10

engine: google | bing | ddg | all
n: 1-20，默认10
缓存: 5分钟

GET /health
→ {"status":"ok"}
```

## 本应用配置

在设置面板的代理输入框中填入：`http://你的服务器IP:8080`

或者通过代理设置：在 search-proxy 前挂 nginx 反代加 HTTPS。
