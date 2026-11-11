# 文档目录

部署由三部分组成：**工作区模式 + 访问入口 + 可选能力**。先选择组合，再按需要阅读对应说明。

## 安装与接入

| 需要做什么 | 阅读 |
| --- | --- |
| 比较模式、选择组合、复制安装命令 | [部署组合](deployment.md) |
| 首次准备 Node/Go、修复 PATH、完成助手发布 | [节点工具与依赖](node-prerequisites.md) |
| 使用自己的 Cloudflare 账户、域名或已有 Tunnel | [Cloudflare 接入](cloudflare.md) |
| 用一台公网 Ubuntu 服务器和 `/node/<slug>/` 路径接入多个节点 | [独立公网服务器](selfhost-server.md) |
| 多台机器共用固定域名，从网页选择节点 | [固定域名网关](gateway.md) |
| 把已有独立域名迁为固定网关下的节点 | [网关节点迁移 SOP](gateway-migration.md) |
| 了解纯终端模式的依赖和边界 | [纯终端模式](terminal-only.md) |
| 在 Windows 的 WSL 中部署 | [WSL](wsl.md) |

## 使用与维护

| 需要做什么 | 阅读 |
| --- | --- |
| 终端、桌面、手机输入与文件中转 | [使用指南](usage.md) |
| 更新、状态、日志、密码和故障排查 | [维护指南](operations.md) |
| 查找部署参数和生效范围 | [配置参考](deployment-config.md) |
| 设置屏幕锁或临时访问 | [访问权限](access.md) |
| 配置自己的浏览器显示偏好 | [浏览器偏好](browser-preferences.md) |
| 使用终端快捷键 | [快捷键](shortcuts.md) |

## 可选功能

- [WebRTC 直连与回退](lan.md)：网络条件允许时使用直连，失败后回到现有中转。
- [TCP 端口映射](forward.md)：本机访问服务器，或让服务器访问本地设备。
- [串口接入](serial.md)：经本地助手授权访问串口设备。
- [CF IP 延迟排序](cf-latency.md)：独立的路由器工具，不是工作台安装要求。

## 开发与进阶维护

- [架构与安全边界](architecture.md)
- [服务生命周期与恢复](reliability.md)
- [前端更新](ui-updates.md)
- [测试与验证](verification.md)、[CI](ci.md)、[浏览器兼容性](compatibility.md)
- [旧 DNS 接管方式](dns-switch.md)：已有部署的维护选项，网页多节点切换使用固定网关。

所有 `example.com`、`user@your-server` 均需替换为自己的配置。文档没有要求使用某个现成域名、作者账号或共享 Token。

[历史记录与未实施方案](archive/README.md)只供追溯，不作为安装说明。
