# 独立公网服务器部署

本模式只使用一台 Ubuntu 24.04 公网服务器和一个域名，不依赖 Cloudflare。中心服务器提供统一管理页和节点入口，节点继续在自己的机器上运行 Codex、桌面、终端、文件和任务。

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

也可导入已有证书链和对应私钥。文件扩展名不限，内容必须是 PEM 格式；例如 `server.crt` 是域名证书及中间证书链，`server.pem` 是对应私钥：

```bash
sudo ./scripts/selfhost-server.sh install \
  --domain desk.example.com \
  --public-ip 203.0.113.10 \
  --cert-file /path/to/server.crt \
  --key-file /path/to/server.pem
```

导入模式在修改正式配置前校验证书域名、整条所提供证书链的有效期及证书与私钥是否匹配，不启用 :80 跳转。证书续期由证书来源负责；更新 PEM 后重跑安装命令即可。节点若使用私有 CA，接入时指定 `--ca-file`。

安装和回滚时，HTTPS 健康检测验证中心域名、有效期及实际提供的证书是否与已安装证书一致；导入私有证书时仅为该次检测显式信任所提供证书链，不修改系统信任库。

节点不需要各自申请域名 SSL 证书。浏览器访问的是中心域名，由中心 Caddy 提供证书；节点 Panel 只监听回环，frpc 主动建立 TLS 隧道。中心使用公共 CA 时，节点使用系统信任库，无需 `--ca-file`。

私有 CA 接入示例：

```bash
npm run server:join -- --server https://desk.example.com --slug node-a --ca-file /path/to/center-ca.pem
```

`--ca-file` 是签发中心证书的 CA 公共证书，不是节点证书或服务器私钥。首次接入、退出、恢复、健康检查和 TURN 请求都使用该中心的 CA，并保留证书链、有效期和 URL 域名验证。切换中心时不会沿用旧中心的 CA；如新中心也使用私有 CA，应重新传入。重复接入同一中心可沿用已保存的 CA。

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

## 首页与管理授权

访问 `https://<domain>/` 无需登录，可查看在线节点并进入 `/node/<slug>/`。首页只公开节点名称、类型和访问路径，每 15 秒刷新；接入中、断线恢复、离线、过期、已撤销和心跳超时的节点不显示。进入节点后仍需使用该节点账号登录，节点登录和权限规则不变。

首页顶部提供“进入管理页面”入口，管理员也可直接打开：

```text
https://<domain>/admin/
```

同域名下，登录页会自动预填独立的登录标识，便于浏览器分别保存密码：

| 入口 | 默认登录标识 |
| --- | --- |
| `/admin/` 管理中心 | `admin@center` |
| `/node/a/` | `admin@node-a` |
| `/node/b/` | `admin@node-b` |

密码仍使用各入口原来的密码，原用户名 `admin` 也继续有效。自定义 `ADMIN_USER=operator` 的节点会预填 `operator@node-a`；临时账号可使用 `visitor@node-a`，仍保留临时权限。标识绑定固定路径，节点改名或重新授权不会改变它。

想让浏览器分别记住密码，请保留预填登录名后保存。之前统一保存在 `admin` 下的记录需要手动修改或重新保存；网站无法替你迁移浏览器里的密码。浏览器仍可能列出同站点的其他账号，这不是域名级隔离，也不改变各节点的独立认证。

中心管理员可以创建绑定固定 slug 的授权：

- 一个 key 只对应一个逻辑节点。
- key 可设置到期时间或无限期。
- key 明文只在创建或重新授权时显示一次，磁盘只保存 SHA-256 哈希。
- 同一 slug 已有在线连接时，第二接入被拒绝。
- 节点断线后保留 60 秒恢复窗口。
- 撤销 key 后拒绝重连，节点在下一次 5 秒心跳时关闭旧隧道；Caddy route auth 会立即拒绝新请求。
- 中心不设置固定节点数量上限，也不限制业务并发、活跃浏览器或 TURN 会话数量；实际规模取决于服务器资源与状态文件容量。
- 仅当 frps 异常退出遗漏 `CloseProxy` 时，中心会在新 `Login` 中核对回环 frps Admin API；旧代理已消失则允许 recovery，仍在线则继续拒绝重复接入。
- 节点代理只允许绑定中心本身的一个域名和 `/node/<slug>/` 的一个 location；额外子域名、HTTP Basic 凭据、Host 重写或注入的请求/响应头都会拒绝接入，防止同一代理越过自己的节点路径。

