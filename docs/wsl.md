# WSL 部署与直连排障

WSL2 可以运行纯终端或完整桌面服务。网页和协商继续经过 Cloudflare HTTPS；Windows 本机浏览器的 WebRTC 直连使用 Windows 到 WSL 的 UDP。公网网页可用与本机直连可用需要分别验证。

## 部署时自动配置镜像网络

正常执行 `npm run deploy` 时，安装器识别 WSL，并通过 `wslinfo --networking-mode` 查询当前实际网络模式。启用 WebRTC 且网络为 `mirrored` 时，自动在 Windows 当前用户的 `%USERPROFILE%\.wslconfig` 中补齐：

```ini
[experimental]
hostAddressLoopback=true
```

此设置让 Windows 和 WSL 可以通过 Windows 本机已分配的 IPv4 地址互访。镜像网络默认允许 `127.0.0.1` 回环，但通过本机的局域网 IP 访问仍需要此项；WebRTC 默认选择默认路由网卡的局域网地址，因此会遇到“公网网页正常，本机直连 UDP 超时”。无需把 `WEBRTC_LAN_ADDRESS` 改为回环地址，否则其他局域网设备不能通过该候选直连服务器。说明见[微软 WSL 配置文档](https://learn.microsoft.com/windows/wsl/wsl-config#experimental-settings)。

安装器保留其他设置、注释、换行格式和 UTF-8/UTF-16LE BOM；原文件只备份一次到 `.wslconfig.codex-cloud.before-loopback`。配置、固定备份和独占临时文件 `.wslconfig.codex-cloud.tmp` 各最多 64 KiB，临时文件在操作结束后清理。符号链接、FIFO、目录、超限文件及重复的目标节或键会停止自动修改，避免覆盖不明确的配置。已有 `hostAddressLoopback=true` 时重复部署不写文件。

`--check` 只检测，不创建配置或备份；缺少设置时返回失败并提示正常部署自动修复。`--skip-wsl-network` 可跳过此功能；已配置 `WEBRTC_ENABLED=0` 时也跳过。普通 Linux 和 WSL NAT 网络不修改 Windows 配置。无法识别网络模式时明确提示手动检查，不主动切换网络模式或开放防火墙。

## 配置生效与重启电脑

`.wslconfig` 是 WSL 虚拟机配置，修改后需要重启 WSL。部署会提示重启要求，**不会执行 `wsl --shutdown`**：该命令会终止所有发行版中的终端、tmux 和 Codex 任务，已提交的任务不能通过重连恢复。保存工作后，在 Windows PowerShell 执行：

```powershell
wsl --shutdown
wsl -d Ubuntu-24.04
```

发行版名称以 `wsl --list --verbose` 为准。进入安装服务的 Linux 用户后，已启用的用户服务会自动启动；纯终端模式可检查或手动启动：

```bash
systemctl --user status 'codex-cloud-*' --no-pager
systemctl --user start codex-cloud-{terminal,manager,panel,tunnel}.service
```

Windows 重启后也需先启动 WSL。`loginctl enable-linger` 让用户服务可以在无人登录时运行，但不负责启动 Windows 上的 WSL 虚拟机，systemd 服务本身也不保证 WSL 持续运行。交互使用时保持 Ubuntu 窗口运行；需要 Windows 登录时自动运行，应另行配置有明确生命周期的 Windows 启动任务。项目部署不创建此类后台保活进程或计划任务。[微软 WSL systemd 说明](https://learn.microsoft.com/windows/wsl/systemd)

如果 WSL 未启用 systemd，在 `/etc/wsl.conf` 配置 `[boot]` 下的 `systemd=true`，保存任务并重启 WSL 后，再安装用户服务。若 `sudo -n true` 提示需要密码，可在交互终端授权系统依赖安装及 `--enable-linger`；Node、项目依赖和普通服务操作仍以 Linux 普通用户运行。

## 本次部署遇到的问题

| 现象 | 原因与处理 | 验证边界 |
| --- | --- | --- |
| 系统 Node.js 为 18，安装器需要 22+ | 使用固定 Node.js 24.22.2，校验官方 SHA-256，安装到被 Git 忽略的项目私有目录；部署前将其 `bin` 加入 PATH | 服务捕获该 Node 的绝对路径及 PATH；Codex CLI 只查询版本，不改登录或配置 |
| 纯终端环境没有图形依赖 | 选择 `--mode terminal`，系统依赖只需已有 tmux/Python，生产 npm 安装省略 noVNC 和开发依赖 | 不用为终端运行安装 Xvfb、XFCE 或浏览器测试工具 |
| HTTPS 和 WSS 正常，本机 Chrome 一直使用中转 | WSL 镜像网络未开启 `hostAddressLoopback`，Windows 到 WSL 局域网地址的 UDP 超时，回环地址的 UDP 正常 | 补齐配置并经用户确认重启后，两条 UDP 路径均收到回复；真实 Windows Chrome 的 ICE/DTLS 连接成功、DataChannel 打开 |
| 重启后先显示“尚未检测”，随后出现一次“直连协商请求超时” | 页面先显示中转并后台探测；该超时表示 HTTPS 协商尚未完成，不能据此判断 UDP 仍被阻断 | 保留中转并等待后续自动探测，用户最终确认同机 Chrome 的实际终端已直连；没有因此放宽鉴权或修改协商时限 |
| 服务显示 active，仍无法确认公网可用 | systemd 状态只说明进程运行；需分别检查 Tunnel 活动连接、HTTPS 健康、登录与 WebSocket | 实际 Cloudflare HTTPS、认证和两次终端 WSS 连接通过，重连保留同一个 shell；不等同于另一台设备直连通过 |
| 纯终端安装运行全量测试，一个桌面资源用例返回 404 | 该用例依赖终端模式刻意省略的 noVNC | 在隔离源码副本安装完整测试依赖后验证，不对运行中的终端部署执行 `npm ci` |

使用项目私有 Node 时，先确认版本并让部署服务捕获其路径：

```bash
export PATH="$PWD/data/host-tools/node-v24.22.2-linux-x64/bin:$PATH"
node --version
npm run deploy -- --mode terminal
```

示例适用于已安装该固定 Linux x64 版本的项目；其他架构使用相应目录。运行中的服务依赖该目录，维护 Node 路径后重新运行 `npm run native:install` 刷新 unit，不因维护工具路径重启终端任务。

## 直连检查顺序

当前原生部署默认启用并发连接：登录并取得控制权、终端页面完成初始化后，立即同时安排 WSS 中转连接和 WebRTC 探测，不等待中转成功后才探测。直连通过两次加密往返和至少 1.5 秒稳定检查，再等待输入空闲后切换；页面隐藏或离线时暂停新探测。诊断中的“尚未检测”目前表示尚无成功或失败结果，进行中的探测也会显示这句话，不能据此推断没有发起协商。

1. 先确认域名的 `/healthz`、登录与中转终端可用，分开定位 Cloudflare 链路和本机 UDP。
2. 查看网页“连接状态”的完整回退原因，区分协商请求超时、ICE/UDP 超时和 DTLS/数据通道超时。
3. 在 WSL 中运行 `wslinfo --networking-mode` 和 `ip -brief address`。镜像网络下对比 Windows 到 WSL 的回环与局域网地址 UDP 往返；TCP 或 ping 成功不能代替此检查。
4. 镜像网络配置变更并重启后刷新页面，观察实际选中路径。若仍失败，再检查 Chrome 站点的本地网络权限（浏览器提供此项时）及 Windows/Hyper-V 防火墙的 UDP 40000–40015；不要通过关闭整个防火墙排障。
5. 用真实浏览器确认 ICE、DTLS 均为 connected 且数据通道打开。独立测试通道的握手成功只验证该网络和传输，不代表已操作生产终端；另一台 LAN 设备、手机蜂窝网络和公网 IPv6 分别验收。

新增自动配置的测试使用临时 Windows 配置文件和模拟的系统探测命令，覆盖检测分支、只读检查、备份、编码、幂等及特殊文件拒绝；不能将这些单元测试记为实际 Windows 网络修复。上表的 Windows UDP、Chrome 握手和 Cloudflare 结果来自单独的真实部署检查。本次环境没有公网 IPv6，相关测试按条件跳过。
