# Cloudflare 原生部署

先确保 `http://localhost:36080` 的真实桌面可用。节点直接运行本机 cloudflared，不使用 Docker 或自定义中继协议；可选的[统一门户](portal.md)单独部署为 Worker，节点流量仍通过自己的 Tunnel。

## 1. 安装 cloudflared

```bash
npm run native:cloudflared
```

固定版本 `2026.10.0`，从 Cloudflare 官方 GitHub release 下载 Linux x86_64 / ARM64 二进制并校验 SHA-256。安装在项目私有目录，无需 sudo，不自动更新。

## 2. 使用 API 自动创建 Tunnel 与域名

API Token 与 Tunnel 运行 token 是不同的凭据。自动部署使用 API Token，最低需要：账户 Cloudflare Tunnel 编辑、区域 Zone 读取、区域 DNS 编辑；资源范围限制为目标账户和区域。约定放在 `secrets/cf_token`，只含一行 token、属于当前用户、权限 0600、最多 4 KiB；该目录已被 Git 忽略。`deploy`、`native:publish`、`native:activate` 默认读取此文件，可用 `--api-token-file FILE` 显式覆盖；已接入共享入口的节点仍兼容原先保存的路径。后台运行只使用新 Tunnel 自己的运行 token。

```bash
npm run native:publish -- \
  --domain home-codex.x-wrt.dev --zone x-wrt.dev --prepare-only
systemctl --user restart codex-cloud-panel.service
npm run native:tunnel
npm run native:publish -- \
  --domain home-codex.x-wrt.dev --zone x-wrt.dev --commit-only
```

此命令创建专用 Tunnel、配置私有 Unix socket 上游、添加代理 CNAME，并更新 `.env` 与登录信息中的入口地址。已有无关 DNS 记录或同名 Tunnel 会使脚本停止，不会覆盖它们。部署归属保存在 `data/cloudflare-deployment.json`；发布期间的原配置保存在私有 `data/cloudflare-publication.json`，成功提交或确认回退后清理，均被 Git 忽略。旧版留下的 `.env.before-cloudflare` 不会自动删除。

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

HTTPS 部署由面板在全部响应上发送 `Strict-Transport-Security: max-age=31536000`。私有 Tunnel 入口还会读取 Cloudflare 的 `CF-Visitor` 协议标记，把明文 HTTP 请求以 308 跳转到同一允许 Host 的 HTTPS 地址；普通回环请求即使伪造该头也不会被跳转。Cloudflare 侧仍应开启 Always Use HTTPS，HSTS 只负责已通过 HTTPS 成功访问后的浏览器策略。

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

## 固定域名在任意节点之间切换

需要始终访问同一个完整域名、经常把入口切到当前机器时，使用独立的 `native:activate`，不需要预先登记节点数量或名称。每台机器使用自己的 Tunnel、节点身份、登录、工作区与终端；共享域名只指向当前激活节点，不把多个独立工作台作为同一 Tunnel 的副本混用。Cloudflare 副本不能保证指定某台主机，参见[官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/)。

先更新各节点代码并完成本机部署；新机器可先用 `npm run deploy -- --origin https://desk.example.com` 初始化本地服务，不先发布 DNS。激活命令会检查／安装项目固定版本的 cloudflared，已有其他版本文件时拒绝覆盖。首次在**当前拥有该域名的原节点**执行一次，启用共享入口；随后任意新节点首次接入也运行完整命令，例如：

```sh
npm run native:activate -- --domain desk.example.com --zone example.com
```

令牌文件需属于当前用户、权限 0600、最多 4 KiB；权限沿用自动发布需要的 Tunnel 编辑、Zone 读取和 DNS 编辑，范围限制为目标账户与区域。API Token 可以在各节点独立签发，只保存文件路径；不要复制原节点的 `secrets`、`data`、工作区或登录缓存。新节点有已初始化的其他域名部署时会拒绝隐式改绑，需先明确迁移到选定的固定入口。

首次接入后，在想使用的任意节点执行以下命令，即将固定域名入口切到这台机器：

