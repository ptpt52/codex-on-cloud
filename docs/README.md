# 文档目录

部署按 **工作区模式 + 主访问入口 + 可选能力** 选择。桌面与纯终端都可搭配本机、Cloudflare 或自建中转入口；每位部署者使用自己的配置和凭据。

## 从这里开始

| 当前任务 | 阅读顺序 |
| --- | --- |
| 第一次安装自己的工作台 | [选择组合](deployment.md) → [准备工具](node-prerequisites.md) → 安装所选模式 → [部署验收](verification.md#自己部署后的验收) |
| 接入管理员已建好的中转中心 | [节点接入与恢复](selfhost-node.md)，无需先安装中心 |
| 用自己的公网服务器统一接入节点 | [中心部署](selfhost-server.md) → [中心管理](selfhost-admin.md) → [节点接入](selfhost-node.md) |
| 用自己的 Cloudflare 域名 | [单节点接入](cloudflare.md)；多节点继续看[网关部署](gateway.md) |
| 维护已有部署 | [更新与排障](operations.md)，按改动范围加载所需服务 |

## 安装与接入

| 文档 | 内容 |
| --- | --- |
| [部署组合](deployment.md) | 工作区、入口的区别，常用组合及安装命令 |
| [节点工具与依赖](node-prerequisites.md) | 固定版本、PATH、Node / Go 与系统依赖的职责 |
| [纯终端模式](terminal-only.md) | 不使用图形栈的节点安装与生命周期 |
| [Windows WSL](wsl.md) | systemd、发行版启动与镜像网络 |
| [Cloudflare 接入](cloudflare.md) | 自己的域名、Token 权限、自动 / 手动 Tunnel |
| [Cloudflare 网关](gateway.md) | Worker / DO、节点登记、网页切换全局默认节点 |
| [独立域名迁入网关](gateway-migration.md) | 保留旧入口、增加私有后端、验收和回滚 |
| [自建中心部署](selfhost-server.md) | Ubuntu 公网服务器、DNS、TLS、端口、更新与恢复 |
| [自建中心管理](selfhost-admin.md) | 公开首页、管理员登录、授权和节点操作 |
| [自建中心节点](selfhost-node.md) | 本机部署、接入 key、重新授权、退出和故障恢复 |

## 日常使用与维护

| 文档 | 内容 |
| --- | --- |
| [使用工作台](usage.md) | 终端标签、重命名、手机输入、显示与节点入口 |
| [浏览器偏好](browser-preferences.md) | 当前设备的显示设置与共享服务器设置 |
| [文件中转](files.md) | 上传下载、同名替换、临时配额、HTTPS / 直连 |
| [屏幕锁与临时访问](access.md) | 权限、密码保存提示、映射保留和后台重置 |
| [终端快捷键](shortcuts.md) | 输入助手的固定按键与程序翻页 |
| [TCP 端口映射](forward.md) | 双向映射、Windows / Mac 助手与构建发布 |
| [串口接入](serial.md) | 本地确认、通信参数与硬件边界 |
| [直连与中转](lan.md) | IPv4 / IPv6、TURN、端口和网络诊断 |
| [维护指南](operations.md) | 更新、状态、日志、备份与故障排查 |
| [配置参考](deployment-config.md) | 配置项、持久化位置与生效服务 |
| [服务恢复](reliability.md) | 浏览器、面板与任务宿主的生命周期 |
| [前端更新](ui-updates.md) | 热发布、版本配套和旧文件助手迁移 |

## 开发与进阶参考

- [架构与安全边界](architecture.md)
- [WebRTC 协议与恢复](network-protocol.md)、[映射协议与发布](forward-protocol.md)
- [测试与验证](verification.md)、[CI](ci.md)、[浏览器兼容性](compatibility.md)
- [旧 DNS 接管](dns-switch.md)：已有单节点入口维护；网页切换优先看对应网关或中心说明。
- [CF IP 延迟排序](cf-latency.md)：独立的路由器工具，与工作台部署无关。
- [历史归档](archive/README.md)：旧测试、特定环境和设计记录，不作为当前安装步骤。

## 文档维护约定

用户操作放在功能指南，协议参数与资源上限放在开发参考；跨页使用相对链接。版本与命令对照锁文件、脚本和当前 CLI，不用某次本机测试数量代表通用兼容性。部署现场域名、凭据、绝对路径和临时产物保存在仓库外，示例统一使用占位值。
