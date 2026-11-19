# 独立公网服务器部署

本页面向中心服务器部署者。本模式使用一台 Ubuntu 24.04 公网服务器和一个域名，不依赖 Cloudflare。中心服务器提供统一管理页和节点入口，节点继续在自己的机器上运行 Codex、桌面、终端、文件和任务。

本文的 `desk.example.com`、公网 / 私网 IP 和邮箱均为占位示例，部署时替换为自己的配置。

[部署组合](deployment.md) · [节点接入](selfhost-node.md) · [首页与管理操作](selfhost-admin.md)

## 先确认安装角色与证书

| 当前情况 | 操作 |
| --- | --- |
| 只把自己的电脑接入已有中心 | 直接阅读[节点接入](selfhost-node.md)，不在节点运行中心安装脚本 |
| 新建统一入口服务器 | 依次核对[拓扑](#拓扑)、[端口](#端口)、[DNS](#dns)，再执行[中心安装](#中心安装) |
| 使用自动签发证书 | 安装时提供域名、公网 IP、邮箱，开放 TCP 80 / 443；Certbot 负责续期 |
| 已有域名证书与私钥 | 使用 `--cert-file` 与 `--key-file` 导入 PEM 内容；后续自行续期并重新安装加载 |
| 更新已有中心 | 沿用原安装参数；[安装与恢复](#中心安装)和[中心管理](selfhost-admin.md)分别维护服务与授权 |

中心域名统一提供 HTTPS；节点不需要单独的域名证书。证书链、私钥与 CA 公共证书的用途及导入示例见下文。

## 拓扑

```text
浏览器
  | HTTPS / WSS :443
  v
Caddy  https://<domain>
  |- /             -> 公开首页：管理入口和在线节点
  |- /admin/       -> 中心管理服务 127.0.0.1:36180
  `- /node/<slug>/ -> route auth 127.0.0.1:36181 -> frps 127.0.0.1:18080 -> frpc -> 节点 Panel

节点 frpc
  | TLS 主动连接 <domain>:7000
  v
frps
  `- Login / Ping / NewProxy / CloseProxy -> 中心内部接口 127.0.0.1:36181

浏览器 <-> coturn :3478 / :5349 / UDP 49160-49223 <-> 节点
```

中心服务器不保存工作区、终端输出、文件内容、Codex 凭据或节点面板密码。

## 固定依赖

- Node.js `24.22.2`
- Caddy `2.6.2`，Ubuntu 24.04 固定包 `2.6.2-6ubuntu0.24.04.3`
- frp `0.72.0`
- coturn `4.6.1-1build4`
- Certbot `2.9.0-1`
- Ubuntu 24.04 LTS 和 systemd
- 不使用 Docker

安装脚本会校验 Node 和 frp 的固定下载摘要，并检查 Caddy 固定版本，并拒绝覆盖校验不一致的已有二进制。

如果服务器无法访问 GitHub Release，可先在本机准备同版本 `frps`，通过 `--frps-file` 导入；导入文件仍会校验固定 SHA-256。Caddy 默认从 Ubuntu 仓库安装固定版本，也可用 `--caddy-file` 导入同版本二进制。

## 端口

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 443 | TCP | HTTPS、HTTP/2、WSS 和 WebSocket |
| 7000 | TCP | frpc TLS 反向隧道 |
| 3478 | TCP/UDP | STUN/TURN |
| 5349 | TCP | TURN over TLS |
| 49160-49223 | UDP | TURN relay |
| 80 | TCP | HTTP-01 和跳转 HTTPS；导入证书模式可关闭 |
| 22 | TCP | SSH；应只允许 VPN、堡垒机或固定运维网段 |

云服务器安全组必须单独放行以上端口。安装器默认只生成 UFW 配置建议，不修改防火墙。只有在同时指定 `--configure-ufw` 和 `--ssh-cidr` 时才配置 UFW，避免锁死 SSH。

中心公共服务 `36180` 与内部回调 `36181`、frps HTTP 中转 `18080`、frps 管理 `17500` 均只监听回环地址，不向公网放行。公共连接最多 224 个，内部连接最多 32 个；Caddy 路由授权的活动和空闲连接合计最多 16 个，并发授权达到 16 项时拒绝额外请求，响应头等待最多 2 秒。中心另将未结束的路由授权限制为 16 项，为 frps 回调保留容量。公共慢请求头不能占用内部监听的容量，公共端口也不提供 `/internal/*` 接口。

## DNS

先将正式域名的 A 记录指向服务器公网 IPv4。安装器会在修改系统前检查 DNS；不一致时直接退出。

```text
<domain>  A  <public-ipv4>
```

若域名使用 Cloudflare 托管 DNS，此 A 记录应设为“仅 DNS”，不要开启橙云代理；安装器必须能查到 `--public-ip`，frpc 的 7000 端口和 TURN 也需要直达中心。已有 AAAA 记录时另核对该 IPv6 地址的 HTTPS 可达性，避免部分客户端走到错误地址。

## 中心安装

使用专门承载中心的 Ubuntu 24.04 服务器。安装器会管理 `/opt/codex-selfhost`、`/etc/codex-selfhost` 和对应系统服务，并停用发行版的 `caddy.service`、`coturn.service`，改用 `codex-selfhost-*` 服务。已有网站或 TURN 的主机先安排迁移，不直接接管原服务。

首次准备基础工具及源码：

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  git ca-certificates curl tar xz-utils util-linux python3 iproute2 openssl
git clone https://github.com/ptpt52/codex-on-cloud.git
cd codex-on-cloud
```

已有源码时进入原目录，不重复克隆。`flock`、`prlimit` 来自 util-linux，Python 用于安装锁，`ip` 用于识别 TURN 本机地址；它们必须在安装开始前可用。中心脚本会引导固定 Node 运行时；不需要在中心先安装节点的 npm 依赖或运行 `npm run deploy`。保留中心源码仓库供后续更新、回滚和验收，从仓库根目录执行：

```bash
sudo ./scripts/selfhost-server.sh install \
  --domain desk.example.com \
  --public-ip 203.0.113.10 \
  --email ops@example.com
```

默认使用 Certbot HTTP-01。服务器需要能从公网访问 TCP 80 和 TCP 443。

TURN 首版固定使用 IPv4。安装器从默认路由自动识别本机私网 IPv4；云上 NAT 或特殊路由可显式传入：

在完整 `install` 命令后增加 `--private-ip 172.16.0.10`。

这不关闭浏览器与节点之间的 IPv6 ICE 直连；只有需要 TURN relay 的纯 IPv6 或 IPv6 入站受阻场景不受此首版支持，会回退到 HTTPS/WSS。

也可导入已有证书链和对应私钥。文件扩展名不限，内容必须是 PEM 格式；例如 `server.crt` 是域名证书及中间证书链，`server.pem` 是对应私钥：

```bash
sudo ./scripts/selfhost-server.sh install \
  --domain desk.example.com \
  --public-ip 203.0.113.10 \
  --cert-file /path/to/server.crt \
  --key-file /path/to/server.pem
```

导入模式在修改正式配置前校验证书域名、有效期、逐级签名、CA 约束及证书与私钥是否匹配，不启用 :80 跳转。证书文件按“叶证书 → 中间证书”排列，公网 CA 的根证书可由系统信任库补齐；私有 CA 需把根证书一并放在链末尾。单独自签名证书仍可导入。证书续期由证书来源负责；更新 PEM 后重跑安装命令即可。节点若使用私有 CA，接入时指定 `--ca-file`。

安装和回滚时，HTTPS 健康检测验证中心域名、有效期及实际提供的证书是否与已安装证书一致；导入私有证书时仅为该次检测显式信任所提供证书链，不修改系统信任库。

节点不需要各自申请域名 SSL 证书。浏览器访问的是中心域名，由中心 Caddy 提供证书；节点 Panel 只监听回环，frpc 主动建立 TLS 隧道。中心使用公共 CA 时，节点使用系统信任库，无需 `--ca-file`。

私有 CA 的 `--ca-file` 接入方式见[节点文档](selfhost-node.md#私有-ca)。CA 公共证书与服务器私钥用途不同，不要把服务器私钥复制到节点。

自动签发模式持续从 `/.well-known/acme-challenge/` 提供 HTTP-01 验证。首次签发只复制证书，写入最终配置后才启用完整服务；续期 hook 显式重启 frps、Caddy 和 coturn。Caddy 保持 `admin off`，不支持 `systemctl reload`。更新证书会短暂断开网络连接，节点桌面、终端后台和任务继续运行。

可选 UFW：

下面选项只自动放行所填来源到 **TCP 22** 的 SSH。使用其他 SSH 端口时先自行配置并验证防火墙，不直接套用该选项；云安全组仍需单独配置。

```bash
sudo ./scripts/selfhost-server.sh install \
  --domain desk.example.com \
  --public-ip 203.0.113.10 \
  --email ops@example.com \
  --configure-ufw \
  --ssh-cidr 198.51.100.0/24
```

可选限制管理页来源，同时保持 `/node/<slug>/` 对所有节点用户开放：

```bash
sudo ./scripts/selfhost-server.sh install \
  --domain desk.example.com \
  --public-ip 203.0.113.10 \
  --email ops@example.com \
  --admin-cidr 198.51.100.0/24,192.0.2.10/32
```

管理白名单会保存到 `/etc/codex-selfhost/server-settings.json`。后续更新、证书重配或重复安装未传 `--admin-cidr` 时继续沿用；只有显式传入 `--admin-cidr none` 才清空白名单。

查看服务状态：

```bash
sudo ./scripts/selfhost-server.sh status
```

重复执行同一 `install` 命令会以固定依赖更新中心应用，并保留上一版应用目录。

旧配置未设置 `SELFHOST_INTERNAL_PORT` 时，更新应用仍保留原共享监听，避免已有 Caddy/frps 地址失配。完整重跑原 `install` 命令会配套生成 `SELFHOST_INTERNAL_PORT=36181`、Caddy 路由授权地址和 frps 插件地址，并验收内部监听；不单独修改其中一个文件。已有授权、凭据和节点路径沿用原状态。路由授权的 Caddy 连接上限与超时也通过完整 `install` 更新；只替换中心应用不会更新代理配置，不能据此认定回调容量隔离已生效。

需要回滚时：

```bash
sudo ./scripts/selfhost-server.sh rollback
```

回滚切回上一版中心应用并重启中心及 frps 服务，使用与安装相同的有界事务机制，但不备份或恢复证书、配置文件，也不停止或重启 Caddy、TURN，保留同期的证书续期和配置修改。目录切换、服务启动或健康检查失败时恢复回滚前的版本；进程中断或恢复失败时保留记录，运行下文的 `recover` 按记录的应用范围恢复，不重复执行版本切换。授权状态、节点任务和已有工作区不会被删除。完整安装失败的恢复仍按原记录恢复全部配置与服务。

已启用独立内部监听时，若上一版应用不支持此配置，`rollback` 会在切换和重启前拒绝。确需回到旧版时，在单独的旧版源码检出目录运行原完整 `install` 命令，使应用、`server.env`、Caddyfile 与 frps.toml 配套恢复；保留当前源码和配置供故障恢复，不仅交换应用目录。

安装更新由独立锁串行执行。证书切换期间保留已有 HTTPS，签发失败时恢复原配置、应用目录和原服务状态。更新备份仅位于服务器私有的 `/opt/codex-selfhost/update-backup`，最多 32 个配置文件、合计 8 MiB，恢复清单最多 32 KiB；不会备份节点工作区。成功或恢复完成后自动删除备份。若恢复未完成，备份保留并阻止再次安装，排除故障后执行：

```bash
sudo ./scripts/selfhost-server.sh recover
```

运行时引导另用一把内核锁，重复调用不会同时下载。下载连接超时 15 秒、每次最多 300 秒，最多尝试 3 次，归档由 curl 和内核共同限制为 128 MiB；仅提取固定版本的 Node 可执行文件，限制为 256 MiB。校验 SHA-256、版本后原子发布，单个暂存目录在失败退出时清理，进程被强制终止后由下次安装清理。`status`、`rollback`、`recover` 只使用已就绪的固定版本运行时（可复用正式安装的二进制），不会下载或升级依赖。

私有文件：

```text
/etc/codex-selfhost/admin_password
/etc/codex-selfhost/frp_token
/etc/codex-selfhost/frps_admin_password
/etc/codex-selfhost/turn_secret
```

这些文件不会进入 Git。管理员密码只从 `admin_password` 读取，不输出到安装日志。

## 首页与管理授权

首页 `https://desk.example.com/` 公开展示在线节点和管理入口，`/admin/` 使用独立管理员登录，各节点通过 `/node/<slug>/` 访问。创建授权、重新授权、撤销、登录标识和同源信任边界见[中心管理](selfhost-admin.md)。

## 自定义帮助页

可为本次部署准备一个 UTF-8 HTML 文件，安装时增加 `--help-file /path/to/help.html`。安装器会将其复制到 `/etc/codex-selfhost/help.html`（root 所有、组 codex-selfhost、0640），首页自动显示“使用帮助”，公开地址为 `https://<domain>/help/`。帮助页应包含返回首页的链接 `<a href="/">返回首页</a>`。

文件独立于应用目录，重复安装时省略 `--help-file` 会保留现有帮助页。也可单独更新，无需重新安装其他服务：

```bash
sudo install -o root -g codex-selfhost -m 0640 /path/to/help.html /etc/codex-selfhost/help.html
sudo systemctl restart codex-selfhost-center.service
```

未配置该文件时不显示帮助入口，`/help/` 返回 404。删除文件并重启中心服务可停用。文件在中心启动时加载，必须是非空普通文件、非符号链接、不可由组或其他用户写入，最多 512 KiB；无效文件会使启动失败并报告错误。

帮助页无需登录，不得包含真实密钥、密码或内部工作区内容；部署专用教程放在仓库外，不提交 Git。支持自包含 HTML、内嵌 CSS、data 图片和普通链接；独立 CSP 沙箱禁止脚本、表单、外部资源和嵌入框架，不放宽首页或管理页的安全策略。

## 节点接入

在节点自己的机器以普通用户完成本机部署，再按[节点接入与恢复](selfhost-node.md)领取 key、运行 `server:join`。需要端口映射助手时，接入完成后再按最终路径构建。

中心安装使用 sudo；节点的 npm 命令使用普通用户。节点无需单独域名或 SSL 证书，也不需要 Cloudflare 账户或 Token。

## TURN

中心管理服务只为已在线节点签发短期 TURN 凭据，最长 1 小时：

- `turn:<domain>:3478?transport=udp`
- `turn:<domain>:3478?transport=tcp`
- `turns:<domain>:5349?transport=tcp`

节点 key 撤销、管理员断开或节点离线后不再续签。coturn 拒绝环回、私网、链路本地、多播和保留地址作为 peer。WebRTC 失败时现有 WSS 中转仍保持独立可用。

## systemd 资源边界

- 中心：`MemoryMax=768M`、`TasksMax=256`、`LimitNOFILE=8192`
- frps：`MemoryMax=512M`、`TasksMax=1024`、`LimitNOFILE=65536`
- coturn：`MemoryMax=512M`、`TasksMax=2048`、`LimitNOFILE=65536`
- Caddy：`MemoryMax=512M`、`TasksMax=1024`、`LimitNOFILE=65536`
- 中心不设固定授权记录数量上限；单个状态文件最多 256 KiB。最多保留 512 条审计记录，容量紧张时优先裁剪旧审计并为撤销授权预留空间；不足时拒绝新增或扩展记录，不截断现有授权
- 配置写入与等待合计最多 32 项，其中 4 项为撤销、断开和清理保留；超额返回 503，不自动重试。节点接入和退出先校验凭据，取消后尚未执行的请求跳过处理，落盘前再次校验。此边界不限制节点数量或业务连接数

日志进入 journald。中心和 frps 使用 `codex-selfhost` 用户，coturn 使用 `turnserver`；当前 Caddy 系统 unit 使用 root，并启用 `NoNewPrivileges`、`PrivateTmp`、`ProtectSystem` 等限制。中心安装命令使用 sudo，不等于在节点上以 root 运行工作台。

## 验收

在保留的中心源码仓库运行[中心自动验收命令](deployment-verification.md#自建中心)，检查独立内部监听、实际 HTTPS、首页、管理子路径和公开节点列表；普通节点模式与中心模式分别报告。需要单项定位时使用以下命令：

在中心服务器核对系统服务，再从客户端检查 HTTPS：

```sh
sudo ./scripts/selfhost-server.sh status
curl -fsS --max-time 15 https://desk.example.com/healthz
# 在中心主机执行；自定义端口时使用 server.env 中的 SELFHOST_INTERNAL_PORT
curl -fsS --max-time 3 http://127.0.0.1:36181/internal/healthz
```

独立内部监听应返回 `ok: true` 和 `isolated: true`。旧共享配置在自动验收中提示待迁移，不能将它当作已经实现慢请求头隔离；按原安装参数完整升级后再次验收。

同时核对已部署的 Caddy 路由授权配置包含 `max_conns_per_host 16`、`unhealthy_request_count 16`、`max_fails 1` 和 `response_header_timeout 2s`。内部健康页不能证明这些代理限制已经更新；并发容量和超时的开发回归由 `npm run test:selfhost:edge` 使用真实 Caddy、隔离中心与模拟存储等待验证，不向生产节点注入故障。

在已接入节点的完整路径检查工作台就绪状态：

```sh
curl -fsS --max-time 15 https://desk.example.com/node/node-a/readyz
```

后者应返回 `ok`、`host`、`files` 均为 true，并包含对应节点身份。再完成以下部署验收；开发测试另见[验证方法](verification.md)。

1. HTTP-01 或导入证书能完成 HTTPS/WSS。
2. 两个不同 slug 的节点同时在线且路径、Cookie、草稿和 Service Worker 隔离。
3. 同一 slug 的第二接入被拒绝。
4. 撤销 key 后新请求立即失败，旧 WebSocket 在心跳周期内关闭。
5. TURN UDP、TCP、TLS 和仅 relay 路径可用。
6. 重启 center、frps 或 caddy 后节点自动恢复，任务不重启。

## TURN 与转发助手

中心通过 HTTPS 返回短期 TURN 凭据及固定公网 IPv4、UDP relay 端口范围。节点只在该地址范围内接收公网 IPv4 relay 候选；SDP、候选对和收包检查使用同一规则，ICE 消息完整性及 DTLS 校验保持启用。既有私网 IPv4、公网 IPv6 直连和 HTTPS/WSS 回退继续可用。TURN 控制连接支持 UDP、TCP 和 TLS；relay 对端流量使用 UDP。

当前 `0.9.0` 转发助手支持 `https://desk.example.com/node/node-a/`。TCP、串口、反向映射及恢复连接均保留节点前缀，Origin 仍是 `https://desk.example.com`。更新节点后重新运行 `npm run build:forward` 并重新下载助手；构建使用 `.env` 的 `PUBLIC_ORIGIN` 与 `ENTRY_BASE_PATH`，也可显式指定完整节点 URL。也支持根路径入口。

本版使用[固定八个助手和动态规则](forward.md#部署与启动)。key 包含完整节点路径，同一中心的多台节点不会相互覆盖助手归属；网页切换节点后，助手仍连接原授权节点。更新对应节点后台并下载新助手即可，中心仍按原节点路径转发。

## 验证范围

`npm run test:selfhost:edge` 使用真实 Caddy 验证本地 TLS、HTTP-01 路由和 Cookie 过滤；续期 shell 命令使用本地夹具，不访问 systemd 或公共 ACME。`npm run test:turn` 使用真实 coturn 做 UDP、TCP、TLS 强制 relay 数据往返。`npm run test:forward:entry` 编译真实 Go 助手并通过节点路径传输 TCP 数据，桌面管理使用夹具。它们都不替代正式服务器上的 DNS、安全组、公共 CA 签发、FRP 和 Cloudflare 部署检查。

[文档目录](README.md) · [部署选择](deployment.md) · [维护排障](operations.md)
