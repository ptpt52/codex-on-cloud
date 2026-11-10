# 固定域名网关：从网页切换动态节点

固定入口使用 Cloudflare Worker，每台机器保留自己的 Tunnel 和独立后端域名。打开固定入口的 `/__nodes/`，登录网关，选择节点并确认；网关检查目标就绪后，原子更新默认路由，进入该节点。节点可以动态加入和移除，无需维护 A／B／C 固定列表。

**日常切换和 `gateway:join` 不读取 `secrets/cf_token`，不调用 Cloudflare 管理 API，也不修改 DNS。** 每台机器仍需要自己的 `secrets/tunnel_token` 运行 Tunnel。首次创建 Worker、绑定域名及配置每个 Tunnel 后端，需要 Cloudflare 账户权限，可以在控制台完成，或由部署机器使用 Wrangler 的交互登录；这些是配置动作，与运行时切换分开。

## 地址与生命周期

示例使用：

| 用途 | 地址 |
| --- | --- |
| 浏览器固定入口 | `https://home-codex.x-wrt.dev` |
| 独立节点选择页 | `https://home-codex.x-wrt.dev/__nodes/` |
| home 节点专用后端 | `https://home-backend.x-wrt.dev` |
| 其他节点专用后端 | `https://laptop-backend.x-wrt.dev` 等 |

