# 从独立域名迁移为网关节点

本文用于把一台已经通过独立域名访问的工作台，改为现有固定网关下的一个节点。迁移只改变浏览器入口和节点身份，不转换工作区模式，不迁移终端、桌面任务、工作区文件或 Codex 会话。

## 地址与前提

以下名称均为占位符：

| 用途 | 示例 |
| --- | --- |
| 原独立入口 | `https://old.example.com` |
| 固定网关入口 | `https://desk.example.com` |
| 网关节点选择页 | `https://desk.example.com/__nodes/` |
| 新私有后端 | `https://node-a-backend.example.com` |
| 节点名称 | `node-a` |
| Cloudflare 区域 | `example.com` |

开始前确认：

- 固定网关已经部署，`https://desk.example.com/__nodes/` 可以打开。计划把迁移节点设为默认入口前，应另有一个可用节点用于回退。
- 原独立部署仍有自己的 Tunnel、Tunnel token、`PUBLIC_ORIGIN` 和登录凭据。迁移不创建新的 Tunnel。
- 新后端主机名属于网关的 `backendZone`，且尚未被其他 DNS 记录、Worker、Access 应用或 Tunnel ingress 占用。
- 已从网关选择页取得接入码，并只保存到节点的私有 `secrets/gateway_code`。
- 不使用固定网关作为节点后端，也不用原独立域名作为固定网关。

固定网关的初始化和发布见[固定域名网页切换节点](gateway.md)。已有独立部署不需要重新运行带 `--domain` 的 `npm run deploy`。

## 1. 记录迁移前状态

在节点部署目录，以部署时的 Linux 普通用户执行：

```sh
npm run deploy -- --check
npm run native:status
```

另外私有记录以下信息。不要记录登录密码、Tunnel token、节点 secret 或 API Token 内容。

- 原 DNS 记录的完整名称、类型、内容、代理状态、TTL 和备注。
- 原 Tunnel 的 ingress 列表、Tunnel ID、私有 socket 路径和健康连接状态。
- panel、桌面／终端宿主、actions、manager、files 和 Tunnel 服务的主 PID 与启动时间。
- 是否存在 `data/cloudflare-publication.json`、`data/cloudflare-activation.json` 或其他待核对迁移记录。
- 是否存在 `data/gateway-join.json`。存在时表示已有接入需要继续，不能另起一套身份。

检查本机实际私有上游：

```sh
node --input-type=module -e 'import {maintenanceSettings} from "./native/config.mjs"; console.log("unix:" + maintenanceSettings().tunnelSocket)'
```

记录服务 PID 用于迁移后比较，例如：

```sh
systemctl --user show codex-cloud-panel.service \
  -p MainPID -p ExecMainStartTimestamp --no-pager
```

panel 可能因加载节点身份而重启，端口映射会因此需要重新配对。桌面／终端宿主、manager、files 和 Tunnel 不应因本次迁移重启。

## 2. 在本机准备节点身份

将完整 `cog1.` 接入码保存到节点后，先只准备本机配置：

```sh
chmod 600 secrets/gateway_code
npm run gateway:join -- \
  --gateway https://desk.example.com \
  --backend https://node-a-backend.example.com \
  --name node-a \
  --prepare-only
```

这一步会生成本机节点身份，写入带大小上限的 `data/gateway-join.json`，并调整 `.env` 中的 `PUBLIC_ORIGIN`、`NODE_ID` 和 `SHARED_ENTRY`。它不会登记到远端，也不会修改 DNS 或默认路由。

准备后不要修改 `.env`、`secrets/credentials.txt`、`data/gateway-node.json` 或待恢复记录。若已有接入需要继续，重跑相同目标，不要生成新节点 ID。

## 3. 为节点配置私有后端

后端必须使用原节点自己的 Tunnel，并指向同一个私有 Unix socket。该后端只供网关探测和转发，不是浏览器登录入口。

在 Cloudflare 控制台或自己的受控 API 工具中完成两项变更：

1. 为新后端主机名添加代理 CNAME，目标为 `<原 Tunnel ID>.cfargotunnel.com`。
2. 在同一个 Tunnel 的 ingress 中增加 `node-a-backend.example.com`，上游使用第 1 步打印的 `unix:` 地址；保留末尾的 `http_status:404` 兜底规则。

示意结构如下：

```text
node-a-backend.example.com -> <TUNNEL_ID>.cfargotunnel.com (proxied CNAME)

Tunnel ingress:
  node-a-backend.example.com -> unix:/run/user/<UID>/codex-on-cloud/tunnel.sock
  old.example.com            -> 同一私有 socket（迁移完成前保留）
  http_status:404
```

迁移期间保留原独立入口的 DNS 和 ingress，用于失败回滚。不要删除 Tunnel、Tunnel token 或运行服务，因为新后端会继续使用它们。

后端不能被 Access 登录页或其他 Worker 截住。网关需要直接访问该主机名，并携带节点身份头。直接访问后端时出现 Host 或认证拒绝是预期行为，不要把后端 URL 交给普通浏览器使用。

等待 cloudflared 加载远端配置后，可查看日志确认 ingress 已更新：

```sh
journalctl --user -u codex-cloud-tunnel.service -n 50 --no-pager
```

如果新后端仍由 nginx 等旧服务返回 404，先核对 DNS CNAME 和 ingress 是否真正指向原 Tunnel，不要继续登记。

