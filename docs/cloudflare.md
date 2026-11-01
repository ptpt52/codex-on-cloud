# Cloudflare 原生部署

先确保 `http://localhost:36080` 的真实桌面可用。此方案直接运行本机 cloudflared，不使用 Docker、Workers 或自定义中继协议。

## 1. 安装 cloudflared

```bash
npm run native:cloudflared
```

固定版本 `2026.10.0`，从 Cloudflare 官方 GitHub release 下载 Linux x86_64 / ARM64 二进制并校验 SHA-256。安装在项目私有目录，无需 sudo，不自动更新。

## 2. 使用 API 自动创建 Tunnel 与域名

API Token 与 Tunnel 运行 token 是不同的凭据。自动部署使用 API Token，最低需要：账户 Cloudflare Tunnel 编辑、区域 Zone 读取、区域 DNS 编辑；资源范围限制为目标账户和区域。API Token 只从指定文件读取，不保存到项目中。后台运行只使用新 Tunnel 自己的运行 token。

```bash
npm run native:publish -- \
  --domain remote-codex.x-wrt.dev --zone x-wrt.dev --api-token-file /tmp/cf_token
systemctl --user restart codex-cloud-panel.service
npm run native:tunnel
```

此命令创建专用 Tunnel、配置回环上游、添加代理 CNAME，并更新 `.env` 与登录信息中的入口地址。已有无关 DNS 记录或同名 Tunnel 会使脚本停止，不会覆盖它们。部署状态保存在 `data/cloudflare-deployment.json`，原 `.env` 备份在 `data/.env.before-cloudflare`，均被 Git 忽略。

当前工作台使用独立账号和随机强密码保护 HTTP、桌面资源与 WebSocket。Cloudflare Access 可以作为额外的外层身份验证；它不是项目密码登录的替代。以下是手动创建 Tunnel 或添加 Access 的步骤。

## 3. 可选的 Cloudflare Access 与手动 Tunnel

需要外层 Access 时，在 Cloudflare One 中为域名（例如 `desktop.example.com`）创建 Self-hosted Access 应用，只允许自己的身份。入口和 WebSocket 都要经过验证，不要为桌面路径设置 Bypass。通过 API 自动配置这部分还需账户 Access: Apps and Policies 编辑权限，以及明确的允许登录身份。

创建 Tunnel，配置 Published application 路由：

```text
Hostname: desktop.example.com
Service:  HTTP
URL:      127.0.0.1:36080
```

cloudflared 和面板直接运行在同一台 Ubuntu 上，因此使用回环地址。若修改 `PANEL_PORT`，同步修改上游端口。

使用 Access 时，在路由中启用 Protect with Access / Access JWT 验证，关联对应应用。具体控制台名称可能变化；使用配置文件时需配置等价的令牌验证。Tunnel 承载普通 HTTP / WebSocket，无需 VNC 专用端口。

## 4. 手动配置本机并启动

编辑 `.env`：

```dotenv
PUBLIC_ORIGIN=https://desktop.example.com
ALLOWED_HOSTS=
```

公网域名自动加入 Host 白名单。此配置决定 Origin 验证和 Secure Cookie，必须与手机实际访问地址一致。通过本机编辑器把 Tunnel token 写入 `secrets/tunnel_token`，不要复制到 Git、命令历史或聊天。

```bash
chmod 600 secrets/tunnel_token
systemctl --user restart codex-cloud-panel.service
npm run native:tunnel
```

`native:tunnel` 启用用户级 Tunnel 服务，不重启桌面。进程参数只传 token 文件路径。退出登录后仍运行需要执行一次 `sudo loginctl enable-linger "$USER"`。

## 5. 手机验收

1. 使用蜂窝网络访问 HTTPS 域名并登录工作台；如果已启用 Access，先完成外层验证。
2. 确认真正的桌面画面、中文粘贴和独立 Enter 可用。
3. 关闭浏览器后再次打开，原 tmux 任务继续；没有重复提交输入。
4. 另一标签页接管后旧页等待手动接管，不互相抢占。
5. 验证上传下载及 Access 过期后重新验证。

