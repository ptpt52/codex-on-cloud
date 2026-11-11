# 部署配置清单

服务器配置保存在项目根目录 `.env`，由 `npm run setup` 首次生成；已有文件在重复部署时保留。进程环境变量优先于 `.env`。示例见 [`.env.example`](../.env.example)。密钥单独保存在 `secrets/`，不要提交真实配置、凭据、工作目录或运行状态。

## 终端数量

```dotenv
# 包含主终端；不包含 codex-host 内部保活会话
MAX_TERMINALS=8
```

默认 4，支持 1–8 的整数，桌面与纯终端模式共用。8 表示一个主终端和最多七个辅助终端。这个值限制创建数量，不预先创建终端；非法配置使启动检查失败，不静默忽略。

修改后执行：

```sh
systemctl --user restart codex-cloud-manager.service codex-cloud-panel.service
```

保存网页草稿后刷新。manager 和 panel 重启保留私有 tmux 中的任务；不要为调整名额重启 terminal 或 desktop 宿主。调低上限时，已存在的终端继续列出、可选择和使用，直到用户自行退出；总数达到新上限时禁止新建。面板重启后，一次性映射需重新配对，常驻助手按保存规则重建映射，旧 TCP 由客户端重连。

从仅支持四个固定槽位的旧桌面版本首次升级时，还需先执行 `systemctl --user restart codex-cloud-actions.service`，让桌面执行服务加载八个槽位，再重启上面的 manager 和 panel。actions 重启会关闭它持有的图形终端窗口，私有 tmux 任务继续运行；在终端管理中重新打开窗口即可附加原任务，不要重新提交原命令。纯终端部署没有 actions 服务；已升级的桌面部署以后只调整 `MAX_TERMINALS` 时，也不需要再次重启 actions。

## 服务器部署项

下表的 panel、manager、terminal、desktop、actions、tunnel 对应 `codex-cloud-名称.service`。重启宿主（terminal / desktop）会结束其任务，路径、模式和宿主显示参数应安排维护后调整。

