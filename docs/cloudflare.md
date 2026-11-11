# 使用自己的 Cloudflare 接入

两种工作区模式都能使用本页流程。示例采用 `desk.example.com` 和区域 `example.com`，请替换为自己账户内的域名。需要网页切换多节点时，先为每台机器使用独立的 `node-a.example.com` 等后端域名，再配置[固定网关](gateway.md)。已有独立 Cloudflare 入口要并入现有网关时，按[独立域名迁移 SOP](gateway-migration.md)操作，不要直接改写固定入口的 DNS。

## 凭据与权限

| 凭据 | 保存位置 | 用途 |
| --- | --- | --- |
| CF API Token | `secrets/cf_token`，或 `--api-token-file` 指定文件 | 自动创建／维护 Tunnel、DNS；不用于 Tunnel 常驻连接 |
| Tunnel token | 每台机器的 `secrets/tunnel_token` | cloudflared 连接该节点自己的 Tunnel |
| 网关接入码 | 节点的 `secrets/gateway_code` | 只有使用固定网关时才需要，用来登记新节点 |

自动配置单节点所需权限：账户 **Cloudflare Tunnel 编辑**、目标区域 **Zone 读取**和 **DNS 编辑**。资源范围选择自己的账户与区域。发布网关另外需要目标账户的 **Workers Scripts 编辑**和目标区域的 **Workers Routes 编辑**，或使用有相应权限的 Wrangler 登录。

API Token 文件只含一行 Token，属于部署用户、权限 0600、最多 4 KiB。不要把 Token 写进命令参数、文档或 Git：

```sh
mkdir -p secrets
chmod 700 secrets
# 用自己的私有编辑器创建 secrets/cf_token 并保存 Token
chmod 600 secrets/cf_token
```

权限名称以 Cloudflare 控制台为准。403 时核对账户、区域和读／写范围；能列出资源不代表能创建或修改资源。[Tunnel API 官方流程](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)

## 自动配置单节点

新部署选择一种工作区模式，例如纯终端：

```sh
npm run deploy -- --mode terminal --install-deps --enable-linger \
  --domain desk.example.com --zone example.com
```

桌面模式使用 `--mode desktop`。已有部署保留原模式，可省略 `--mode`、系统依赖和 linger 选项：

```sh
npm run deploy -- --domain desk.example.com --zone example.com
```

命令安装固定版本 cloudflared，准备专用 Tunnel 和本机配置，确认面板、宿主及文件服务就绪后再发布 DNS。已有无关 DNS 或 Tunnel 会被拒绝，不自动覆盖。API Token 默认从 `secrets/cf_token` 读取，可追加 `--api-token-file /自己的私有文件`。

完成后通过 `https://desk.example.com` 登录，账号密码位于本机 `secrets/credentials.txt`。本机配置为 HTTPS 后，登录也应使用 HTTPS 域名；不要用 localhost 的明文页面代替公网验收。

## 手动接入已有 Tunnel

如果希望通过 Cloudflare 控制台创建资源，可不在节点保存 API Token：

1. 部署所选模式。新目录可使用 `npm run deploy -- --mode terminal --origin https://desk.example.com`；已有部署在私有编辑器中将 `.env` 的 `PUBLIC_ORIGIN` 改为同一 HTTPS 根地址。
2. 在自己的账户创建或选择该节点专用的远程管理 Tunnel，为 `desk.example.com` 配置公开主机名。
3. 将 Tunnel 上游设置为面板的私有 Unix socket。下面命令会打印本机实际上游，不需要照抄其他人的 UID 或运行路径。
4. 将该 Tunnel 的运行 token 用私有编辑器保存为 `secrets/tunnel_token`，权限设为 0600，然后运行下方启动命令。

打印该节点的私有上游：

```sh
node --input-type=module -e 'import {maintenanceSettings} from "./native/config.mjs"; console.log("unix:" + maintenanceSettings().tunnelSocket)'
```

使用与 systemd 用户服务一致的 `XDG_RUNTIME_DIR`。不要为 VNC 开放公网端口，也不要将 Tunnel 指向不可信的本地代理。

```sh
chmod 600 secrets/tunnel_token
npm run native:cloudflared
systemctl --user restart codex-cloud-panel.service
npm run native:tunnel
```

面板和 helper 仍保持回环监听，Tunnel 经私有 socket 接入。手动方式与 API 自动方式选择其一管理同一入口，避免相互覆盖配置。

## 可选的 Access 与直连

- **Access**：可在自己的 Cloudflare One 中配置 Self-hosted 应用，仅允许指定身份。它增加外层登录，工作台自身认证仍保留。固定网关的后端不能被交互式 Access 登录页截住，详见[网关限制](gateway.md#与-access-组合)。
- **WebRTC**：默认尝试直连，失败回退 HTTPS／WSS；也可在 `.env` 设置 `WEBRTC_ENABLED=0` 后重载面板。浏览器到 Cloudflare 的 IPv4／IPv6，与主机到 Cloudflare、浏览器到节点的直连路径分别判断，见[网络说明](lan.md)。
- **HTTPS**：在 Cloudflare 开启 Always Use HTTPS。项目的 HTTPS 响应发送 HSTS，私有入口保留 Host、Origin、CSRF 与身份检查。

## 验收与排查

```sh
curl -fsS --max-time 15 https://desk.example.com/healthz
curl -fsS --max-time 15 https://desk.example.com/readyz
npm run native:status
journalctl --user -u codex-cloud-tunnel.service -n 50 --no-pager
```

`/readyz` 应返回 `ok`、`host`、`files` 均为 true。再从另一网络登录，确认终端／桌面和文件功能。进程显示 active 不能代替公网验收。

| 现象 | 优先检查 |
| --- | --- |
| Host／Origin 错误 | 浏览器地址与 `PUBLIC_ORIGIN` 是否完全一致 |
| 1033 或 Tunnel 未注册连接 | Tunnel token、DNS 解析、出站网络及近期连接日志 |
| 页面可用、画面或终端不通 | WebSocket、Access 策略、宿主是否就绪 |
| 直连不可用、中转可用 | [UDP 与网络诊断](lan.md)，无需因此重装桌面 |
| 准备或发布中断 | [域名维护与恢复](dns-switch.md)，先核对记录再继续 |

DNS、Tunnel 地址族和协议选项见[配置参考](deployment-config.md)。

[文档目录](README.md) · [部署选择](deployment.md) · [维护排障](operations.md)
