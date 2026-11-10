# 独立公网服务器部署

本模式只使用一台 Ubuntu 24.04 公网服务器和一个域名，不依赖 Cloudflare。中心服务器提供统一管理页和节点入口，节点继续在自己的机器上运行 Codex、桌面、终端、文件和任务。

## 拓扑

```text
浏览器
  | HTTPS / WSS :443
  v
Caddy  https://<domain>
  |- /             -> 中心管理服务 127.0.0.1:36180
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

安装脚本会校验 Node、Caddy 和 frp 的固定下载摘要，并拒绝覆盖校验不一致的已有二进制。

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

在仓库根目录执行：

```bash
sudo ./scripts/selfhost-server.sh install \
  --domain desk.example.com \
  --public-ip 203.0.113.10 \
  --email ops@example.com
```

默认使用 Certbot HTTP-01。服务器需要能从公网访问 TCP 80 和 TCP 443。

TURN 首版固定使用 IPv4。安装器从默认路由自动识别本机私网 IPv4；云上 NAT 或特殊路由可显式传入：

```bash
--private-ip 172.16.0.10
```

这不关闭浏览器与节点之间的 IPv6 ICE 直连；只有需要 TURN relay 的纯 IPv6 或 IPv6 入站受阻场景不受此首版支持，会回退到 HTTPS/WSS。

也可导入已有 PEM 证书：

```bash
sudo ./scripts/selfhost-server.sh install \
  --domain desk.example.com \
  --public-ip 203.0.113.10 \
  --cert-file /path/to/fullchain.pem \
  --key-file /path/to/privkey.pem
```

导入模式会校验证书域名、证书与私钥是否匹配，不启用 :80 跳转。证书续期由证书来源负责；更新 PEM 后重跑安装命令即可。节点若使用私有 CA，接入时指定 `--ca-file`。

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

查看服务状态：

```bash
./scripts/selfhost-server.sh status
```

重复执行同一 `install` 命令会以固定依赖更新中心应用，并保留上一版应用目录。需要回滚时：

```bash
sudo ./scripts/selfhost-server.sh rollback
```

回滚只切回上一版中心应用并重启中心服务；证书、授权状态、节点任务和已有工作区不会被删除。

私有文件：

```text
/etc/codex-selfhost/admin_password
/etc/codex-selfhost/frp_token
/etc/codex-selfhost/frps_admin_password
/etc/codex-selfhost/turn_secret
```

这些文件不会进入 Git。管理员密码只从 `admin_password` 读取，不输出到安装日志。

## 管理授权

打开：

```text
https://<domain>/
```

中心管理员可以创建绑定固定 slug 的授权：

- 一个 key 只对应一个逻辑节点。
- key 可设置到期时间或无限期。
- key 明文只在创建时显示一次，磁盘只保存 SHA-256 哈希。
- 同一 slug 已有在线连接时，第二接入被拒绝。
- 节点断线后保留 60 秒恢复窗口。
- 撤销 key 后拒绝重连，节点在下一次 5 秒心跳时关闭旧隧道；Caddy route auth 会立即拒绝新请求。
- 中心最多允许 64 个在线节点，不限制业务并发、活跃浏览器或 TURN 会话数量。
- 仅当 frps 异常退出遗漏 `CloseProxy` 时，中心会在新 `Login` 中核对回环 frps Admin API；旧代理已消失则允许 recovery，仍在线则继续拒绝重复接入。

中心只信任回环 Caddy 写入的 `X-Forwarded-For` 客户端地址；管理员登录、节点接入和 TURN 刷新分别按客户端限流，不会互相消耗或让一个外部地址锁住其他管理员。

## 节点接入

节点必须已经按现有方式完成本机 Panel 部署。在节点仓库根目录执行：

```bash
npm run server:join
```

命令会交互读取中心地址、slug 和隐藏输入的授权 key。key 不接受普通命令行参数，也不会写入磁盘。

首次接入后，节点保存专用 credential，生成 `frpc.toml` 和独立 systemd user 服务。SSH 退出后中继仍运行；建议确保已启用：

```bash
sudo loginctl enable-linger <user>
```

已有 Cloudflare/Gateway 发布状态时，`server:join` 默认拒绝自动接管。明确需要切换时使用：

```bash
npm run server:join -- \
  --server https://desk.example.com \
  --slug node-a \
  --switch-existing
```

接入前会备份 `.env`、节点登录说明和 `gateway-node.json`。`server:leave` 会停止中继、释放中心路径并恢复原 Panel 配置，不会删除工作区、任务、桌面或 Codex 登录。

`server:leave` 先确认 frpc 已停止，再释放中心租约并恢复 Panel；停止或恢复失败时保留接入配置与备份，修复问题后可直接重试。中心网络不可达时会明确警告，并在本地中继确认停止后完成离线清理。

诊断与退出：

```bash
npm run server:status
npm run server:doctor
npm run server:leave
```

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
- 中心状态最多 512 个授权和 512 条有界审计记录，单个状态文件最多 256 KiB

日志进入 journald。服务以非 root 用户运行；Caddy 仅因监听 80/443 由 systemd 启动。

## 验收

```bash
npm run check
npm test
npm run test:desktop
npm run test:browser
```

真实部署还应验证：

1. HTTP-01 或导入证书能完成 HTTPS/WSS。
2. 两个不同 slug 的节点同时在线且路径、Cookie、草稿和 Service Worker 隔离。
3. 同一 slug 的第二接入被拒绝。
4. 撤销 key 后新请求立即失败，旧 WebSocket 在心跳周期内关闭。
5. TURN UDP、TCP、TLS 和仅 relay 路径可用。
6. 重启 center、frps 或 caddy 后节点自动恢复，任务不重启。
