# Cloudflare 部署

此方案使用 Cloudflare Tunnel 发布普通 HTTP / WebSocket 应用。无需编写 Workers，也不使用 agent-relay 的自定义中继协议。

## 1. 先验证本地桌面

完成 README 的初始化及本地启动，验证桌面、输入和 Codex 均可用。Tunnel 不会修复容器里的桌面或登录问题。

## 2. 先创建 Access 保护

在 Cloudflare One 控制台中创建 Self-hosted 应用：

- 域名：例如 `desktop.example.com`。
- Allow 策略：只允许你自己的账号或邮箱。
- 身份提供方：你实际使用的登录方式。
- 不要为桌面路径或 WebSocket 配置绕过验证的 Bypass。

完整入口受 Access 保护，工作台内仍保留独立登录。Cloudflare 会终止浏览器 HTTPS；此方案不是 agent-relay 的应用层端到端加密协议。

## 3. 创建 Tunnel

在 Networking → Tunnels 中创建 Tunnel，配置 Published application 路由：

```text
Hostname: desktop.example.com
Service:  HTTP
URL:      panel:8080
```

这里的 `cloudflared` 和面板在同一个 Compose 网络中，服务地址必须是 `panel:8080`，不能填 `localhost:36080`。

在 Tunnel 的路由设置中启用 **Protect with Access** / Access 令牌验证，关联对应应用。具体控制台名称可能随版本变化。若使用其他 Tunnel 配置方式，需要在入口处完成等价的 Access JWT 验证。

Tunnel 原生支持 WebSocket。保持 HTTP/WebSocket 模式，不把 KasmVNC 的 UDP / WebRTC 媒体端口误认为已经被此路由转发。

## 4. 配置本地

编辑 `.env`：

```dotenv
PUBLIC_ORIGIN=https://desktop.example.com
ALLOWED_HOSTS=
```

对外域名从 `PUBLIC_ORIGIN` 自动加入白名单。这个地址同时决定 Cookie 的 `Secure` 属性和浏览器请求来源验证，必须与实际浏览器地址一致。

将控制台提供的 Tunnel token 写入 `secrets/tunnel_token`，例如使用本机编辑器。不要写入 Git、README、命令历史或聊天。保持文件权限 `0600`，并确保容器 UID 1000 可以读取。

```bash
chmod 600 secrets/tunnel_token
docker compose --profile cloudflare up -d --build
```

## 5. 验证

1. 用手机蜂窝网络访问域名。
2. 首先看到 Access 验证，再看到工作台登录。
3. 登录后桌面可以连接，并能粘贴中文、使用 Enter。
4. 另一个标签页打开会接管原标签页，原标签页不会不断重连抢回。
5. 锁屏后再回来，桌面里的 tmux 任务继续。

不要直接发布 6901、6902 或 Docker API。Compose 默认只把面板绑定到宿主回环地址。

## 常见问题

- **Host 不在白名单**：检查 `PUBLIC_ORIGIN` 是否与域名、端口一致，修改后重建面板。仅 restart 不会载入修改后的 Compose 环境变量。
- **已登录但一直连接失败**：检查 WebSocket 是否被额外反代拦截，域名是否一致，以及 `docker compose logs --tail=100 panel desktop`。
- **Access 过期**：重新打开入口完成验证。前端不会重新提交之前的输入或按键。
- **桌面未就绪**：先检查 desktop 服务。面板不会为了修复连接而自动重启正在工作的容器。
- **外网只有 HTTPS，而本地 HTTP 登录异常**：HTTPS 部署使用 Secure Cookie，请按 `.env` 配置的入口访问。

来源：[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/)、[Access 保护自托管应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、[WebSocket 支持](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)。
