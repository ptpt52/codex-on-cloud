# 自建中心的节点接入与恢复

本页面向节点部署者：中心服务器已由管理员按[中心部署](selfhost-server.md)安装，自己只需要安装工作台并接入。桌面、终端、Codex 登录和工作区始终保留在节点机器上。

先准备[节点工具与依赖](node-prerequisites.md)，安装目录使用普通字母、数字和连字符，避免 `%`、`$` 等会被 systemd 解释的字符。在节点仓库根目录以普通 Linux 用户执行。不要用 sudo 运行节点的 npm 命令；`--install-deps` 与 `--enable-linger` 会在需要时单独使用 sudo。

## 1. 部署本机工作台

选择一种模式，例如纯网页终端：

```sh
npm run deploy -- --mode terminal --install-deps --enable-linger
```

需要完整桌面时改为 `--mode desktop`，并预先安装 Codex CLI。已有本机工作台直接进入下一步；系统依赖已齐时省略 `--install-deps`。

## 2. 使用节点授权接入中心

先请管理员在[中心管理页](selfhost-admin.md#创建与维护节点授权)创建固定 slug 的节点并取得 key，然后执行：

```bash
npm run server:join
```

命令会交互读取中心地址、slug 和隐藏输入的授权 key。也可以预填非敏感参数：

```sh
npm run server:join -- --server https://desk.example.com --slug node-a
```

随后只需在隐藏提示中输入管理员提供的 key。key 不接受普通命令行参数，也不会写入磁盘。

首次接入后，节点保存专用 credential，生成 `frpc.toml` 和独立 systemd user 服务。中继失败后每 15 秒重试，不因连续失败次数耗尽而永久停止；重新生成服务时也会清理旧的启动限流失败状态。SSH 退出后中继仍运行；建议确保已启用：

```bash
sudo loginctl enable-linger YOUR_LINUX_USER
```

将 `YOUR_LINUX_USER` 替换为节点部署用户；已经通过部署选项启用 linger 时无需重复操作。

## 3. 发布端口映射助手（可选）

需要从 Windows / Mac 通过本地助手使用 TCP 或串口映射时，在接入成功、最终入口确定后构建：

```sh
npm run build:forward
```

需要固定 Go 1.26.4。选了 TCP / 串口助手时，本节为必做步骤；不使用助手时才可跳过。登录 `https://desk.example.com/node/node-a/`，在“端口映射”中核对四个平台下载，并下载实际使用的版本。节点在线、登录页可打开或终端可用，不等于助手已发布；入口改变后需要重新构建并下载。完整用法见[端口映射](forward.md#构建与全新替换)，完成标准见[共用检查清单](deployment-checklist.md)。

## 日常更新与状态

接入后的日常更新运行 `npm run deploy`，助手代码同时更新时增加 `--build-forward`，均省略 Cloudflare 参数。自建入口不会因保留旧 `tunnel_token` 而安装或启动 cloudflared；旧凭据仅保留供明确退出或恢复原入口时使用。

接入命令会区分“配置已完成、入口待就绪”和“入口已就绪”。`server:doctor` 除检查中心及本地服务，还通过完整节点路径检查任务和文件服务，并核对节点身份；只有进程处于 active 不再视为入口正常。

```bash
npm run server:status
npm run server:doctor
```

## 私有 CA

只有中心证书不受系统信任库信任时才增加 `--ca-file`；公共 CA 证书无需此参数。

```bash
npm run server:join -- --server https://desk.example.com --slug node-a --ca-file /path/to/center-ca.pem
```

`--ca-file` 是签发中心证书的 CA 公共证书，不是节点证书或服务器私钥。首次接入、退出、恢复、健康检查和 TURN 请求都使用该中心的 CA，并保留证书链、有效期和 URL 域名验证。切换中心时不会沿用旧中心的 CA；如新中心也使用私有 CA，应重新传入。重复接入同一中心可沿用已保存的 CA。

此参数只配置节点到中心的信任，不会替浏览器或 Windows / Mac 助手安装 CA；客户端仍需信任中心证书。助手没有跳过证书校验选项。

## 重新授权与切换中心

管理页生成的接入命令只包含中心地址和 slug，不包含 key。将 key 单独复制到命令提示的隐藏输入中。已安装并接入同一中心 / 路径的节点，重新授权后执行：

```bash
npm run server:join -- --server https://desk.example.com --slug node-a --reauthorize
```

`--reauthorize` 强制读取新 key，保留本机节点身份和路径，替换旧 credential。普通重复执行 `server:join` 会继续使用原 credential，不会重新询问 key。新机器首次接入不需要该选项；已有私有 CA 可沿用本机保存的 CA。重新授权一经完成，旧中心凭据不会因本地接入失败而恢复；修复接入失败的原因后可使用新 key 重试，若存在恢复记录先按 `server:doctor` 的提示处理。

已有 Cloudflare/Gateway 发布状态时，`server:join` 默认拒绝自动接管。明确需要切换时使用：

```bash
npm run server:join -- \
  --server https://desk.example.com \
  --slug node-a \
  --switch-existing
```

接入前会备份 `.env`、节点登录说明和 `gateway-node.json`。`server:leave` 会停止中继、释放中心路径并恢复原 Panel 配置，不会删除工作区、任务、桌面或 Codex 登录。

换到另一个中心或 slug 时，需要管理员为新目标创建 key，并显式增加 `--replace`；它不等同于同一路径的 `--reauthorize`。只有接管本机原有 Cloudflare / 网关入口时才使用 `--switch-existing`，两项用途不同。

## 状态与排障

运行 `npm run server:status` 查看接入配置、服务状态和阶段诊断，使用 `npm run server:doctor` 验证中心及完整节点入口；需要查询未完成的中心接入时增加 `-- --resolve`。机器可读输出可用 `npm run --silent server:doctor -- --resolve`，可直接复制 JSON 用于排障。

`diagnostics` 包含最近命令阶段、固定失败原因码、连续失败后的命令重试次数、最近命令完成时间 `lastSuccessAt`，以及最近接入命令实际验证入口成功的 `lastReadyAt`。它们不是当前连接健康的替代品；当前状态由 `checks.center`、`checks.entry` 和服务状态报告。入口检查区分 DNS、超时、TLS、HTTP 状态、响应格式、错误节点身份及节点尚未就绪。`relay.restartCount` 来自 systemd 的 frpc 自动重启计数，与命令重试分开；服务没有提供计数或时间时显示 `null`。

诊断只保存一个私有 `data/selfhost-node/diagnostics.json`，最多 8 KiB、32 条事件，尝试计数最多一百万；退出接入后保留最后的诊断。记录不包含 key、凭据、接入证明、原始错误正文或工作区路径，输出只允许固定字段。诊断损坏或写入失败会报告不可用，不覆盖原文件或改变实际接入、退出和恢复结果。诊断读取与 `doctor --resolve` 都不改写状态或重发请求。

## 退出与失败恢复

```sh
# 正常退出并恢复原工作台入口
npm run server:leave

# 仅在 doctor 提示上次接入回滚未完成时使用
npm run server:leave -- --recover
```

`server:leave` 先完整预检 `.env`、登录说明、Gateway 配置及恢复备份。环境配置只接管 `PUBLIC_ORIGIN`、`ENTRY_BASE_PATH`、`SELFHOST_NODE_CONFIG_FILE`、`SHARED_ENTRY`、`NODE_ID`、`SELFHOST_CA_FILE`；登录说明只接管“工作台”地址行。恢复使用原值、接管值和现值进行三方合并，保留其他字段、用户名说明、注释及多行文本；重复接管字段或改成第三种值时报告字段冲突，不显示实际配置值。Gateway 文件仍按完整快照保护。

发现接管字段或 Gateway 冲突时，不停止中继、不释放中心租约、不改写文件。预检通过后确认 frpc 已停止，再释放中心租约；写入前再次核对全部预检快照，每个原子写入也核对目标文件。停止或恢复失败时保留接入配置与备份，修复问题后可直接重试。中心网络不可达时会明确警告，并在本地中继确认停止后完成离线清理。凭据刷新会保留同样的非接管修改；接入事务中途失败仍按完整事务快照检查，遇到并发人工改动保留恢复记录。

`server:join` 使用部署锁，并先完成 frpc、CA、Panel 冲突和服务单元路径检查，再申请中心授权。请求发出前先写入最多 256 KiB 的私有接入意图，包含操作编号及独立的私有证明，收到凭据后立即保存。中心用现有凭据摘要验证操作编号、节点身份、模式及私有证明，不新增授权文件字段，兼容旧版中心读取；不保存 key、证明或节点凭据原文。同一操作重复提交只返回原回执，不重建连接。重新授权或撤销后旧证明立即失效。

响应丢失、格式无效或结果未知时，`server:doctor` 会报告中心地址、节点路径、身份和操作编号，阻止盲目重发。使用 `npm run server:doctor -- --resolve` 可只读查询中心已接受的接入结果，诊断输出不包含证明或凭据；`server:leave --recover` 在缺少凭据时先查询回执，保存取得的凭据后再释放本次接入。查询不重发接入、不新建租约、不更改本地服务。旧中心、旧恢复记录、未接受的请求或查询失败仍需管理员核对，记录继续保留。

改写配置前将意图原子替换为同样最多 256 KiB 的事务快照，包含 Panel、旧备份、中继配置、CA 和服务状态；超出限制时拒绝更改。本地改写前失败且已有凭据时，`server:leave --recover` 只释放本次中心接入，不改写人工配置或停止旧服务；同节点凭据刷新保留原连接。正式接入失败时会停止中继、释放中心授权并恢复原文件和服务状态；若回滚或中心释放仍未确认，会保留私有 `data/selfhost-node/join-recovery.json`。恢复会逐个比较文件与事务预期内容，遇到人工修改保留现场，不覆盖冲突；只有全部恢复已确认才删除记录。故障排除后运行 `npm run server:leave -- --recover` 完成收尾。

## 访问与验收

浏览器使用中心域名下的完整节点路径；节点不需要独立域名或 SSL 证书。中心证书、节点 key、节点工作台密码是三种不同用途的凭据。浏览器保存密码时保留预填的 `admin@node-<slug>` 登录名，说明见[管理与登录](selfhost-admin.md#登录与浏览器记住密码)。

每个节点独立注册 `/node/<slug>/` 下的 Service Worker，缓存按节点路径区分；账号、草稿和请求也绑定自己的节点。所有节点仍共享浏览器源，只能接入相互信任的机器，不能据此提供不受信任的多租户托管。

接入命令显示“配置已完成、入口尚未就绪”时，先运行 `server:doctor` 并修复提示的问题。完成接入后运行 `npm run verify:deployment`，需要助手时增加 `-- --forward`。综合命令会复用 `server:doctor` 并检查完整节点路径，随后按报告验证浏览器登录、终端或桌面、文件和目标助手；选项见[部署后自动验收](deployment-verification.md)。

[文档目录](README.md) · [部署选择](deployment.md) · [维护排障](operations.md)
