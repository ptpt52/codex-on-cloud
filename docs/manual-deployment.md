# 逐步手动部署工作台节点

本页把 `npm run deploy` 的基础安装拆开，供希望逐步执行、检查每一步结果的部署者使用。适用于**新工作台节点**；已有部署按[维护指南](operations.md)更新，自建中心服务器按[中心部署](selfhost-server.md)安装。

系统包命令以 Ubuntu 24.04 为例；其他 Linux 发行版需自行准备等价组件和可用的 systemd 用户服务。

先按[共用检查清单](deployment-checklist.md)确定模式、最终入口和是否需要助手。本页完成本机工作台，域名、网关和自建中继的接入仍在对应指南中完成。每一步成功后再执行下一步。

## 1. 准备用户、源码和工具

按[节点工具与依赖](node-prerequisites.md)准备 Git、Node.js 22+ / npm、Python 3.8+，克隆仓库并进入根目录。需要构建助手时另准备固定 Go 1.26.4；桌面模式还需自行安装 Codex CLI。所有 npm 命令使用部署时的普通 Linux 用户，只有下面的系统包和 linger 命令使用 sudo。

```sh
id -un
node --version
npm --version
python3 --version
systemctl --user is-system-running
```

systemd 返回 `running` 或 `degraded` 时可以继续，`degraded` 的退出码可能是 1，需另查失败服务；`Failed to connect to bus` 表示用户服务尚不可用。使用该用户正常登录或 SSH 登录后重试，不用 sudo 运行后续 npm 命令。WSL 先完成[启用 systemd](wsl.md#先启用-systemd)。

同一 Linux 用户使用固定的服务名，只部署一套工作台。仓库和工具目录需要长期保留，服务会引用其中的绝对路径。

## 2. 选择模式并安装依赖

下面两组选一组，不在同一个目录依次执行两种模式。

### 纯网页终端

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends tmux python3 util-linux
npm ci --omit=dev --omit=optional
npm run setup -- --mode terminal
```

### 完整桌面

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  xvfb x11vnc xfwm4 xfdesktop4 xfce4-panel xfce4-settings xterm \
  tmux xclip xdotool thunar xauth x11-utils dbus fontconfig fonts-noto-cjk python3
npm ci --omit=dev
npm run setup -- --mode desktop
```

桌面模式保留 optional 依赖中的 noVNC；不要使用 `--omit=optional` 或全局禁用 optional 依赖。开发测试需要开发依赖时使用完整 `npm ci`，但不要在已有任务运行期间重装依赖。

两组初始化默认使用 `http://localhost:36080`。新部署若已确定独立 HTTPS 域名，可在所选 `setup` 命令后增加 `--origin https://desk.example.com`；后续按[Cloudflare 手动接入](cloudflare.md#手动接入已有-tunnel)完成入口。新网关或自建节点先保持本机入口，交由 `gateway:join` / `server:join` 写入最终配置。

`setup` 生成 `.env`、私有 `secrets/`、工作区及助手槽位。它**保留已有 `.env` 和密码**；重复传 `--origin`、`--username` 不会修改已有配置，`--mode` 也不能转换已有模式。需要调整新部署配置时，在继续前用私有编辑器核对 `.env`，不要 `source .env`。固定助手 key 已初始化不等于四个平台下载包已构建。

## 3. 检查、安装和启动用户服务

```sh
npm run native:doctor
npm run native:install
```

`doctor` 应通过；缺少组件时按提示补齐。`install` 生成并启用对应模式的 systemd 用户服务，**尚未启动**。后台 Node 和工具路径来自当前安装环境，先确认 PATH 正确。

需要退出 SSH 后和主机启动时继续运行用户服务时执行一次：

```sh
sudo loginctl enable-linger "$(id -un)"
loginctl show-user "$(id -un)" --property=Linger
```

选择启用时应显示 `Linger=yes`。然后启动工作台：

```sh
npm run native:start
npm run native:status
```

保留默认本机入口时检查：

```sh
curl -fsS --max-time 15 http://localhost:36080/readyz
```

首次 `setup` 已指定 `https://desk.example.com` 时，回环检查需使用配置的 Host，不能照用 localhost Host：

```sh
curl -fsS --max-time 15 -H 'Host: desk.example.com' http://127.0.0.1:36080/readyz
```

将 Host 替换为自己配置的域名（有非默认端口时包含端口）。以上只检查本机就绪，不证明公网 HTTPS、Tunnel 或登录可用；完成入口后仍要用实际域名及完整节点路径验收。

`/readyz` 应返回 `ok`、`host`、`files` 均为 true。首次启动尚在准备时可稍后重做此只读检查；持续失败先看对应服务日志，不反复重启任务宿主。

| 模式 | 应运行的核心用户服务 |
| --- | --- |
| `terminal` | terminal、files、manager、panel |
| `desktop` | desktop、actions、files、manager、panel |

表中名称均加 `codex-cloud-` 前缀和 `.service` 后缀。仅本机 / SSH 入口不需要启动 Tunnel。`native:start` 不安装 cloudflared、不配置域名，也不自动提交 Codex 任务。

## 4. 登录并完成最终入口

在部署主机私下查看 `secrets/credentials.txt`；实际地址以 `.env` 为准。浏览器访问 `http://localhost:36080`。若工作台在远程服务器，在**自己的客户端电脑**建立 SSH 转发并保持该命令运行：

```sh
ssh -N -L 36080:127.0.0.1:36080 user@your-server
```

然后在客户端浏览器打开同一个 localhost 地址。不要仅更换 SSH 的本地端口而不核对 Host 配置，见[配置参考](deployment-config.md)。无需在公网放行面板端口或 VNC 端口。

| 最终入口 | 本机就绪后的下一步 |
| --- | --- |
| 本机 / SSH | 保持当前入口，继续验收 |
| 独立 CF 域名，控制台管理 Tunnel | [手动接入已有 Tunnel](cloudflare.md#手动接入已有-tunnel) |
| 独立 CF 域名，API 自动管理 | 按[自动接入](cloudflare.md#自动配置单节点)执行部署命令；已有配置不会仅因传入 `--origin` 而改绑 |
| 固定 CF 网关 | [网关部署与节点登记](gateway.md)，每个节点先有独立 Tunnel 后端 |
| 已有自建中心 | [节点接入](selfhost-node.md#2-使用节点授权接入中心)，不在本机执行中心安装脚本 |

手动步骤没有执行一键部署中的 WSL 网络配置。已使用镜像网络并需要局域网直连时，按 [WSL 指引](wsl.md#镜像网络与直连)核对 Windows 配置；重启发行版前保存任务。

## 5. 助手和最终验收

需要 TCP / 串口助手时，在**最终入口接入完成后**运行 `npm run build:forward`，按[共用清单](deployment-checklist.md#3-需要助手时完成构建与发布)核对四个平台下载、入口、构建及实际使用设备。

```sh
npm run verify:deployment
# 需要助手时使用这一项
npm run verify:deployment -- --forward
```

明确检查工作台账号时增加 `--login`。先看[当前自动验收限制](deployment-verification.md#当前实现的已知限制)，再完成报告和[人工验收表](deployment-checklist.md#4-部署结束前逐项核对)；进程 active 或打开登录页不足以证明部署完成。

后续更新按[维护指南](operations.md)，不重新照本页安装依赖或重启任务宿主。`npm run native:stop` 会停止工作台及其中任务，不用于刷新网页或加载文档。

[文档目录](README.md) · [部署选择](deployment.md) · [共用检查清单](deployment-checklist.md)
