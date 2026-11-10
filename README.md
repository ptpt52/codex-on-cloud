# Codex on Cloud

将自己的 Linux 电脑变成浏览器工作台，在电脑、平板或手机上使用终端和 Codex。支持完整桌面与纯网页终端，可使用本机入口、自己的 Cloudflare 域名，或固定网关切换多台机器。

每位部署者使用自己的主机、域名、Cloudflare 账户和凭据。项目不依赖作者的部署服务。应用以 Linux 普通用户运行，无需 Docker；关闭网页或网络重连后，原任务继续运行。

## 选择组合

工作区模式与访问入口独立选择：

| 工作区 | 本机／SSH | Cloudflare 单节点域名 | 固定域名网页切换多节点 |
| --- | --- | --- | --- |
| 完整桌面，包含网页终端 | 支持 | 支持 | 支持 |
| 纯网页终端，无图形组件 | 支持 | 支持 | 支持 |

WebRTC 直连、Cloudflare Access 和 TCP 端口映射按需添加，不要求全部启用。多节点网关可以混合接入桌面和纯终端节点。

先看[部署组合与命令](docs/deployment.md)，或按下面步骤安装一个本机工作台。

## 快速开始

准备支持 systemd 用户服务的 Linux、Node.js 22+。Ubuntu/Debian 可由安装命令补齐系统依赖。使用 Codex 时，预先安装并登录自己的 Codex CLI；纯终端模式可以不安装 Codex。

```sh
git clone https://github.com/ptpt52/codex-on-cloud.git
cd codex-on-cloud
```

选择一条安装命令，以普通用户执行：

```sh
# 完整桌面，含网页终端
npm run deploy -- --mode desktop --install-deps --enable-linger

# 或：纯网页终端
npm run deploy -- --mode terminal --install-deps --enable-linger
```

系统依赖已齐时省略 `--install-deps`；不需要退出登录后继续运行时，可省略 `--enable-linger`。这两个选项会使用 sudo，其余步骤以当前用户运行。

访问 `http://localhost:36080`，在本机私有文件 `secrets/credentials.txt` 查看账号密码。远程主机可先通过 SSH 转发：

```sh
ssh -N -L 36080:127.0.0.1:36080 user@your-server
```

面板保持回环监听，不需要对公网开放 36080 或 VNC 端口。

## 使用自己的域名

以下 `desk.example.com`、`example.com` 都是占位示例，请替换为自己 Cloudflare 账户内的主机名和区域。

在本机私有编辑器中将 API Token 保存到 `secrets/cf_token`，权限设为 0600，然后执行：

```sh
npm run deploy -- --domain desk.example.com --zone example.com
```

此命令沿用已经选定的工作区模式。新部署可加 `--mode desktop` 或 `--mode terminal`，按需要组合 `--install-deps --enable-linger`。

自动配置会创建专用 Tunnel 和 HTTPS 入口。Token 权限、手动接入已有 Tunnel 的方式见[Cloudflare 接入](docs/cloudflare.md)。

需要多个节点共用一个浏览器地址时，增加[固定域名网关](docs/gateway.md)。网页从 `/__nodes/` 切换节点，日常切换不使用 CF 管理 Token，也不修改 DNS。

## 使用与维护

- 每个终端是独立 shell，按需运行自己的程序；不会自动启动 Codex 或重新提交输入。
- 粘贴与 Enter 分开，手机输入助手也遵守这一规则。
- 文件中转、临时账号、终端标签与端口映射见[使用指南](docs/usage.md)。
- 更新、查看状态、密码重置与故障处理见[维护指南](docs/operations.md)。

已有部署会保留模式、密码和配置；完整桌面与纯终端模式不能通过重复安装直接转换。普通更新保持任务宿主运行，但面板重启会结束内存中的端口映射，需要重新配对。

工作台拥有部署用户的本机权限。它隔离虚拟显示与观看连接，不隔离该用户的文件系统；每套部署面向一位管理员，临时账号提供有限授权。密钥、运行状态和工作区均不进入 Git。

[完整文档目录](docs/README.md) · [配置参考](docs/deployment-config.md) · [开发与验证](docs/verification.md)
