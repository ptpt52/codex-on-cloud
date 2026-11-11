# 日常维护与排障

所有命令在自己的部署目录，以部署时的 Linux 普通用户执行。主机需要保持供电、联网且不休眠。

## 查看状态

```sh
npm run deploy -- --check
npm run native:status
journalctl --user -u codex-cloud-panel.service -n 50 --no-pager
```

`--check` 只检查，不安装、写配置或重启服务。`native:status` 显示服务状态；网页“连接状态”还会检查实际接口就绪情况。

## 更新项目

```sh
git pull --ff-only
npm run deploy
```

普通更新保留已有模式、密码和 `.env`。活动服务的依赖缺失或版本不符时，部署会停止，需安排依赖维护；不要在活动任务中随意运行 `npm ci` 或替换运行时。

部署结果会单独报告端口映射助手下载项的发布状态，请在网页中实际下载核对。需要更新助手时，确认当前入口已接入，再运行 `npm run build:forward`。域名或节点路径变化后，旧产物可能因入口不匹配而不再显示；准备固定 Go 1.26.4 和 PATH 的步骤见[节点工具与依赖](node-prerequisites.md)。

部署不会主动重启桌面或纯终端宿主；面板／管理／文件服务可被更新。面板重启会结束内存中的端口映射，需要重新配对。已经运行的任务宿主脚本要等明确维护重启后才加载新版本。

只有静态界面改动时，可用 `npm run reload-ui` 发布资源，保存草稿后刷新浏览器；详见[前端更新](ui-updates.md)。文档改动不需要重启服务。

网关成员更新节点时省略 `--domain`。网关 Worker 另按[网关更新](gateway.md#更新与恢复)发布，保持自己的账户、Worker 名和 DO 身份一致。

## 密码与配置

```sh
# 交互菜单
npm run reset-password

# 生成新的管理员密码并保存到私有凭据文件
npm run reset-password -- --admin --generate
```

屏幕锁可在网页中管理，忘记时使用 `--screen` 重设或 `--unlock` 关闭。管理员密码重置会撤销相应旧登录；不改变 Codex 登录或任务。完整步骤见[访问权限](access.md#后台密码重置)。

`.env` 不作为 shell 执行。设置项、取值和需要重载的服务见[配置参考](deployment-config.md)。Node 路径变化后重新 `npm run native:install` 生成服务路径，再按维护计划加载；不要直接删除正在使用的运行时目录。

## 备份与迁移

| 内容 | 如何处理 |
| --- | --- |
| `secrets/`、`.env` | 私有保存，属于本部署；不公开或提交 Git |
| `data/` | 包含本部署配置、身份、会话和恢复记录；保持权限，避免复制到另一个独立实例 |
| 工作区 | 保存自己的项目与中转文件；路径由 `WORKSPACE_DIR` 决定 |
| 网关 DO | 目录和默认路由在自己的 CF 账户；本机备份不包含云端状态 |

新部署者应从源码生成自己的配置和密钥。迁移已有实例前明确哪些状态要保留；不要复制作者或他人的 `.env`、Tunnel token、网关身份或认证缓存。运行中的 tmux 进程不能通过复制文件迁移。

不要删除 `data/deploy.lock` 或其他活跃锁文件。空锁可正常存在，租约由内核管理；发布／接入中断时先核对恢复记录，按[域名维护](dns-switch.md)或[网关恢复](gateway.md#更新与恢复)处理。

## 常见故障

| 现象 | 排查方向 |
| --- | --- |
| 无法连接 systemd 用户服务 | 使用部署用户的正常登录会话；WSL 先启用 systemd，无 systemd 容器需自行托管 |
| 本机正常，公网不可达 | [CF 接入](cloudflare.md#验收与排查)，检查 Tunnel 活动连接、域名与外层策略 |
| HTTPS 域名配置后 localhost 登录失败 | Secure Cookie 使用 HTTPS 入口，不要反复重置密码 |
| 显示或终端未就绪 | 看宿主日志；重装面板不会恢复已结束的任务 |
| 直连失败，中转正常 | [网络诊断](lan.md)，分别验证 UDP、HTTPS 与浏览器权限 |
| 面板自动恢复已停止 | 看日志，排除故障后解除失败状态并启动面板 |
| 文件服务单独失败 | 只维护 files 服务，不为此重启任务宿主 |

面板有限恢复耗尽后：

```sh
systemctl --user reset-failed codex-cloud-panel.service
systemctl --user start codex-cloud-panel.service
```

文件服务同理使用 `codex-cloud-files.service`。详细进程关系见[服务生命周期](reliability.md)。

## 显式停止

`npm run native:stop` 会停止本部署。重启 `codex-cloud-desktop.service` 或 `codex-cloud-terminal.service` 会结束其中的任务；先保存工作，再安排此类维护。浏览器关闭和面板重启不等于停止任务宿主。
