# stream-relay

轻量 Node.js 中转，将 `data.stnye.cc/data/stream.php` 请求从非 Cloudflare IP 发出，
绕过 stream.php 对 CF Worker 出口 IP 的 Bot Fight Mode 拦截。

## 接口

- `GET /health` 健康检查
- `GET /stream?id=<32位hex>` 查询流地址，透传 stream.php 的 JSON 响应

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `3000` |
| `RELAY_SECRET` | 可选访问密钥（查询参数 `secret=` 或 Header `X-Relay-Secret`） | 空（不校验） |

## 部署（Railway）

1. Fork 或推送本 repo 到 GitHub
2. railway.app → New Project → Deploy from GitHub repo
3. 选本 repo，Railway 自动识别 Dockerfile 构建
4. 部署完成后复制域名，填入 CF Worker 的 `RELAY_URL`
