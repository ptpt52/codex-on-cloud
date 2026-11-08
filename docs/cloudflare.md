# Cloudflare 原生部署

先确保 `http://localhost:36080` 的真实桌面可用。节点直接运行本机 cloudflared，不使用 Docker 或自定义中继协议；可选的[统一门户](portal.md)单独部署为 Worker，节点流量仍通过自己的 Tunnel。

## 1. 安装 cloudflared

```bash
npm run native:cloudflared
```

固定版本 `2026.10.0`，从 Cloudflare 官方 GitHub release 下载 Linux x86_64 / ARM64 二进制并校验 SHA-256。安装在项目私有目录，无需 sudo，不自动更新。

## 2. 使用 API 自动创建 Tunnel 与域名

API Token 与 Tunnel 运行 token 是不同的凭据。自动部署使用 API Token，最低需要：账户 Cloudflare Tunnel 编辑、区域 Zone 读取、区域 DNS 编辑；资源范围限制为目标账户和区域。API Token 只从指定文件读取，不保存到项目中。后台运行只使用新 Tunnel 自己的运行 token。

```bash
npm run native:publish -- \
  --domain home-codex.x-wrt.dev --zone x-wrt.dev --api-token-file /tmp/cf_token
systemctl --user restart codex-cloud-panel.service
npm run native:tunnel
```

此命令创建专用 Tunnel、配置私有 Unix socket 上游、添加代理 CNAME，并更新 `.env` 与登录信息中的入口地址。已有无关 DNS 记录或同名 Tunnel 会使脚本停止，不会覆盖它们。部署状态保存在 `data/cloudflare-deployment.json`，原 `.env` 备份在 `data/.env.before-cloudflare`，均被 Git 忽略。

当前工作台使用独立账号和随机强密码保护 HTTP、桌面资源与 WebSocket。Cloudflare Access 可以作为额外的外层身份验证；它不是项目密码登录的替代。以下是手动创建 Tunnel 或添加 Access 的步骤。

## 3. 可选的 Cloudflare Access 与手动 Tunnel

需要外层 Access 时，在 Cloudflare One 中为域名（例如 `desktop.example.com`）创建 Self-hosted Access 应用，只允许自己的身份。入口和 WebSocket 都要经过验证，不要为桌面路径设置 Bypass。通过 API 自动配置这部分还需账户 Access: Apps and Policies 编辑权限，以及明确的允许登录身份。

推荐由 `native:publish` 配置路由，或通过 Tunnel API/本机配置文件指定同一节点的私有接口（实际路径由 `RUNTIME_DIR` 决定）：

```yaml
ingress:
  - hostname: desktop.example.com
    service: unix:/run/user/1000/codex-on-cloud/tunnel.sock
  - service: http_status:404
```

不要照抄示例 UID；默认 socket 为 `$XDG_RUNTIME_DIR/codex-on-cloud/tunnel.sock`，没有该环境变量时使用项目 `data/runtime/codex-on-cloud/tunnel.sock`。面板启动时创建0700目录下的0600 socket，只允许相同部署用户访问；重复启动拒绝接管活动 socket，崩溃残留会安全回收。普通回环 TCP 接口继续提供本机访问、内部服务和直连通道，所有 HTTP/WebSocket 的 Host、Origin、登录与 CSRF 检查保持一致。

Cloudflare 私有入口按有效的 `CF-Connecting-IP`（仅当该地址为 Class E Pseudo IPv4 时使用真实 `CF-Connecting-IPv6`）分别限制登录和解锁尝试。普通 TCP 入口始终忽略这些头及 `X-Forwarded-For`，防止任意客户端换一个请求头绕过限制。缺失或无效边缘地址共用固定限流桶；并发验密仍全局最多2条，失败记录最多1024条。

已有 Tunnel 的 `http://127.0.0.1:36080` 上游继续兼容，但所有公网设备仍共用回环来源限流桶。更新面板后，重新执行原 `native:publish` 命令，或在 Tunnel 配置中改为上述 `unix:` 上游，才会启用独立来源计数。无需改 DNS、重建 Tunnel 或重启任务宿主。保持面板先就绪再切换；不要把用户可控的代理接到可信私有接口。

Cloudflare 官方说明：[Unix socket 上游](https://developers.cloudflare.com/tunnel/concepts/routing/)、[CF-Connecting-IP 与 IPv6 请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/)。

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
curl -4 -fsS --max-time 15 https://home-codex.x-wrt.dev/healthz
curl -6 -fsS --max-time 15 https://home-codex.x-wrt.dev/healthz
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

## 网页连接诊断

工作台顶部的“连接状态”会汇总实际画面分辨率、Tunnel 活动连接数和 IPv6 / IPv4 数量。诊断读取固定版本 cloudflared 的 `/diag/tunnel`，仅统计活动连接；没有活动连接时显示 0，读取失败则显示不可用。[固定版本接口实现](https://github.com/cloudflare/cloudflared/blob/2026.10.0/diagnostic/handlers.go)

cloudflared 的指标/诊断服务默认固定绑定 `127.0.0.1:36903`，可以在 `.env` 中设置 `TUNNEL_METRICS_PORT`。原始服务保持本机可见，不添加 Tunnel 公网路由。面板仅在登录后提供白名单汇总字段，不提供原始数据代理；不要将诊断端口直接暴露到公网。

从旧版随机指标端口升级，或修改 `TUNNEL_METRICS_PORT` 后，重启以下两个服务即可：

```bash
systemctl --user restart codex-cloud-panel.service codex-cloud-tunnel.service
```

来源：[cloudflared 官方下载](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)、[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/)、[Access 自托管应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

## 修改本项目节点域名

已有部署修改为 `home-codex.x-wrt.dev` 时，显式使用 `--rename`，沿用本项目记录的 Tunnel，不创建共享副本：

```sh
npm run native:publish -- --domain home-codex.x-wrt.dev --zone x-wrt.dev \
  --api-token-file /path/to/cf_token --rename
systemctl --user restart codex-cloud-panel.service
npm run native:tunnel
```

只允许在原账户和区域内修改；目标域名有无关 DNS 记录、Tunnel 有无关域名路由时拒绝覆盖。成功后仅清理本项目状态记录且仍匹配原 Tunnel 的旧 CNAME，不保留旧入口兼容。中途失败可用同一目标域名重复执行以完成操作，不能在待完成状态再改第三个域名。

修改后需要通过新域名登录，助手使用新地址重新配对。面板重启会结束内存中的映射，桌面和 Codex 任务继续。完成域名设置后，可在“工具 → 门户接入”注册到[统一门户](portal.md)。