管理列表支持搜索名称 / 路径、按连接状态筛选，在线节点优先显示；默认隐藏已过期 / 已撤销记录，可在“全部（含历史）”或历史筛选中查看。电脑、平板和手机均在同一节点卡片提供“进入节点”“复制地址”和“更多”。

“更多”中的操作：

| 操作 | 作用 |
| --- | --- |
| 查看详情 | 查看来源、连接模式、创建时间和最近活动 |
| 修改名称 / 有效期 | 保持固定路径；默认保留当前期限，修改已撤销记录不会恢复授权 |
| 重新授权 | 保留节点 ID 和路径，生成新 key，旧 key 和节点凭据立即失效，现有隧道关闭；适用于 key 遗失、过期或撤销后恢复接入 |
| 断开连接 | 关闭当前隧道，保留授权；客户端可能自动重连 |
| 撤销授权 | 使 key 和节点凭据失效，拒绝重连；以后可在原记录重新授权 |

重新授权和撤销会立即阻止新请求，已有隧道在下一次心跳（约 5 秒）关闭；断开连接也通过下一次心跳生效。以上操作不会停止节点上的终端、桌面和任务。重新授权后，需要在目标节点按下文命令重新接入。节点卡片上的地址保持不变，不能再用同一 slug 创建另一条记录。

管理页每 5 秒读取状态，弹窗操作、展开“更多”或页面在后台时暂停自动读取；普通刷新保留列表焦点。在线统计只计入代理已上线且心跳有效的节点，“接入中”和“断线恢复”单独统计。TURN 的“已配置”只说明配置存在，不表示网络检测通过。

有限期授权必须选择未来时间。管理操作失败时在当前弹窗显示原因；遇到网络中断、服务器错误或记录冲突，先“刷新核对列表”，再决定下一步，页面不会自动重发写操作。若创建已成功但 key 响应丢失，可在原记录重新授权取得新 key。

管理页和管理员 API 位于 `/admin/`，管理员 Cookie 也限制在该路径。升级后旧根路径管理员会话失效，需要重新登录；Caddy 转发节点请求时会剔除新旧管理员 Cookie。`--admin-cidr` 只限制 `/admin/`，公开首页和在线列表不受管理白名单限制；节点接入、退出和 TURN 机器接口保持独立凭据认证。匿名在线列表接口为 `GET /api/public/nodes`，返回全部在线节点，不返回凭据、授权 ID、地址或审计信息，并独立按客户端限流。

所有节点和管理页仍在同一浏览器源，必须由同一管理员控制、相互信任。Cookie 路径和转发过滤只能减少凭据外泄，不能隔离恶意节点的同源脚本。不要把不受信任的第三方节点接入同一域名。

中心只信任回环 Caddy 写入的 `X-Forwarded-For` 客户端地址；管理员登录、节点接入和 TURN 刷新分别按客户端限流，不会互相消耗或让一个外部地址锁住其他管理员。

### 自定义帮助页

可为本次部署准备一个 UTF-8 HTML 文件，安装时增加 `--help-file /path/to/help.html`。安装器会将其复制到 `/etc/codex-selfhost/help.html`（root 所有、组 codex-selfhost、0640），首页自动显示“使用帮助”，公开地址为 `https://<domain>/help/`。帮助页应包含返回首页的链接 `<a href="/">返回首页</a>`。

文件独立于应用目录，重复安装时省略 `--help-file` 会保留现有帮助页。也可单独更新，无需重新安装其他服务：

```bash
sudo install -o root -g codex-selfhost -m 0640 /path/to/help.html /etc/codex-selfhost/help.html
sudo systemctl restart codex-selfhost-center.service
```

未配置该文件时不显示帮助入口，`/help/` 返回 404。删除文件并重启中心服务可停用。文件在中心启动时加载，必须是非空普通文件、非符号链接、不可由组或其他用户写入，最多 512 KiB；无效文件会使启动失败并报告错误。

帮助页无需登录，不得包含真实密钥、密码或内部工作区内容；部署专用教程放在仓库外，不提交 Git。支持自包含 HTML、内嵌 CSS、data 图片和普通链接；独立 CSP 沙箱禁止脚本、表单、外部资源和嵌入框架，不放宽首页或管理页的安全策略。

