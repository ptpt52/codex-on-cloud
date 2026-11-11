# 日常维护与排障

本页命令用于工作台节点：在部署目录，以部署时的普通 Linux 用户执行。主机需保持供电、联网且不休眠。中心服务器的系统服务另按[中心维护](selfhost-server.md#中心安装)操作，使用 sudo；不要把两类安装命令混用。

## 查看状态

```sh
npm run deploy -- --check
npm run native:status
journalctl --user -u codex-cloud-panel.service -n 50 --no-pager
```

`--check` 只检查，不安装、写配置或重启服务。进程 active 不能代替实际入口就绪；网页“连接状态”和入口 `/readyz` 应确认宿主与文件服务均已就绪。

| 入口 | 额外检查 |
| --- | --- |
| CF 单节点 / 网关成员 | Tunnel 状态与 `journalctl --user -u codex-cloud-tunnel.service -n 50 --no-pager` |
| 自建中心的节点 | `npm run server:status`、`npm run server:doctor`，检查完整 `/node/<slug>/` 路径 |
| 自建中心服务器 | 在中心仓库执行 `sudo ./scripts/selfhost-server.sh status` |

## 更新项目

在节点目录执行：

```sh
git pull --ff-only
npm run deploy
```

普通更新保留模式、密码和 `.env`，不会主动重启 desktop / terminal 任务宿主；files、manager、panel 可以更新。面板重启会断开观看连接及旧 TCP；助手使用原 key 重连并重建启用规则。业务客户端需重连，不重放旧字节，桌面与终端原任务保留。

活动服务的依赖缺失或版本不符时，部署停止并保留任务；安排依赖维护，不在活动任务中随意运行 `npm ci` 或替换运行时。宿主脚本的更新需要另行安排明确维护重启，不能靠重装面板加载。

| 更新对象 | 流程 |
| --- | --- |
| CF 单节点工作台 | `npm run deploy` 沿用已有入口；只有要配置 / 改名域名时才使用发布参数 |
| CF 网关成员 | `npm run deploy`，省略 `--domain`；日常更新不改全局默认路由 |
| 自建中心的节点 | `npm run deploy`，省略 Cloudflare 参数；不因遗留旧 Token 启动旧 CF 入口 |
| Cloudflare Worker 网关 | [重新构建并发布原 Worker](gateway.md#更新与恢复)，保持账户、名称和 DO 身份 |
| 自建中心应用 | [重复中心安装命令](selfhost-server.md#中心安装)，沿用原域名、证书模式和参数；失败按恢复记录处理 |
| 仅 HTML / CSS / 浏览器脚本 | `npm run reload-ui`，然后保存草稿并手动刷新；无需重启服务或重新接入助手 |
| 仅仓库文档 | 无需部署服务；自行提供的中心 HTML 帮助页另按[帮助页更新](selfhost-server.md#自定义帮助页)加载 |

前端更新要求后台能力配套，不能让旧后端获得新协议，见[版本配套](ui-updates.md)。

### 端口映射助手

助手代码或入口变化后，在最终节点入口确定的情况下运行 `npm run build:forward`，再在网页核对四个平台下载。构建需固定 Go 1.26.4，单独构建不重启节点；浏览器页面更新不会自动替换用户已下载的 exe / ZIP。

本版按全新安装替换，不迁移旧端口映射配置，操作见[全新替换](forward.md#构建与全新替换)。后台与 0.9.0 助手配套使用；CF 网关还需更新 Worker，支持助手固定到授权节点。持久规则和八个 key 的 secret 在私有 `data/panel/forward-agents.json`，最多 128 KiB，不加入 Git；备份按凭据配置保护。管理员可在对应助手页随时复制或重新生成 key，首次初始化自动生成，普通部署不更换。临时账号能否查看 key 由各助手页的开关分别控制，默认关闭；临时账号的刷新只重新读取当前 key。跨节点不复制此配置，助手与其授权节点绑定。

## 密码与配置

工作台账号、屏幕锁、中心管理员、网关密码和节点接入 key 用途不同。节点的密码维护：

```sh
# 交互选择管理员密码或屏幕锁
npm run reset-password

# 自动生成工作台管理员密码，保存在本机私有文件
npm run reset-password -- --admin --generate
```

忘记屏幕锁可用 `--screen` 重设或 `--unlock` 关闭；重置过程会停止并恢复面板，助手可重连重建规则。完整行为见[后台密码重置](access.md#后台密码重置)。这条命令不重置中心或 CF 网关密码，不改变 Codex 登录。

`.env` 不是 shell 脚本。参数与生效服务见[配置参考](deployment-config.md)。Node 路径变化后重新 `npm run native:install` 生成服务路径，再按维护计划加载；不要删除仍被运行中服务使用的 Node 安装目录。

## 备份与迁移

| 内容 | 如何处理 |
| --- | --- |
| 节点 `.env`、`secrets/` | 私有保存，属于本部署，不公开或提交 Git |
| 节点 `data/` | 设置、身份、会话、恢复记录和产物；保持权限，不直接复制给另一个独立实例 |
| 工作区 | 保存自己的项目及中转文件；根目录由 `WORKSPACE_DIR` 决定 |
| CF 网关 DO | 节点目录与默认路由在自己的 CF 账户，本机备份不包含云端状态 |
| 自建中心 | 私有配置与授权状态独立于节点工作区，见[中心部署](selfhost-server.md) |

新实例从源码生成自己的配置和密钥，不复用作者或其他部署者的凭据。复制文件不能迁移运行中的 tmux 进程。已有入口迁移使用[CF 网关迁移](gateway-migration.md)或[自建节点流程](selfhost-node.md#重新授权与切换中心)。

不要删除 `data/deploy.lock` 或其他活跃锁文件。空锁可以正常存在；发布 / 接入中断时先核对恢复记录，再按[域名恢复](dns-switch.md)、[网关恢复](gateway.md#更新与恢复)或[自建恢复](selfhost-node.md#退出与失败恢复)处理。

## 常见故障

| 现象 | 排查方向 |
| --- | --- |
| 无法连接 systemd 用户服务 | 使用部署用户正常登录；WSL 先启用 systemd，无 systemd 容器需自行托管 |
| 本机正常，CF 公网不可达 | [Tunnel、DNS、外层认证](cloudflare.md#验收与排查) |
| 自建节点在线但入口不就绪 | `server:doctor`，核对完整节点路径、身份、宿主与文件服务 |
| HTTPS 配置后 localhost 登录失败 | 使用配置的 HTTPS 入口，Secure Cookie 不能靠明文页面验证 |
| 显示或终端未就绪 | 检查宿主与 manager 日志；重装面板不会恢复已结束的任务 |
| 直连失败，中转正常 | [网络诊断](lan.md#常见问题)，分别检查 UDP 与浏览器权限 |
| 文件服务失败 | 只维护 files 服务；不为文件故障重启任务宿主 |
| 命令或上传结果未知 | 先核对远端状态或列表，再手动决定；不连续重试写操作 |
| 浏览器提示草稿保存失败 | 离开或刷新前手动复制草稿；存储失败时不能保证阻止导航，见[浏览器存储](browser-preferences.md#刷新多个页面与存储失败) |
| 节点中继 unit 报 Invalid slot / specifier | 检查安装路径是否包含 `%`、`$` 等 systemd 特殊字符；在普通路径部署，重新生成 unit 后验收 |

## 服务恢复与显式停止

面板有限恢复耗尽后，先处理日志中的原因，再执行：

```sh
systemctl --user reset-failed codex-cloud-panel.service
systemctl --user start codex-cloud-panel.service
```

文件服务同理替换为 `codex-cloud-files.service`。生命周期与可选入口服务见[服务恢复](reliability.md)。

`npm run native:stop` 会停止工作台。重启 desktop / terminal 宿主或主机会影响其中任务，应先保存工作并安排维护；关闭浏览器和重载面板不等于停止任务宿主。

[文档目录](README.md) · [部署选择](deployment.md)
