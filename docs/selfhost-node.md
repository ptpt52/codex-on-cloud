# 自建中心的节点接入与恢复

本页面向节点部署者：中心服务器已由管理员按[中心部署](selfhost-server.md)安装，自己只需要安装工作台并接入。桌面、终端、Codex 登录和工作区始终保留在节点机器上。

先准备[节点工具与依赖](node-prerequisites.md)，在节点仓库根目录以普通 Linux 用户执行。不要用 sudo 运行节点的 npm 命令；`--install-deps` 与 `--enable-linger` 会在需要时单独使用 sudo。

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

命令会交互读取中心地址、slug 和隐藏输入的授权 key。key 不接受普通命令行参数，也不会写入磁盘。

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

需要固定 Go 1.26.4。登录 `https://desk.example.com/node/node-a/`，在“端口映射”中核对四个平台下载，并下载实际使用的版本。节点在线、登录页可打开或终端可用，不等于助手已发布；入口改变后需要重新构建并下载。完整用法见[端口映射](forward.md#构建与全新替换)。

## 日常更新与状态

接入后的日常更新直接运行 `npm run deploy`，省略 Cloudflare 参数。自建入口不会因保留旧 `tunnel_token` 而安装或启动 cloudflared；旧凭据仅保留供明确退出或恢复原入口时使用。

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

## 退出与失败恢复

```sh
# 正常退出并恢复原工作台入口
npm run server:leave

# 仅在 doctor 提示上次接入回滚未完成时使用
npm run server:leave -- --recover
```

`server:leave` 先确认 frpc 已停止，再释放中心租约并恢复 Panel；停止或恢复失败时保留接入配置与备份，修复问题后可直接重试。中心网络不可达时会明确警告，并在本地中继确认停止后完成离线清理。

`server:join` 使用部署锁，并先完成 frpc、CA 和本地条件检查，再申请中心授权。改写配置前先写入最多 256 KiB 的私有事务快照，包含 Panel、旧备份、中继配置、CA 和服务状态；超出限制时拒绝更改。正式接入失败时会停止中继、释放中心授权并恢复原文件和服务状态；若回滚或中心释放仍未确认，会保留私有 `data/selfhost-node/join-recovery.json`，`server:doctor` 会报告该状态。恢复会逐个比较文件与事务预期内容，遇到人工修改保留现场，不覆盖冲突；只有全部恢复已确认才删除记录。故障排除后运行 `npm run server:leave -- --recover` 完成收尾。

## 访问与验收

浏览器使用中心域名下的完整节点路径；节点不需要独立域名或 SSL 证书。中心证书、节点 key、节点工作台密码是三种不同用途的凭据。浏览器保存密码时保留预填的 `admin@node-<slug>` 登录名，说明见[管理与登录](selfhost-admin.md#登录与浏览器记住密码)。

每个节点独立注册 `/node/<slug>/` 下的 Service Worker，缓存按节点路径区分；账号、草稿和请求也绑定自己的节点。所有节点仍共享浏览器源，只能接入相互信任的机器，不能据此提供不受信任的多租户托管。

接入命令显示“配置已完成、入口尚未就绪”时，先运行 `server:doctor` 并修复提示的问题。验收应同时检查完整节点路径的 `/readyz`、浏览器登录、终端或桌面、文件中转以及启用的助手下载；不要仅检查 frpc 为 active。

[返回文档目录](README.md) · [中心管理](selfhost-admin.md) · [维护指南](operations.md)
