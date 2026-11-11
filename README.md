# Codex on Cloud

把自己的 Linux 主机变成浏览器工作台，在电脑、平板或手机上使用终端、图形桌面和 Codex。任务运行在节点主机上，关闭网页或网络重连后继续保留；重新连接不会自动提交提示词或审批。

项目以普通 Linux 用户运行，无需 Docker，每套工作台面向一位管理员。每位部署者使用自己的主机、域名、账户和凭据，部署不依赖作者的服务。

## 选择部署组合

先选工作区模式，再选访问入口，可按需增加文件中转、屏幕锁、临时账号、TCP / 串口映射和 WebRTC。

| 工作区模式 | 提供的能力 |
| --- | --- |
| `desktop`，默认 | XFCE 桌面、网页终端、多终端、文件中转；安装检查需要 Codex CLI |
| `terminal` | 纯网页终端、多终端、文件中转；不安装图形组件，Codex CLI 可选 |

两种模式都支持以下入口，多节点可混合接入不同模式：

| 访问入口 | 准备什么 | 浏览器访问 |
| --- | --- | --- |
| 本机 / SSH 转发 | Linux 节点，远程时需 SSH | `http://localhost:36080` |
| [Cloudflare 单节点](docs/cloudflare.md) | 自己的 CF 账户、域名、Tunnel | 节点的独立 HTTPS 域名 |
| [Cloudflare 网关](docs/gateway.md) | Worker / DO、固定域名、每节点独立后端与 Tunnel | `/__nodes/` 选择全局默认节点 |
| [自建中转中心](docs/selfhost-server.md) | 一台 Ubuntu 24.04 公网服务器和一个域名 | 首页列出节点，按 `/node/<slug>/` 分别访问 |

Cloudflare 网关切换全局默认节点；自建中心为各节点保留固定路径，可分别打开。两种方案都不迁移任务或文件。完整组合、命令和可选能力见[部署选择](docs/deployment.md)。

## 快速安装一个节点

准备支持 systemd 用户服务的 Linux、Node.js 22+ / npm 和 Python 3.8+。工具版本及 PATH 见[节点工具与依赖](docs/node-prerequisites.md)。桌面模式需先安装自己的 Codex CLI；实际使用 Codex 时自行完成登录，安装器不代为安装或修改 Codex 配置。

```sh
git clone https://github.com/ptpt52/codex-on-cloud.git
cd codex-on-cloud
```

以普通用户选择一条命令：

```sh
# 完整桌面，包含网页终端
npm run deploy -- --mode desktop --install-deps --enable-linger

# 或：纯网页终端
npm run deploy -- --mode terminal --install-deps --enable-linger
```

系统依赖已齐可省略 `--install-deps`；不需要无人登录运行时可省略 `--enable-linger`。仅这两项按需使用 sudo；它们不安装 Node、Go 或 Codex。

访问 `http://localhost:36080`，在部署主机的私有文件 `secrets/credentials.txt` 查看账号密码。远程主机可先在自己的电脑运行：

```sh
ssh -N -L 36080:127.0.0.1:36080 user@your-server
```

面板和 helper 保持回环监听，VNC 使用私有 Unix socket，无需向公网开放 36080 或 VNC 端口。

## 接入自己的域名

按实际需要选择一种主入口：

- **Cloudflare 单节点**：将自己的 API Token 私有保存到 `secrets/cf_token`（0600），执行 `npm run deploy -- --domain desk.example.com --zone example.com`。权限与无 API Token 的手动方式见[Cloudflare 接入](docs/cloudflare.md)。
- **Cloudflare 多节点**：按[网关部署](docs/gateway.md)建立固定入口，再登记各节点；日常网页切换不使用 CF 管理 Token。已有独立域名按[迁移流程](docs/gateway-migration.md)接入。
- **已有自建中心**：节点按[接入说明](docs/selfhost-node.md)领取 key、运行 `server:join`，不需要 CF 账户或每节点独立证书。需要自己提供中心时，先看[中心部署](docs/selfhost-server.md)。

所有示例域名、IP 和用户名都需替换。TCP / 串口助手在最终入口接入后构建，构建需固定 Go 1.26.4，见[助手发布](docs/forward.md#构建)。

## 使用与维护

[使用工作台](docs/usage.md) · [文件中转](docs/files.md) · [访问权限](docs/access.md) · [端口映射](docs/forward.md) · [日常维护](docs/operations.md)

粘贴与 Enter 分开操作，终端粘贴使用 Ctrl+Shift+V。普通更新保留任务宿主；面板重启会结束内存端口映射，需重新配对。仅前端资源更新可热发布，文档变更无需重启服务。

已有部署不能通过重复安装在线转换工作区模式。工作台拥有部署用户的本机权限，不提供文件系统沙箱；同一域名下的多节点必须相互信任。真实凭据、工作区和运行状态不进入 Git。

[完整文档目录](docs/README.md) · [配置参考](docs/deployment-config.md) · [架构与安全边界](docs/architecture.md) · [测试与验证](docs/verification.md)
