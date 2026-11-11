# Windows WSL 部署

服务端在 WSL 的 Linux 环境中运行，Windows 浏览器作为客户端。需要启用 systemd，并使用普通 Linux 用户和满足要求的 Node.js；工作区模式和入口仍按[部署组合](deployment.md)选择。

## 安装与启动

在 WSL 中克隆仓库，选择完整桌面或纯终端：

```sh
npm run deploy -- --mode terminal --install-deps --enable-linger
```

桌面部署改为 `--mode desktop` 并准备自己的 Codex CLI。登录信息在 WSL 内的 `secrets/credentials.txt`。Windows 本机可访问 localhost，公网访问按自己的[CF 域名](cloudflare.md)、[Cloudflare 网关](gateway.md)或[自建中心](selfhost-node.md)接入。

linger 使用户服务可在 Linux 用户退出后运行，但不会保证 Windows 启动时自动启动该 WSL 发行版。主机或发行版重启会结束原进程；需要自动启动发行版时，由部署者设置自己的 Windows 启动方式。

## 镜像网络与直连

镜像网络中，安装器会检查并按需补齐当前 Windows 用户 `.wslconfig` 的 `hostAddressLoopback=true`，保留备份。配置需要保存任务后重启 WSL 才生效；安装器不自动关闭或重启发行版。

- `npm run deploy -- --check` 只检测，不修改 Windows 配置。
- `--skip-wsl-network` 保留现有配置，不执行自动调整。
- 未使用镜像网络时，不要仅为工作台盲目切换网络模式。直连不可用时仍可使用中转。

WSL 与 Windows 的配置和可用模式由系统版本决定，项目不替用户升级系统或安装／替换 Node。

## 检查顺序

1. 先确认登录和 HTTPS／WSS 中转正常，再排查直连。
2. 查看“连接状态”的回退原因，区分协商请求失败和 UDP／DTLS 失败。
3. 核对 WSL 网络模式、网卡、Windows 浏览器权限和所选节点的 UDP 40000–40015 可达性。
4. 对另一台局域网设备、蜂窝网络与公网 IPv6 分别验收；TCP 或 ping 成功不代表 UDP 直连成功。

更多网络选项见[直连说明](lan.md)。测试中的 Windows 配置替身不等于 Windows／DrvFS 真机验收，见[验证范围](verification.md)。