## 4. 完成登记

在节点上重跑完全相同的接入命令，但不带 `--prepare-only`：

```sh
npm run gateway:join -- \
  --gateway https://desk.example.com \
  --backend https://node-a-backend.example.com \
  --name node-a
```

命令会先检查本机私有入口、宿主和文件服务，再按需要重启 panel 加载节点身份。随后网关从公网探测新后端；只有节点身份、Host、就绪状态和代理凭据都匹配时才登记。

预期结果为：

```json
{"registered":true,"nodeId":"...","origin":"https://desk.example.com","backendOrigin":"https://node-a-backend.example.com"}
```

登记本身不修改默认节点。完成后可只读核对本机身份，不输出 secret：

```sh
node --input-type=module -e 'import{readGatewayConnection}from"./native/gateway-config.mjs";const c=readGatewayConnection(process.cwd());console.log({origin:c.origin,backendOrigin:c.backendOrigin,nodeId:c.nodeId,name:c.name,registered:Boolean(c.registeredAt)})'
```

如果命令因网络超时或响应中断退出，不要立即重复提交。先检查：

- `/__nodes/` 中是否已经出现同名节点和对应节点 ID。
- `data/gateway-join.json` 是否显示登记请求已发送，但本机完成记录尚未写入。
- 原 Tunnel 是否健康，后端是否已加载最新 ingress。

确认远端未登记后，才可用相同命令和相同身份继续。确认远端已登记后，方可显式重跑一次相同命令；它会以同一节点 ID 和 secret 完成幂等登记并补写本机记录，不得自动重试或更换节点 ID、名称、网关和后端。

## 5. 验证并切换

保持原默认节点不变，先打开 `https://desk.example.com/__nodes/`：

1. 确认新节点已登记、后端就绪。
2. 记录原默认节点，保留回退目标。
3. 检查并切换新节点。
4. 使用该节点原来的账号密码登录。网关密码与节点登录密码分别管理。
5. 检查 `/healthz`、`/readyz`、终端或桌面、文件列表以及实际需要的网络功能。

切换只影响后续页面访问。已有健康 WebSocket／WebRTC 保留原节点连接；任务和文件不迁移，旧页面、旧下载链接不能误操作新节点。未确认的输入、审批和写请求不会重发。

建议先用原节点承载默认入口，直到已验证新节点。若迁移节点是网关中唯一的节点，不要在没有其他节点可回退时将其设为当前入口后直接删除旧入口。

## 6. 撤下旧独立入口

完成登录和实际功能验收后，再从 Cloudflare 撤下原独立入口：

1. 删除 `old.example.com` 的旧代理 CNAME。
2. 从原 Tunnel ingress 删除 `old.example.com` 规则。
3. 保留 `node-a-backend.example.com` 的 CNAME 和 ingress。
4. 保留 Tunnel、Tunnel token、panel、宿主和文件服务。

清理后，浏览器只使用 `https://desk.example.com`，节点后端只供网关使用。不要运行 `npm run native:publish` 或带 `--domain` 的普通发布来修改网关成员；这些命令会被拒绝。

## 故障回滚

先判断迁移停在哪一步，再选择回滚动作。不要直接删除 `data/gateway-node.json` 或覆盖 `data/gateway-join.json`。

| 阶段 | 回滚方式 |
| --- | --- |
| 仅完成 `--prepare-only`，尚未登记 | 确认远端没有该节点后运行 `npm run gateway:join -- --abort`；命令恢复本机文件并重载 panel |
| 登记请求已发送但结果未知 | 先在 `/__nodes/` 和恢复记录中核对；确认未登记后才执行 abort 或继续 |
| 已登记但未设为当前节点 | 先在选择页移除节点，再执行 `gateway:join -- --abort` |
| 已设为当前节点 | 先切回其他健康节点，再移除本迁移节点，然后执行 abort |
| 已删除旧 CNAME／ingress | 先重建原 DNS 和 ingress，再完成上述节点移除与本机 abort |

`gateway:join -- --abort` 只恢复本次接入仍能匹配的本机文件。若期间人工改过 `.env`、凭据或节点配置，命令会拒绝覆盖，应先核对差异。原独立入口的 DNS 和 ingress 在最终清理前应一直保留。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 新后端返回 nginx 404 | CNAME 或 ingress 尚未指向原 Tunnel；不要继续登记 |
| 新后端返回 400／403 | 后端不是普通浏览器入口；检查 Host、节点身份、网关 secret 和 PUBLIC_ORIGIN 是否一致 |
| `本机尚未加载网关身份` | 检查 panel 日志和 `.env`，再用同一命令继续；不要绕过私有入口检查 |
| `/__nodes/` 没有新节点 | 未登记或探测失败；先核对 Tunnel、后端和恢复记录，不重复创建身份 |
| 登记后网关返回 502／503 | 检查后端 CNAME、ingress、Tunnel 健康连接及节点就绪状态 |
| 切换后页面空白或登录异常 | 核对当前默认节点，使用该节点原账号密码；不要在两个节点间反复提交切换 |
| 端口映射失效 | panel 曾为加载节点身份重启；任务保留，但需要在面板重新配对映射 |

完成迁移后，服务 PID、公网入口、节点目录、旧 DNS 清理结果和实际功能验收应分别记录。测试或日志中的“节点已登记”不能替代真实浏览器登录和任务保留检查。