## 节点接入

首次部署者先准备[节点工具与依赖](node-prerequisites.md)。需要端口映射下载时，完整顺序是本机部署、节点接入、按最终节点路径构建助手，再登录核对四个平台下载；`--install-deps` 不会安装 Node/Go。

节点必须已经按现有方式完成本机 Panel 部署。在节点仓库根目录执行：

```bash
npm run server:join
```

命令会交互读取中心地址、slug 和隐藏输入的授权 key。key 不接受普通命令行参数，也不会写入磁盘。

管理页生成的接入命令只包含中心地址和 slug，不包含 key。将 key 单独复制到命令提示的隐藏输入中。已安装并接入同一中心 / 路径的节点，重新授权后执行：

```bash
npm run server:join -- --server https://desk.example.com --slug node-a --reauthorize
```

`--reauthorize` 强制读取新 key，保留本机节点身份和路径，替换旧 credential。普通重复执行 `server:join` 会继续使用原 credential，不会重新询问 key。新机器首次接入不需要该选项；已有私有 CA 可沿用本机保存的 CA。重新授权一经完成，旧中心凭据不会因本地接入失败而恢复；修复接入失败的原因后可使用新 key 重试，若存在恢复记录先按 `server:doctor` 的提示处理。

首次接入后，节点保存专用 credential，生成 `frpc.toml` 和独立 systemd user 服务。中继失败后每 15 秒重试，不因连续失败次数耗尽而永久停止；重新生成服务时也会清理旧的启动限流失败状态。SSH 退出后中继仍运行；建议确保已启用：

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

`server:join` 使用部署锁，并先完成 frpc、CA 和本地条件检查，再申请中心授权。改写配置前先写入最多 256 KiB 的私有事务快照，包含 Panel、旧备份、中继配置、CA 和服务状态；超出限制时拒绝更改。正式接入失败时会停止中继、释放中心授权并恢复原文件和服务状态；若回滚或中心释放仍未确认，会保留私有 `data/selfhost-node/join-recovery.json`，`server:doctor` 会报告该状态。恢复会逐个比较文件与事务预期内容，遇到人工修改保留现场，不覆盖冲突；只有全部恢复已确认才删除记录。故障排除后运行 `npm run server:leave -- --recover` 完成收尾。

诊断与退出：

```bash
npm run server:status
npm run server:doctor
npm run server:leave
```

## TURN

每个节点在 `/node/<slug>/` scope 注册独立 Service Worker；缓存 key 包含入口 scope，安装、激活和旧版本清理只操作本节点缓存，不删除其他节点或无关项目的缓存。

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
- 中心不设固定授权记录数量上限；保留最多 512 条审计记录，单个状态文件最多 256 KiB，达到容量上限时拒绝新增或修改，不截断现有授权

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

## TURN 与转发助手

中心通过 HTTPS 返回短期 TURN 凭据及固定公网 IPv4、UDP relay 端口范围。节点只在该地址范围内接收公网 IPv4 relay 候选；SDP、候选对和收包检查使用同一规则，ICE 消息完整性及 DTLS 校验保持启用。既有私网 IPv4、公网 IPv6 直连和 HTTPS/WSS 回退继续可用。TURN 控制连接支持 UDP、TCP 和 TLS；relay 对端流量使用 UDP。

转发助手从 `0.7.3` 起支持 `https://desk.example.com/node/node-a/`。TCP、串口、反向映射及恢复连接均保留节点前缀，Origin 仍是 `https://desk.example.com`。更新节点后重新运行 `npm run build:forward` 并重新下载助手；构建使用 `.env` 的 `PUBLIC_ORIGIN` 与 `ENTRY_BASE_PATH`，也可显式指定完整节点 URL。旧根地址部署继续兼容。

## 验证范围

`npm run test:selfhost:edge` 使用真实 Caddy 验证本地 TLS、HTTP-01 路由和 Cookie 过滤；续期 shell 命令使用本地夹具，不访问 systemd 或公共 ACME。`npm run test:turn` 使用真实 coturn 做 UDP、TCP、TLS 强制 relay 数据往返。`npm run test:forward:entry` 编译真实 Go 助手并通过节点路径传输 TCP 数据，桌面管理使用夹具。它们都不替代正式服务器上的 DNS、安全组、公共 CA 签发、FRP 和 Cloudflare 部署检查。
