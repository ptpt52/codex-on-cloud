> 历史归档：本文记录特定时间、环境或未实施方案，不是当前部署指南。请从[文档目录](../README.md)选择部署方式。

# Cloady 免费容器的纯终端部署

可以在 Cloady 的 Void Linux 容器中运行本项目的 `terminal` 模式，不安装 Codex CLI、图形桌面或 noVNC。容器不是带 systemd 的虚拟机；仓库的 `npm run deploy` / `native:install` 仍面向 systemd 用户服务，不能直接用于此模板。本次容器通过单独配置的 runit 服务运行原有后台，没有伪造 Codex 命令或修改 Codex 配置。

## 组件与目录

- 使用普通用户 `cloud`，应用目录为 `/var/lib/codex-cloud/app`。面板及文件助手仅监听 `127.0.0.1`；管理和 tmux 使用独立私有 Unix socket。
- 运行 Bash、tmux、Python、固定版本 Node.js 24.22.2，以及锁文件中的生产依赖：`npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund`。未安装 Codex、Go 或图形组件。终端总数配置为 `MAX_TERMINALS=8`。
- `terminal`、`manager`、`panel` 和 `tunnel` 由独立 runit 服务管理，配置在 `/var/lib/codex-cloud/services`。宿主终端退出后保持停止，不自动创建任务；面板/管理器异常恢复最多每分钟三次，Tunnel 重试间隔十秒。
- 每项服务的日志在 `/var/lib/codex-cloud/logs/名称`，当前文件上限 128 KiB，最多两份轮转。密钥和登录信息在应用的 `secrets/`，权限 0600，不能提交到 Git。
- 公网使用专用 Cloudflare Tunnel，固定 cloudflared 2026.10.0 并校验发行包 SHA256；只向容器复制该 Tunnel 的令牌，不复制 Cloudflare 账户 API token。

## 本次容器的维护命令

以下快捷命令由此次部署现场安装，不是 `npm run deploy` 自动生成的通用容器安装器。进入 Cloady 的 Void 服务终端后执行：

```sh
# 启动独立后台；已运行时不重复启动或重建终端
codex-cloud-start

# 查看四项后台状态
codex-cloud-status

# 仅重启网页面板，保留原终端任务；端口映射需要重新配对
sv restart /var/lib/codex-cloud/services/panel

# 查看面板日志
tail -n 50 /var/lib/codex-cloud/logs/panel/current

# 查看本实例的登录信息（仅在可信终端中执行）
cat /var/lib/codex-cloud/app/secrets/credentials.txt
```

关闭浏览器或 SSH 不会停止后台。不要为了处理面板连接问题重启 `terminal`，它拥有真实 shell 和 tmux 任务。宿主终端因故停止后，排查日志再明确执行 `sv up /var/lib/codex-cloud/services/terminal`，这会创建新 shell，不恢复旧任务或补发输入。

## 平台重启和免费限制

当前 Void Linux 应用模板的容器启动命令固定，不执行本项目的后台启动脚本。**Cloady 容器停止、重启或被平台暂停后，恢复运行还需要在其终端执行 `codex-cloud-start`。本次没有配置平台开机自启。** 数据卷保存代码、配置和工作文件，运行中的进程不会跨容器重启保留。需要自动启动时，应另做带明确入口命令的自定义镜像/Compose 部署并迁移数据，不能仅把原生 systemd unit 写入这个容器。

模板没有发布公网端口，也没有“全部放通”的安全组开关。本次 HTTPS 入口走出站 Tunnel，不代表所有 TCP/UDP 端口已公开；WebRTC 是否直连取决于实际 ICE 协商，不能仅凭域名可访问判断。

免费档的资源和每月用量限制、闲置暂停规则以 [Cloady 免费规则](https://cloady.com/docs/free-tier) 为准；容器/端口发布方式见 [平台概念](https://cloady.com/docs/concepts)。

## 升级到独立文件服务

上面的四项 runit 服务记录的是既有部署。新版 terminal 宿主不再自行启动 Python 助手；容器不能只更新代码再重启 terminal。先增加一项独立 files 服务，以同一普通用户、同一项目工作目录和原环境运行固定命令 `node native/file-agent.mjs`；按现有 manager 的策略限制每分钟最多三次恢复，日志继续使用128 KiB两份轮转。为 files 配置独立空闲的 `FILE_AGENT_PORT`（例如36904），panel 使用同一值；保留旧 terminal 及其关键助手，再更新 manager/panel，检查 `/readyz` 的 host/files 均为 true。files 必须加入本机启动、状态与停止脚本。该容器专用脚本尚需管理员在实际部署中同步维护，本轮代码修复没有操作远端实例。新 Tunnel 可改用同一用户私有 runtime 下的 `tunnel.sock`，具体见 [Cloudflare 部署](../cloudflare.md)。