后端域名只用于网关转发，需要位于初始化时指定的 `backendZone` 内，不得指向固定入口本身。Worker 作为固定域名的 Custom Domain 接收所有路径，控制页独立于任何节点；后端使用正常的 Tunnel 域名，不给后端再套一个匹配的网关 Worker Route。[Custom Domains 官方说明](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

切换更新的是所有浏览器后续请求的默认节点。原机器上的 Codex、tmux、桌面、文件和端口映射继续运行；已经连接的 WebSocket／WebRTC 保留原连接。新请求携带原节点身份，旧页面、下载链接和重连不能借另一个节点的有效登录操作新机器。切换不迁移任务、输入或文件，不自动重发提示词和审批。打开选择页会离开当前工作台；从工具菜单进入前会保存草稿并检查未完成输入或传输。

HTTP 上传、下载和 WebSocket 经 Worker 流式转发；已有 WebRTC 直连仍直接连目标节点。真实 Cloudflare 网络的延迟、连接限制和账户配额需要部署后单独核对，本地 Worker 测试不代表生产性能。

## 首次部署与迁移现有入口

以下命令在已完成本机部署的仓库中，以部署用户执行。所有示例地址需按实际节点替换。此流程不会由脚本自动接管现有 DNS。

### 1. 为每个 Tunnel 准备永久后端域名

在 Cloudflare 控制台，为当前节点已有的 Tunnel 增加 `home-backend.x-wrt.dev`，上游使用同一私有 Unix socket，例如：

```yaml
ingress:
  - hostname: home-backend.x-wrt.dev
    service: unix:/run/user/1000/codex-on-cloud/tunnel.sock
  - service: http_status:404
```

保留每台机器原有独立 Tunnel，其他节点选择各自唯一后端域名。不使用公网 TCP 上游。转发的 Host 必须是该节点的后端域名；如 Tunnel 配置过 HTTP Host Header 覆盖，清除覆盖或设置为这个后端域名。不要改成固定入口的 Host。Worker 的就绪探测必须能访问后端，不能被交互式 Access 登录页或其他 Worker Route 截住；面板仍验证私有接入、网关凭据及用户登录。

迁移时先增加后端记录，暂时保留原固定入口的路由和 DNS。不要删除 Tunnel 或运行令牌。

### 2. 初始化和构建网关

在一台维护机器上执行一次：

```sh
npm run gateway:setup -- \
  --origin https://home-codex.x-wrt.dev --backend-zone x-wrt.dev
npm run gateway:build
```

生成 `data/gateway.json`、`secrets/gateway_password` 和 `data/gateway-build/`，均为私有文件。密码由脚本随机生成，不输出到终端；使用私有编辑器查看密码，以后登录选择页。重复初始化保留密码，并拒绝隐式更换固定域名或后端区域。构建产物包含 Worker、Wrangler 配置和密码哈希文件，尚未上传任何内容。

### 3. 准备当前节点

```sh
npm run gateway:join -- \
  --gateway https://home-codex.x-wrt.dev \
  --backend https://home-backend.x-wrt.dev --name home --prepare-only
systemctl --user restart codex-cloud-panel.service
```

准备会持久保存节点身份、网关代理凭据和 canonical `PUBLIC_ORIGIN`，启用 `SHARED_ENTRY=1`，保留接入恢复记录。此时还未向网关登记，不改 DNS，不重启桌面、任务管理器或 Tunnel。面板重启可能按既有 PartOf 关系关联 files；内存映射按原规则需要重新配对。

准备后，普通 `deploy` 暂时拒绝执行，直到接入完成或撤销，避免中途改写配置。原固定入口仍指向这台机器时，可继续通过原域名访问。新后端直接打开可能被 Host 校验拒绝，这是因为它只接受带私有凭据的网关转发。

### 4. 部署 Worker 并迁移固定域名

使用与 CI 一致的固定 Wrangler 版本，可通过交互登录取得部署权限：

```sh
npx --yes wrangler@4.158.0 login
```

**已有固定域名 CNAME 时，需先在控制台移除该固定域名的旧 CNAME，再绑定 Worker Custom Domain。** Cloudflare 不允许在已有 CNAME 的同名主机创建 Custom Domain。保留之前记录的旧 CNAME 目标，保留第一步的永久后端记录和 Tunnel；这段迁移及首次设置密码哈希期间，固定入口可能短暂不可用。[官方限制与迁移步骤](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

```sh
npx --yes wrangler@4.158.0 deploy --config data/gateway-build/wrangler.json
npx --yes wrangler@4.158.0 secret bulk data/gateway-build/worker-secrets.json \
  --config data/gateway-build/wrangler.json
```

Worker 配置关闭 `workers.dev` 和预览网址，使用独立 SQLite Durable Object 保存目录与路由。不要覆盖现有统一门户的 Worker。网关创建的固定域名绑定应由这个 Worker 管理，不能再让旧 `native:activate` 或域名发布命令修改它。

### 5. 创建接入码，完成登记

打开 `https://home-codex.x-wrt.dev/__nodes/`，用 `secrets/gateway_password` 登录，在“接入新节点”创建接入码。将完整 `cog1.` 接入码用私有编辑器保存到节点的 `secrets/gateway_code`，文件权限设为 `0600`，然后执行：

```sh
chmod 600 secrets/gateway_code
npm run gateway:join -- \
  --gateway https://home-codex.x-wrt.dev \
  --backend https://home-backend.x-wrt.dev --name home
```

命令检查本机私有入口，按需要加载面板身份，再向网关登记。网关从永久后端域名核验目标 `/readyz` 的身份、任务宿主和文件服务。登记成功后，选择页显示节点；点击“检查并切换”，确认后进入。**登记本身不修改默认节点。** 工作台仍使用该节点原有账号密码，网关密码不替代节点登录。

## 新增机器与日常操作

新节点先完成普通本机部署，配置独立 Tunnel 和永久后端域名，保存网关接入码，再执行：

```sh
npm run gateway:join -- \
  --gateway https://home-codex.x-wrt.dev \
  --backend https://laptop-backend.x-wrt.dev --name laptop
```

也可用 `--code-file /私有路径/gateway_code` 指定文件。每台机器持久使用自己的 nodeId 和代理凭据。重复执行同一接入可更新名称，不能隐式改绑网关或后端域名。已有登记可用自身凭据再次登记，无需重新提供接入码；已经撤销接入码只禁止新登记，不删除已有节点。

日常从“工具 → 切换入口节点”进入选择页，或直接打开 `/__nodes/`。列表每页 16 台，显示当前节点和最近一次就绪检查；检查后再原子切换。目标未就绪则保留当前入口。当前节点离线时，直接打开 `/__nodes/` 仍可切换；根页面访问失败也会引导到选择页。

退出网关只撤销网关登录。移除登记只删除目录项，不停止原机器或 Tunnel；必须先切到其他节点才能移除当前节点。网关管理员登录与节点账号分离，节点临时账号没有网关管理权限。

完成登记后，本机更新仍可执行 `npm run deploy`，但不要传 `--domain`；不同的 `--origin` 也会被拒绝。`native:activate`、`native:publish` 及 `deploy --domain` 会在读取管理 Token 或写 DNS 前拒绝网关节点，防止旧流程抢走固定域名。原有 `secrets/cf_token` 约定继续适用于未加入网关的旧 DNS 发布方式。

## 回复丢失与撤销准备

切换只发送一次 POST。回复丢失时，页面读取当前路由和操作身份核对，不自动重发或跳转；核对完成后手动点击“进入当前节点”。并发切换、列表变化和过期探测结果会被拒绝，没有自动故障切换或写请求重试。

接入中断会保留 `data/gateway-join.json`。修复网络／Tunnel 后，明确重跑相同命令；脚本复用同一 nodeId 和代理凭据。已确认登记的恢复只完成本机收尾，不再次发送登记。恢复期间发现人工配置修改则停止并保留记录，不覆盖人工内容。包含密码或代理凭据的恢复文件不要粘贴到聊天、日志或 Git。

撤销尚未完成的接入：

```sh
npm run gateway:join -- --abort
```

未发送登记时直接条件恢复准备前的本机配置。登记已经发出或确认时，先只读核对远端自身登记；仍在网关时拒绝撤销，需要先从网页选择其他节点并移除该登记。无法确认远端状态时也保留恢复记录。撤销只恢复仍匹配准备内容的文件，按需重载面板，不修改 DNS 或网关默认路由。

已完成接入后的迁出属于单独维护操作：先切换到别的节点、移除登记，再规划该节点的独立域名与本机配置。`--abort` 不替代已完成部署的迁移。Worker 首次绑定失败时，可以在控制台恢复之前保存的旧固定入口 CNAME；不要同时运行旧 DNS 激活命令。

## 安全与资源边界

- Worker 验证固定 Host、写操作 Origin、独立登录及 CSRF；网关会话仅作用于 `/__nodes/`。节点密码不写入 DO，其他节点 Cookie 和网关 Cookie 不转发给当前节点。
- 每节点代理凭据只保存在私有本机配置和 DO 中，不返回列表或浏览器。面板只在私有 Tunnel Unix socket 接受匹配凭据、后端 Host 和 nodeId 的代理身份，再恢复 canonical Host；浏览器 Origin 和 CSRF 仍按原规则校验。回环 TCP 上伪造相同头也被拒绝。
- 最多 64 个节点、16 个可复用接入码、8 个有效网关会话、64 个失败登录来源桶；DO 总状态最多 128 KiB，登录失败 8 次后限流 15 分钟。每页 16 台，最多并发 4 次状态探测、2 次登记、1 次切换；探测期限 4 秒，切换租约 15 秒，过期结果不能覆盖新选择。
- 控制请求最多 8 KiB、读取期限 5 秒。文件流不进入 DO 或控制请求缓冲；转发失败不会重试或转交另一台机器。
- 本机配置 `data/gateway.json` 最多 2 KiB，`data/gateway-node.json` 最多 4 KiB，唯一接入恢复记录最多 256 KiB。网关密码最多 128 字节，接入码文件最多 1 KiB；均要求当前用户私有普通文件。构建 Worker 最多 256 KiB，每个静态资源最多 64 KiB。全部位于 Git 忽略的 `data/`、`secrets/`，不新增任务队列或流量日志。

## 验证范围

核心状态机测试使用模拟 DO 存储和探测；浏览器使用真实 HTTP／WebSocket／WebRTC 以及模拟终端、文件和管理上游。`npm run test:gateway:worker` 使用固定 Wrangler 内的真实 workerd、SQLite、HTTP／WebSocket 和面板私有入口，验证上传下载、保持旧 WebSocket、路由与会话重启恢复，终端／文件宿主仍为夹具。

这些夹具测试不调用生产 Cloudflare API，不改变 DNS，不运行真实 Xvfb／x11vnc／Codex 任务。生产 Custom Domain、证书、Tunnel、Access 策略及实际跨机器网络需要首次部署时逐项核对。`home-codex.x-wrt.dev` 已另外完成实际迁移，当前登记并选择 home，使用 `home-backend.x-wrt.dev` 作为永久后端；其他机器需独立完成接入。上线及审核结果见[验证记录](verification.md)。

本次维护另保留一份私有 `data/gateway-rollout.json`，最多 256 KiB，记录迁移前的 DNS／Tunnel 配置、阶段及不含登录凭据的审核结果；日常网关路由和节点切换不读取此文件。