| 配置项 | 默认 / 取值 | 修改后的生效范围 |
| --- | --- | --- |
| `DEPLOY_MODE` | `desktop` / `terminal`，默认 desktop | 新部署选项。已有部署不能靠改文件在线转换；安装器拒绝自动切换，需单独迁移 |
| `MAX_TERMINALS` | 4；1–8，包含主终端 | 重启 manager、panel；不重启任务宿主 |
| `PUBLIC_ORIGIN` | `http://localhost:36080`；HTTP(S) 根地址 | 重启 panel；公网入口还需同步 Cloudflare 路由/DNS，网关节点需保持固定入口一致 |
| `ALLOWED_HOSTS` | 空；额外精确 Host 列表，不带协议，可带端口，逗号分隔 | 重启 panel；不支持通配符，主入口 Host 已自动允许。HTTPS 主入口下，列表内的 HTTPS 同源请求也可登录；网关节点可借此保留独立域名，但不要加入私有 backend Host |
| `ADMIN_USER` | `admin` | 重启 panel；密码另走密码管理流程 |
| `PANEL_PORT` | 36080；1024–65535 | 重启 panel，并更新本机允许入口；新 Tunnel 使用私有 Unix socket，无需随 TCP 端口修改；旧 TCP 上游需同步 |
| `AGENT_PORT` | 36902；1024–65535 | 兼容旧助手端口；新安装文件服务默认使用此值，显式 FILE_AGENT_PORT 优先 |
| `FILE_AGENT_PORT` | 默认跟随 `AGENT_PORT`；1024–65535 | 独立文件服务端口，重启 files 和 panel 生效；宿主健康由 manager 独立探测。旧活动宿主升级需选择空闲端口保留旧助手，失败不回退旧文件接口，两端口均禁止正向映射 |
| `WORKSPACE_DIR` | `./workspaces`，相对项目根目录 | 任务工作目录和文件中转根目录；需维护宿主及相关服务，已有任务不自动迁移 |
| `RUNTIME_DIR` | `$XDG_RUNTIME_DIR/codex-on-cloud`，无此变量时用 `data/runtime/codex-on-cloud` | 私有 socket、锁、Xauthority 所在目录；需维护宿主和全部关联服务，不能在线搬移 |
| `TZ` | 安装器写入 `Asia/Shanghai` | 重启需要使用新时区的服务；已有 shell 自身环境保持 |
| `WEBRTC_ENABLED` | 1；0 / 1 | 重启 panel；关闭后使用 HTTPS / WebSocket 中转 |
| `WEBRTC_LAN_ADDRESS` | 自动选择私有 IPv4 | 重启 panel；多网卡时固定已分配的私有 IPv4 |
| `WEBRTC_IPV6` | 1；0 / 1 | 重启 panel，控制公网 IPv6 直连 |
| `WEBRTC_IPV6_ADDRESS` | 自动选择公网 IPv6 | 重启 panel；可固定本机已分配的公网 IPv6 |
| `WEBRTC_STUN_URL` | `stun:stun.cloudflare.com:3478`；空值关闭 | 重启 panel；用于浏览器地址发现，仍受候选过滤约束 |
| `TCP_FORWARD_PORTS` | `*`；或最多 16 个逗号分隔端口；空值禁用 | 重启 panel；管理端口始终排除 |
| `TUNNEL_EDGE_IP_VERSION` | `auto` / `4` / `6` | 重启 tunnel，影响与 Cloudflare 边缘的连接 |
| `TUNNEL_PROTOCOL` | `auto` / `quic` / `http2` | 重启 tunnel |
| `TUNNEL_DNS_SERVERS` | 空；最多 3 个 DNS IP，逗号分隔 | 重启 tunnel；需可用的 user/mount namespace，仅覆盖 Tunnel 的 DNS |
| `TUNNEL_METRICS_PORT` | 36903；1024–65535 | 重启 tunnel、panel；诊断继续仅监听回环 |
| `DISPLAY_NUMBER` | 93；10–199，仅桌面模式 | 虚拟显示编号；需维护 desktop、actions、manager、panel |
| `DESKTOP_SIZE` | `1600x3200`；宽高 320–4096，仅桌面模式 | 初始桌面默认值；已有持久化设置优先，日常调整用服务器桌面设置 |

运行中的服务使用启动时捕获的环境。`npm run native:*` 等维护命令以持久 `.env` 为权威，并忽略旧 Codex 终端继承的部署变量；只有不存在 `.env` 的隔离测试才使用显式环境。修改 `.env` 后应按对应服务重新加载。

