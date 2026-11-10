# 选择部署组合

先选工作区，再选入口，最后添加可选功能。选择入口不会改变终端任务所在的机器。

## 1. 工作区模式

| 模式 | 提供什么 | 额外依赖 | 适合 |
| --- | --- | --- | --- |
| `desktop`，默认 | XFCE 桌面、网页终端、多终端、文件中转 | Xvfb、x11vnc、XFCE、Xterm、X11 工具；安装检查需要 Codex CLI | 需要图形程序或完整桌面 |
| `terminal` | 网页终端、多终端、文件中转 | tmux、Python、util-linux；Codex CLI 可选 | 主要运行命令，减少图形组件 |

桌面部署中的“网页终端”是显示视图，可以从页面切换；`--mode terminal` 是安装时的轻量部署形态，没有桌面组件。

模式保存在 `.env`，重复部署沿用；已有部署不能通过 `--mode` 切换模式。如需同时保留两种部署，请使用独立主机或 Linux 用户。

## 2. 访问入口

| 入口 | 需要域名／CF 账户 | 常驻组件 | 浏览器如何访问 |
| --- | --- | --- | --- |
| 本机 | 不需要 | 工作区、面板 | `http://localhost:36080` |
| SSH 转发 | 不需要 CF，需要 SSH 可达 | 与本机相同 | 转发后访问 localhost |
| Cloudflare 单节点 | 自己的域名、区域和 Tunnel | 增加 cloudflared | 该节点自己的 HTTPS 域名 |
| 固定域名网关 | 自己的固定域名、Worker、DO；每节点有独立后端域名和 Tunnel | 每节点 cloudflared，加云端网关 | 同一域名，`/__nodes/` 选择节点 |
| 独立公网服务器 | 一个公网 IPv4 和一个域名，不使用 Cloudflare | 中心服务器运行 Caddy、frps、coturn；节点运行 frpc | 同一域名，`/node/<slug>/` 直接访问各节点 |

固定网关适用于多节点，也可以先接入一台再增加机器。桌面节点和纯终端节点可以混用；任务和文件各自留在原机器。只需要一台机器时，单节点 Tunnel 即可，不要求部署 Worker。

## 3. 常用组合与命令

先克隆仓库并进入目录。以下命令用于新部署；系统包已安装时省略 `--install-deps`，不需要无人登录运行时省略 `--enable-linger`。

### 桌面 + 本机或 SSH

```sh
npm run deploy -- --mode desktop --install-deps --enable-linger
```

访问 localhost。远程主机在自己的电脑运行：

```sh
ssh -N -L 36080:127.0.0.1:36080 user@your-server
```

### 纯终端 + 本机或 SSH

```sh
npm run deploy -- --mode terminal --install-deps --enable-linger
```

入口与上一种组合相同，省去图形组件。

### 桌面 + Cloudflare 单节点

按[Cloudflare 接入](cloudflare.md)准备自己的域名和私有 Token 文件，然后执行：

```sh
npm run deploy -- --mode desktop --install-deps --enable-linger \
  --domain desk.example.com --zone example.com
```

### 纯终端 + Cloudflare 单节点

```sh
npm run deploy -- --mode terminal --install-deps --enable-linger \
  --domain desk.example.com --zone example.com
```

两种组合默认读取 `secrets/cf_token`。也可以通过 Cloudflare 控制台配置 Tunnel，只保存运行凭据；步骤见[手动接入](cloudflare.md#手动接入已有-tunnel)。

### 混合节点 + 固定网关

每台机器先选自己的工作区模式，部署到不同的后端域名。比如：

```sh
# 在节点 A 执行
npm run deploy -- --mode desktop --install-deps --enable-linger \
  --domain node-a.example.com --zone example.com

# 在节点 B 执行
npm run deploy -- --mode terminal --install-deps --enable-linger \
  --domain node-b.example.com --zone example.com
```

再按[网关步骤](gateway.md)将 `desk.example.com` 部署为固定入口，并分别执行 `gateway:join`。每台机器保存自己的 Tunnel token 和接入凭据；日常网页切换不使用 CF 管理 Token。已有 Cloudflare 单节点部署要改为网关节点时，不要重新部署或复用固定入口主机名，按[独立域名迁移 SOP](gateway-migration.md)增加私有后端并在验收后撤下旧入口。

### 独立公网服务器 + 多节点

准备一台 Ubuntu 24.04、公网 IPv4 和域名，按[独立公网服务器部署](selfhost-server.md)安装中心。节点已有本机 Panel 后执行 `server:join`，通过 `/node/<slug>/` 接入。已有 Cloudflare/Gateway 状态默认不会被接管；显式使用 `--switch-existing` 时先保存 Panel 恢复记录，`server:leave` 可恢复原入口配置。

## 4. 按需添加功能

| 功能 | 可以搭配哪些组合 | 如何选择 | 新增要求 |
| --- | --- | --- | --- |
| WebRTC 直连 | 两种工作区、所有入口 | 默认开启；`WEBRTC_ENABLED=0` 可关闭 | 浏览器与节点之间 UDP 可达；失败仍可中转 |
| Cloudflare Access | CF 单节点或固定网关 | 可选的外层登录 | 自己配置 Access 应用与策略，不替代工作台登录 |
| TCP 端口映射 | 两种工作区、所有入口 | 按需配对本地助手 | 提供助手下载时增加 `--build-forward`，构建需 Go 1.26.4 |
| 串口接入 | 两种工作区、所有入口 | 复用本地助手，在设备端逐次授权 | 助手电脑连接串口并具备驱动与设备权限，见[串口说明](serial.md) |
| 屏幕锁／临时账号 | 两种工作区、所有入口 | 在“访问与屏幕锁”中配置 | 不增加常驻组件；临时账号权限有限 |
| 快速切换待命 | 桌面部署 | 浏览器工具中开启，默认关闭 | 同时保留桌面与网页终端查看器，增加资源用量 |

例如“纯终端 + CF 单节点 + 助手下载”：

```sh
npm run deploy -- --mode terminal --install-deps --enable-linger \
  --domain desk.example.com --zone example.com --build-forward
```

开机运行只控制主机服务，不会在重连时自动提交 Codex 指令。主机仍需供电、联网且不休眠。

## 运行环境与独立部署

- 通用安装入口要求 Linux 和 systemd 用户服务，Ubuntu/Debian 支持自动补齐系统包；Windows 可使用启用 systemd 的 [WSL](wsl.md)。Mac/Windows 浏览器可访问部署好的工作台，不是原生服务端安装目标。
- 无 systemd 的托管容器没有通用安装器；需自行配置进程托管、凭据、持久卷与重启策略。历史容器记录位于[归档](archive/README.md)，不等同于受支持的安装组合。
- 每套部署使用自己的仓库目录、Linux 用户、密钥和 CF 资源。默认 systemd 服务名固定，同一 Linux 用户不要运行多套实例。
- 网关默认 Worker 名为 `codex-cloud-gateway`。不同 CF 账户互不影响；同账户需要多套网关时，每次构建后须在各自的私有 `data/gateway-build/wrangler.json` 中将 `name` 改为对应的独立名称，再发布。具体限制见[网关步骤](gateway.md#2-发布到自己的-cf-账户)。
- 自有 VPS 使用 Caddy、frps、coturn 和 systemd，不使用 Docker；公网入口见[独立公网服务器部署](selfhost-server.md)。

配置细项见[配置参考](deployment-config.md)，日常更新与排障见[维护指南](operations.md)。
