# 域名维护与旧 DNS 接管方式

本页用于已有单节点发布和旧部署维护。需要从网页切换机器时使用[固定网关](gateway.md)；网关成员会拒绝这些 DNS 发布／接管命令。

## 分阶段发布与改名

已有本机工作台首次发布到自己的域名：

```sh
npm run native:publish -- --domain desk.example.com --zone example.com --prepare-only
systemctl --user restart codex-cloud-panel.service
npm run native:tunnel
npm run native:publish -- --domain desk.example.com --zone example.com --commit-only
```

Token 默认读取私有 `secrets/cf_token`。改为另一个域名时，对新目标的两个阶段都增加 `--rename`；只支持原账户和区域内改名。目标已有无关记录或路由时拒绝覆盖。

发布先准备本机配置、检查私有入口和宿主就绪，再写远端。准备后发现人工修改会停止并保留恢复记录。中断时继续原目标，不要同时发起另一项发布或手改 DNS。

需要回退时，先核对 `data/cloudflare-publication.json` 与远端实际状态，再按原目标执行：

```sh
npm run native:publish -- --domain desk.example.com --zone example.com --rollback
```

不要公开恢复文件，其中可能包含运行令牌和私有配置快照。完整 `deploy` 不自动接管其他进程留下的未完成发布。

## 固定域名在任意节点之间切换

旧 `native:activate` 由目标机器主动修改同一固定域名的 DNS，不维护网页目录。每台机器都需保留自己的管理 Token 文件，每次 DNS 切换仍会使用它；不适用于已接入固定网关的节点。

先在当前入口所在机器启用共享身份，再在其他目标机器执行同样的首次接入：

```sh
npm run native:activate -- --domain desk.example.com --zone example.com
```

完成首次初始化后，在希望接管的机器执行：

```sh
npm run native:activate
npm run native:activate -- --status
```

该方式没有跨主机原子 DNS 锁，不要同时激活两台机器。回复未知时先用 `--status` 核对；必要时明确执行 `--resolve-unknown`，仅核对和收尾，不重新提交切换或撤销别人的新入口。

节点按自己的身份隔离登录、草稿和请求；原任务不迁移。后续可按[网关迁移](gateway.md#复用已有固定域名)升级为网页切换。
