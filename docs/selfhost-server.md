# 独立公网服务器部署

本页面向中心服务器部署者。本模式使用一台 Ubuntu 24.04 公网服务器和一个域名，不依赖 Cloudflare。中心服务器提供统一管理页和节点入口，节点继续在自己的机器上运行 Codex、桌面、终端、文件和任务。

本文的 `desk.example.com`、公网 / 私网 IP 和邮箱均为占位示例，部署时替换为自己的配置。

[部署组合](deployment.md) · [节点接入](selfhost-node.md) · [首页与管理操作](selfhost-admin.md)

## 拓扑

```text
浏览器
  | HTTPS / WSS :443
  v
Caddy  https://<domain>
  |- /             -> 公开首页：管理入口和在线节点
  |- /admin/       -> 中心管理服务 127.0.0.1:36180
  `- /node/<slug>/ -> route auth -> frps 127.0.0.1:18080 -> frpc -> 节点 Panel

节点 frpc
  | TLS 主动连接 <domain>:7000
  v
frps

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

## DNS

先将正式域名的 A 记录指向服务器公网 IPv4。安装器会在修改系统前检查 DNS；不一致时直接退出。

```text
<domain>  A  <public-ipv4>
```

## 中心安装

在中心服务器准备本仓库源码，以及 `curl`、`tar`、`sha256sum`，进入仓库根目录后执行。中心脚本会引导固定 Node 运行时；不需要先在中心运行节点的 `npm run deploy`：

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

重复执行同一 `install` 命令会以固定依赖更新中心应用，并保留上一版应用目录。需要回滚时：

```bash
sudo ./scripts/selfhost-server.sh rollback
```

回滚只切回上一版中心应用并重启中心服务；证书、授权状态、节点任务和已有工作区不会被删除。

安装更新由独立锁串行执行。证书切换期间保留已有 HTTPS，签发失败时恢复原配置、应用目录和原服务状态。更新备份仅位于服务器私有的 `/opt/codex-selfhost/update-backup`，最多 32 个配置文件、合计 8 MiB，恢复清单最多 32 KiB；不会备份节点工作区。成功或恢复完成后自动删除备份。若恢复未完成，备份保留并阻止再次安装，排除故障后执行：

```bash
sudo ./scripts/selfhost-server.sh recover
```

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

日志进入 journald。服务以非 root 用户运行；Caddy 仅因监听 80/443 由 systemd 启动。

## 验收

在中心服务器核对系统服务，再从客户端检查 HTTPS：

```sh
sudo ./scripts/selfhost-server.sh status
curl -fsS --max-time 15 https://desk.example.com/healthz
```

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

转发助手从 `0.7.3` 起支持 `https://desk.example.com/node/node-a/`。TCP、串口、反向映射及恢复连接均保留节点前缀，Origin 仍是 `https://desk.example.com`。更新节点后重新运行 `npm run build:forward` 并重新下载助手；构建使用 `.env` 的 `PUBLIC_ORIGIN` 与 `ENTRY_BASE_PATH`，也可显式指定完整节点 URL。旧根地址部署继续兼容。

`0.8.0` 起支持[常驻助手和动态规则](forward.md#常驻助手一个进程多条规则)。key 包含完整节点路径，同一中心的多台节点不会相互覆盖助手归属；网页切换节点后，助手仍连接原授权节点。更新对应节点后台并下载新助手即可，中心仍按原节点路径转发。

## 验证范围

`npm run test:selfhost:edge` 使用真实 Caddy 验证本地 TLS、HTTP-01 路由和 Cookie 过滤；续期 shell 命令使用本地夹具，不访问 systemd 或公共 ACME。`npm run test:turn` 使用真实 coturn 做 UDP、TCP、TLS 强制 relay 数据往返。`npm run test:forward:entry` 编译真实 Go 助手并通过节点路径传输 TCP 数据，桌面管理使用夹具。它们都不替代正式服务器上的 DNS、安全组、公共 CA 签发、FRP 和 Cloudflare 部署检查。
