# Windows WSL 部署

服务端在 WSL 的 Linux 环境中运行，Windows 浏览器作为客户端。需要启用 systemd，并使用普通 Linux 用户和满足要求的 Node.js；工作区模式和入口仍按[部署组合](deployment.md)选择。

## 先启用 systemd

还没有 WSL 时，在 Windows 管理员 PowerShell 中查看并安装 Ubuntu 24.04，发行版名称以列表为准；已有发行版不重复安装：

```powershell
wsl --list --online
wsl --install -d Ubuntu-24.04
```

按 Windows 提示完成重启，首次打开 Ubuntu 时创建普通 Linux 用户。使用 `wsl --list --verbose` 核对目标发行版的 VERSION 为 2。旧版 WSL 不识别相关命令时按[微软安装说明](https://learn.microsoft.com/en-us/windows/wsl/install)更新 WSL。

在 Linux 内检查：

```sh
ps -p 1 -o comm=
systemctl --user is-system-running
```

PID 1 应为 `systemd`，用户服务应返回 `running` 或 `degraded`。尚未启用时用 `sudoedit /etc/wsl.conf`，保留其他配置，在已有或新增的 `[boot]` 节中设置，不重复添加同名节：

```ini
[boot]
systemd=true
```

保存所有发行版中的任务后，在 Windows PowerShell 执行 `wsl --shutdown`，再打开原发行版并重做检查。该命令会结束所有 WSL 发行版中的进程；不是在 Linux 内运行的服务刷新命令。具体前提与所需系统包见[微软 systemd 说明](https://learn.microsoft.com/en-us/windows/wsl/systemd)。

## 安装与启动

在 WSL 中按[工具说明](node-prerequisites.md)准备 Linux 版 Node/npm、Python 和 Git，再克隆仓库。建议放在 Linux 用户目录（如 `~/src`），使配置权限和 Unix socket 使用 Linux 文件系统语义；不要调用 Windows 安装的 `node.exe` / `npm.cmd`。选择完整桌面或纯终端：

```sh
npm run deploy -- --mode terminal --install-deps --enable-linger
```

桌面部署改为 `--mode desktop` 并准备自己的 Codex CLI。登录信息在 WSL 内的 `secrets/credentials.txt`。Windows 本机可访问 localhost，公网访问按自己的[CF 域名](cloudflare.md)、[Cloudflare 网关](gateway.md)或[自建中心](selfhost-node.md)接入。

不使用一键部署时按[手动部署](manual-deployment.md)完成 npm 依赖、初始化、用户服务安装和启动；只运行 `native:install` 不会启动工作台。

linger 作用于 Linux 用户服务，不负责启动或保活 WSL 虚拟机；仅有 systemd 服务不能保证发行版一直运行，也不会保证 Windows 启动时自动启动发行版，见[微软说明](https://learn.microsoft.com/en-us/windows/wsl/systemd)。主机或发行版重启会结束原进程；需要无人值守时，由部署者设置自己的 Windows 启动 / 保活方式，并实际验证关闭终端后和 Windows 重启后的行为。

## 镜像网络与直连

镜像网络中，安装器会检查并按需补齐当前 Windows 用户 `.wslconfig` 的 `hostAddressLoopback=true`，保留备份。配置需要保存任务后重启 WSL 才生效；安装器不自动关闭或重启发行版。

- `npm run deploy -- --check` 只检测，不修改 Windows 配置。
- `--skip-wsl-network` 保留现有配置，不执行自动调整。
- 未使用镜像网络时，不要仅为工作台盲目切换网络模式。直连不可用时仍可使用中转。

逐步手动安装不会调用上述自动调整。已确认使用镜像网络（可用时运行 `wslinfo --networking-mode` 查看），且需要该能力时，在 **Windows 用户目录**的 `.wslconfig` 中合并以下设置，保留已有其他节和键：

```ini
[experimental]
hostAddressLoopback=true
```

`.wslconfig` 与 Linux 中的 `/etc/wsl.conf` 用途不同，不互相复制；设置后同样需要保存任务、关闭再启动 WSL 才生效。位置与作用域见[微软配置参考](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)。

WSL 与 Windows 的配置和可用模式由系统版本决定，项目不替用户升级系统或安装／替换 Node。

## 检查顺序

1. 先确认登录和 HTTPS／WSS 中转正常，再排查直连。
2. 查看“连接状态”的回退原因，区分协商请求失败和 UDP／DTLS 失败。
3. 核对 WSL 网络模式、网卡、Windows 浏览器权限和所选节点的 UDP 40000–40015 可达性。
4. 对另一台局域网设备、蜂窝网络与公网 IPv6 分别验收；TCP 或 ping 成功不代表 UDP 直连成功。

更多网络选项见[直连说明](lan.md)。测试中的 Windows 配置替身不等于 Windows／DrvFS 真机验收，见[验证范围](verification.md)。

[文档目录](README.md) · [部署选择](deployment.md) · [维护排障](operations.md)