```sh
npm run native:activate
```

每节点只维护一份接入身份并复用同一个 Tunnel；节点数量可动态增加、退出，不需要修改固定 A/B/C 列表。首次启用会把该节点的 `PUBLIC_ORIGIN`、`NODE_ID` 和 `SHARED_ENTRY=1` 写入原 `.env`，必要时仅重启本机面板和 Tunnel；按已有 PartOf 关系关联的文件服务可能随面板重启。桌面、manager、tmux 和任务不重启。面板首次重启后的映射仍需重新配对；后续配置未变化的激活不重启面板。

命令先验证私有入口、固定节点身份、文件服务和 Tunnel 已健康接入 Cloudflare，再更新 CNAME；随后读取确认并通过公网 `/readyz` 核对当前可见节点。已有域名未启用共享标记且不属于本机部署、DNS 指向其他服务、Tunnel 含其他路由、备注空间不足或配置被人工修改时均拒绝覆盖。普通 `deploy`／`native:publish` 不会因此获得抢回其他活动节点入口的权限。

所有节点的共享入口身份使用 DNS 备注中的固定标记关联，保留已有备注前缀，按 Free 套餐的 100 字符上限处理，不依赖付费 DNS tags；空间不足时先由用户备份并缩短原备注，不自动丢弃备注。[Cloudflare 备注及 tags 限制](https://developers.cloudflare.com/dns/manage-dns-records/reference/record-attributes/)

切换后先保存浏览器草稿并刷新页面，顶部显示当前节点身份的前八位，可与命令输出的 `nodeId` 对照。各节点登录 Cookie 和草稿隔离；即使不同机器恰好有相同 pane/PID，也不带入另一节点的草稿。浏览器最多持久保存 16 个节点的临时草稿命名空间，总序列化字符上限 2 MiB；超限保留当前内存草稿并提示保存失败，不静默淘汰未提交文字。旧版未绑定节点的草稿不自动导入任意新节点，首次启用前先复制重要文字。

旧页面的 HTTP／WebSocket 请求绑定原节点，路由已切到别处时停止操作并提示刷新，不把重命名、粘贴、Enter 或其他未确认动作改发到新节点。已有健康的直连／WebSocket 可能仍连接原节点；它们不会迁移，旧任务继续在原机器运行。原映射后续恢复若访问到其他节点会失败，不会换目标或重放旧数据。门户仍是目录，若将共享域名加入门户，应把它作为一个逻辑入口，不用同一个地址重复注册多台物理节点。

查看状态：

```sh
npm run native:activate -- --status
```

`active` 表示当前读取的 DNS 记录确实指向本节点且共享标记匹配，不保证其他地区或已有连接已经切换。公网传播未确认时命令会明确提示；不重复提交切换或回退旧节点。多机同时切换不提供跨主机锁或原子比较写入保证，以最终 DNS 状态为准，**不要并行发起激活**。

接受后回复丢失会通过一次读取核对本次随机操作标记；仍无法确认时保留有界恢复记录并阻止自动重发。先运行 `--status`，确认愿意接受当前 DNS 结果后可明确解除本机待核对记录：

```sh
npm run native:activate -- --resolve-unknown
```

此动作只读取 DNS 并收尾／清除本机记录，不发送新的切换，也不回滚别人后来激活的节点。原先准备的本机服务配置会保留，之后可重新明确执行 `native:activate`。

普通域名发布与共享入口激活互相检查未完成记录。普通发布未结束时先按原目标完成或回退；共享切换待核对时先查询／解除记录，再运行部署或普通发布，避免不同维护命令覆盖对方的准备状态。

新增持久状态只有每节点一份 `data/cloudflare-node.json`（最多 8 KiB，含身份与令牌文件路径）和一份 `data/cloudflare-activation.json`（最多 256 KiB，含本机配置快照及本次操作），均 0600、被 Git 忽略；临时文件与空租约沿用已有有界写入工具，不保存节点列表、历史队列或流量日志。已退出且不再使用的机器，其独立 Tunnel 可由账户管理员在 Cloudflare 控制台明确删除；命令不自动删除其他节点的资源。

## 网页显示节点列表并切换共享入口：可行性

可以实现，但现有门户列表只保存不同服务器网址；`panel/public/node-directory.js` 要求每个 origin 唯一，`node-ui.js` 的切换动作也是网页跳转。共享域名的多台物理机器不能直接按相同网址加入该列表。当前激活记录只在各机器本地保存，也没有可供网页完整读取的共享节点目录。

建议为同一域名保留独立的节点选择路径，例如 `https://home-codex.x-wrt.dev/__nodes/`，由 Cloudflare Worker 提供，工作台仍使用原 Tunnel。Worker Routes 支持按 hostname 和路径匹配，在已有代理 DNS 前执行；只为选择页保留路径即可，不必改造桌面／终端／文件的转发。[Worker Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)

推荐流程：

1. 节点首次接入后，用独立接入凭据向控制服务登记自己的稳定 nodeId、名称和 Tunnel 身份，随后主动建立控制连接并报告就绪状态；新增机器无需改固定列表。
2. 选择页登录后显示当前节点、在线／离线和最近就绪时间。用户选择在线目标并确认，服务端只接受已登记的 nodeId，不接受任意命令、文件路径或任意探测网址。
3. 控制服务一次只接受一个切换，把固定的“激活本机”动作交给目标节点；目标节点读取本地 `secrets/cf_token`，复用现有私有入口／Tunnel 就绪检查和一次性 DNS 提交流程。Token 不返回浏览器，控制 Worker 也不需要保存节点的 Cloudflare 管理 Token。
4. 读回实际 DNS 标记并确认新节点后，提示保存草稿、刷新工作台。未知结果保留待核对状态，先查询，不自动重发切换或回滚。原节点的任务继续运行，已有直连不迁移、不重放输入。

把选择页独立于当前机器的好处是：当前节点离线时，仍可打开同一域名的 `__nodes/` 选择其他在线节点。只在本机面板加按钮也能做基础切换，但面板离线时该按钮与列表都无法访问，因此不适合作为唯一入口。这里是基于 Worker 路由方式的架构判断，尚未实际部署验证。

可复用现有门户 Worker／Durable Object 的登录和存储方式，另建按物理 nodeId 区分的注册数据；DO 提供事务和强一致存储，适合原子认领唯一的待切换操作。[Durable Objects 存储](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)。外部 DNS API 写入仍不属于该存储事务，必须持久记录操作身份并在中断后读回核对。未来 CLI 正常激活也应经过同一控制服务串行化；现有直接改 DNS 的 CLI 不能与网页并发写入时声称原子互斥。

实施时需要新增一个独立于桌面和面板生命周期的节点控制 helper，固定动作、每节点最多一个连接／一次激活，无无限队列。注册表应分页并设总记录与字节上限，过期心跳只标记离线，不删除任务或远程唤醒机器。页面和切换接口保留独立登录、Host／Origin／CSRF 检查，临时账号不获得切换权；节点凭据和 Token 继续留在各自私有状态中。

这种共享入口切换影响所有后续访问，不是每个浏览器独立的默认节点。目前只完成可行性分析，没有新增网页激活接口、控制 helper 或 Worker 路由，也没有更改生产 DNS。

## 修改本项目节点域名

已有部署修改为 `home-codex.x-wrt.dev` 时，显式使用 `--rename`，沿用本项目记录的 Tunnel，不创建共享副本：

```sh
npm run native:publish -- --domain home-codex.x-wrt.dev --zone x-wrt.dev \
  --rename --prepare-only
systemctl --user restart codex-cloud-panel.service
npm run native:tunnel
npm run native:publish -- --domain home-codex.x-wrt.dev --zone x-wrt.dev \
  --commit-only
```

只允许在原账户和区域内修改；目标域名有无关 DNS 记录、Tunnel 有无关域名路由时拒绝覆盖。成功后仅清理本项目状态记录且仍匹配原 Tunnel 的旧 CNAME，不保留旧入口兼容。中途失败可用同一目标域名重复执行以完成操作，不能在待完成状态再改第三个域名。

修改后需要通过新域名登录，助手使用新地址重新配对。面板重启会结束内存中的映射，桌面和 Codex 任务继续。完成域名设置后，可在“工具 → 门户接入”注册到[统一门户](portal.md)。

## 发布阶段与失败恢复

`npm run deploy -- --domain ...` 先准备本机域名和Tunnel运行令牌，启动/更新服务并验证 `/readyz` 后，才提交远端路由和DNS。提交前再次通过0600 Unix socket验证目标Host、任务宿主与文件服务；服务启动或就绪失败不切公网入口。独立 `native:publish` 默认准备并尝试提交，首次更换本机域名时建议使用上面的显式两阶段命令。

提交会在远端预检前后复核本机`.env`、登录信息和Tunnel运行令牌与准备结果一致；准备后被人工修改或删除时停止，不写远端路由/DNS、不覆盖修改，并保留prepared记录。请用私有编辑器核对恢复记录中的预期配置，再明确选择继续提交或回退；不要把含密码和令牌的恢复内容粘贴到日志或聊天。

本机准备写入和回退恢复使用预期内容条件：取得每个文件的flock后重新读取比较，临时文件写完后、同步改名或删除前再比较一次，中间不让出异步执行。原先不存在的文件通过原子独占创建发布，回退删除也只删除内容仍匹配的文件。配置或恢复记录被修改时停止并保留人工内容；恢复记录和部署归属的更新、清理也执行条件核对。各写入工具应遵守同一个文件锁；不遵守锁的外部编辑器仍应避开发布窗口，不能将这些检查理解为跨任意进程的文件系统事务。

本机只保留一份 `data/cloudflare-publication.json` 恢复记录（0600、最多256 KiB），含前后本机配置、运行令牌、原Tunnel配置和DNS记录，不保存API token，不得提交Git或公开。API响应最多256 KiB、单次25秒；同一部署的发布阶段由独立系统文件锁串行化，无等待队列。进程中断后，prepared记录可以继续准备/提交，committing或rollback-needed记录需先回退；committed记录只继续清理旧别名，不回退有效入口。

完整`deploy`从初始化前到就绪/发布结束持有`data/deploy.lock`，独立`native:publish`也使用此租约；固定锁inode最多256字节、不删除、无等待队列，崩溃后由内核释放。自动部署在同一Node进程调用发布模块，使用实际租约和随机32位操作ID，不通过命令行标志跳过锁。准备、提交和自动回退都核对同一操作；准备被另一项待发布记录拒绝时，不撤销对方配置或删除其记录。准备已写入后发生失败，仍能回退本次操作。独立`--rollback`也校验命令指定的域名和区域。

新恢复记录含操作ID，旧记录仍可用独立阶段命令处理。完整deploy不会自动接管其他部署或旧进程留下的prepared记录，即使目标域名相同；先按记录中的原目标明确完成`--commit-only`或`--rollback`，再重新部署。升级应先等旧版部署/发布命令结束，不混用不理解完整租约和操作归属的旧写入者。

写入成功但确认丢失时先读取远端核对；失败会恢复本次已修改的路由、DNS及本机配置。检测到他人修改或无法确认回退时保留恢复记录并停止，不盲目覆盖、不报告恢复成功。修复连接后可运行：

```sh
npm run native:publish -- \
  --domain home-codex.x-wrt.dev --zone x-wrt.dev --rollback
```

新建的专用Tunnel归属记录保留供重试，避免重复创建；回退不会删除原有Tunnel或停止桌面任务。恢复本机域名后，已加载新域名的panel需要重载，自动部署会处理该步骤；映射按原规则需重新配对。Cloudflare配置API为整份配置更新，提交和回退前均复核最新快照；API没有提供本项目可用的原子比较交换，因此外部管理操作应避开发布窗口。