部署锁与子进程监督的实现见[架构参考](architecture.md#维护命令与有界状态)。

`PORT` 是面板底层兼容覆盖项，优先于 `PANEL_PORT`；普通部署统一使用 `PANEL_PORT`，避免同时配置。`PATH`、`HOME`、`XDG_RUNTIME_DIR` 等属于宿主运行环境，systemd unit 安装时会固定可执行路径；更换 Node 安装位置后需重新生成 unit。Node、Codex、cloudflared、前端库及端口映射助手版本分别由宿主工具、安装脚本和锁文件管理；旧 `.env` 的 `CODEX_VERSION` 不控制原生部署升级。

## 接入命令管理的入口配置

以下字段由 `gateway:join`、`server:join` 及对应恢复流程维护。它们必须与私有节点配置一致；不能只手动改一个字段来切换中心、域名或节点身份。

| 配置项 | 用途 |
| --- | --- |
| `NODE_ID` | 固定 32 位十六进制节点身份，用于请求、会话、草稿与下载校验 |
| `SHARED_ENTRY` | Cloudflare 共享根入口为 `1`；自建路径入口由接入命令写为 `0` |
| `ENTRY_BASE_PATH` | 默认 `/`；自建节点为 `/node/<slug>/`，资源与 API 均保留此前缀 |
| `SELFHOST_NODE_CONFIG_FILE` | 自建节点凭据配置，接入命令写入 `./data/selfhost-node/connection.json` |
| `SELFHOST_CA_FILE` | 私有中心 CA 的本地公共证书路径；公共 CA 场景可为空 |

已有独立 CF 域名并入网关见[迁移流程](gateway-migration.md)，自建节点重新授权、切换或退出见[节点维护](selfhost-node.md#重新授权与切换中心)。中心服务器使用独立的 `/etc/codex-selfhost` 配置，不读取节点的 `.env` 作为自己的管理配置。

## 密钥、系统配置与持久化设置

| 内容 | 所在位置 / 修改方式 | 生效方式 |
| --- | --- | --- |
| 管理员密码 | `secrets/panel_password`，使用 `npm run reset-password` | 按密码重置流程撤销旧授权，不手动复制到 `.env` |
| 内部助手密钥 | `secrets/agent_secret` | panel、manager、helper / actions 必须一致；轮换需维护对应服务 |
| Tunnel 运行凭据 | `secrets/tunnel_token` | 重启 tunnel；不要把 token 放进命令行或日志 |
| Cloudflare API token | 用户指定文件，如 `secrets/cf_token` | 仅供部署/配置 API 使用，不是常驻 Tunnel token |
| Cloudflare 公网域名、DNS 与 Tunnel 路由 | 部署脚本参数及 Cloudflare 账户配置 | 入口配置必须与 `PUBLIC_ORIGIN` 一致 |
| 网关接入、节点目录 | `gateway:join`，`data/gateway-node.json`；目录在网关 DO | 独立持久配置和节点凭据，不属于浏览器偏好 |
| 自建节点身份、CA 与恢复记录 | `server:join` / `server:leave`，私有 `data/selfhost-node/` | 由[接入与恢复流程](selfhost-node.md)维护，不手改凭据 |
| 中心管理员、FRP、TURN 密钥 | 中心服务器 `/etc/codex-selfhost/` | 与节点工作台密码分开，见[中心部署](selfhost-server.md) |
| 屏幕锁、临时账号、设备授权 | 网页对应管理流程 | 按功能立即生效；不直接编辑其运行文件 |
| 共享桌面分辨率 | 服务器桌面设置，`data/desktop-settings.json` | 显式保存和应用；不是浏览器字号/缩放 |
| WSL 镜像网络 | Windows 用户 `.wslconfig` 的 `networkingMode`、`hostAddressLoopback` | 部署会检查/补齐 loopback；需保存任务后重启 WSL |
| 开机运行 | systemd user enable、loginctl linger，WSL 发行版启动 | 宿主系统部署配置；不由网页的保持亮屏控制 |

## 不属于部署配置的内容

浏览器字号、缩放、宽度适配、网页历史行数、亮屏选择和面板折叠属于当前浏览器，详见 [浏览器偏好](browser-preferences.md)。终端选择和草稿属于当前标签页。连接诊断、控制权、实际亮屏锁和在线状态属于运行状态。

“连接状态”里的服务器 IP / 浏览器端 IP 直连提示也属于当前浏览器；它们随已认证协商发给服务端，作为额外 ICE 候选使用，不写 `.env`，不替换自动发现或部署时选择的监听地址。

每份草稿 32768 字符、每节点最多 9 份；同一标签页最多持久保存 16 个节点、合计 2 MiB。这是浏览器草稿上限，不是中心可接入的节点数上限。文件上传、并发传输、WebRTC 端口与背压等属于代码中的资源或协议边界，不能在 `.env` 中随意设置，详见[文件](files.md)、[网络](lan.md)和[映射协议](forward-protocol.md)。终端保活会话不占 `MAX_TERMINALS` 名额。