Cloudflare 会终止浏览器 HTTPS；这不是 agent-relay 的应用层端到端加密协议。

## 排查

```bash
systemctl --user status codex-cloud-tunnel.service
journalctl --user -u codex-cloud-tunnel -u codex-cloud-panel -u codex-cloud-desktop -n 100 --no-pager
```

- Host / Origin 错误：检查域名和端口，编辑后重启面板。
- HTTPS 配置后本地 HTTP 不能登录：Secure Cookie 需要通过已配置的 HTTPS 入口访问。
- 桌面未就绪：先排查本机桌面；面板不会因连接失败重启桌面。
- Tunnel 在线但桌面失败：检查 WebSocket 是否被额外反代或 Access 策略拦截。
- Node 路径变化：重新运行 `npm run native:install` 更新服务路径。

## DNS 与 IPv4/IPv6

进程显示 active 不代表 Tunnel 已连接。检查近期日志中的 `Registered tunnel connection`，并通过公网健康接口验证实际链路：

```bash
curl -4 -fsS --max-time 15 https://remote-codex.x-wrt.dev/healthz
curl -6 -fsS --max-time 15 https://remote-codex.x-wrt.dev/healthz
```

本次故障中，本机面板正常，但系统 DNS `127.0.0.53` 查询 `_v2-origintunneld._tcp.argotunnel.com` 超时或失败，Tunnel 无法发现接入节点。IPv4 和 IPv6 浏览器都能到达 Cloudflare，但收到 1033。直接使用公共 DNS 可以正确解析。

在 `.env` 中配置：

```dotenv
TUNNEL_DNS_SERVERS=1.1.1.1,8.8.8.8
TUNNEL_EDGE_IP_VERSION=auto
TUNNEL_PROTOCOL=auto
```

`TUNNEL_DNS_SERVERS` 接受最多三个逗号分隔的 DNS 服务器 IP。启动器使用非特权 user/mount namespace，只为 cloudflared 挂载专用 `resolv.conf`，不修改系统 DNS 或其他进程。专用文件保存在被忽略的 `data/tunnel/resolv.conf`。需要 Linux 允许非特权用户命名空间，以及 `unshare`、`mount`；`native:doctor` 会检查。若系统禁止这种命名空间，可由管理员修复系统 DNS 后移除此选项。

`TUNNEL_EDGE_IP_VERSION` 可设为 `auto`、`4`、`6`，控制 Ubuntu 到 Cloudflare 的出站连接。`TUNNEL_PROTOCOL` 可设为 `auto`、`quic`、`http2`；UDP 7844 不可用时可选择 `http2`。这些选项与手机访问公网域名使用的 IP 协议相互独立，面板仍只需要监听回环地址。

本机采用 **IPv6 优先，连接故障时允许回退 IPv4** 的策略，保留 `TUNNEL_EDGE_IP_VERSION=auto`。`auto` 将系统解析返回的第一种地址族作为主地址族，再使用另一种地址族作为故障备用，因此不能仅凭 `auto` 就认定 IPv6 优先。本机已在 Tunnel 的独立 DNS 环境中确认两个边缘区域均优先返回 IPv6，日志记录的四条连接均为 IPv6，当前连接指标为 4。`6` 会仅使用 IPv6，不保留跨地址族回退；需要双栈故障回退时应保留 `auto` 并核对实际解析顺序。参见 [Cloudflare 运行参数](https://developers.cloudflare.com/tunnel/reference/run-parameters/#edge-ip-version)及本项目固定版本的[地址族选择实现](https://github.com/cloudflare/cloudflared/blob/2026.10.0/edgediscovery/allregions/region.go)。

配置后检查并只重启 Tunnel：

```bash
npm run native:doctor
# 首次更新服务的自动重试配置时运行；不会重启正在运行的服务
npm run native:install
systemctl --user restart codex-cloud-tunnel.service
```

Tunnel 服务使用 `Restart=on-failure`，失败后每 10 秒重试；手动停止后不会自行启动。桌面服务继续保持独立生命周期。

来源：[cloudflared 官方下载](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)、[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/)、[Access 自托管应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。
