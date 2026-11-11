# 服务生命周期与恢复

浏览器、面板和任务宿主分别管理。关闭网页、失去观看者或切换网络不会触发任务宿主重启，也不会重放输入或审批。

## 服务职责

| 服务 | 职责 | 停止／重启的影响 |
| --- | --- | --- |
| desktop 或 terminal | 持有图形桌面或纯终端任务、私有 tmux | 影响其中的任务，需安排维护 |
| actions，仅桌面模式 | 窗口、远程剪贴板固定动作 | 影响查看窗口／选区，任务由宿主持有 |
| manager | 终端、输入与设置管理 | 暂停管理操作，不主动重建宿主 |
| files | 文件服务 | 暂停传输，不结束终端任务 |
| panel | 登录、观看连接、协议转发 | 观看连接需恢复，助手按保存规则重建映射，旧 TCP 由客户端重连 |
| tunnel，可选 | 节点到 CF 的公网连接 | 暂停该公网路径，原任务保留 |
| selfhost-node，可选 | 节点 frpc 到自建中心的反向隧道 | 暂停该入口，原任务保留；故障每 15 秒重试 |

表中服务名使用 `codex-cloud-名称.service`；自建节点入口的实际服务名为 `codex-cloud-selfhost-node.service`。中心的 `codex-selfhost-*` 是系统服务，不属于节点用户服务；其重启 / 证书续期会中断网络连接，但不重启节点任务。

临时 `codex-view-*` 查看器与真正的任务窗格不同，查看器退出可被回收。固定 `codex-host` 保活会话不接受网页输入，不占用户终端名额。

## 恢复规则

面板和文件服务有限自动恢复：异常退出等待 5 秒，60 秒内最多启动 3 次；手动停止不会因此自动启动。任务宿主保留显式维护策略，失败不自动重建 Codex 任务。

先看状态和日志，处理原因后再恢复对应服务：

```sh
npm run native:status
journalctl --user -u codex-cloud-panel.service -n 50 --no-pager
systemctl --user reset-failed codex-cloud-panel.service
systemctl --user start codex-cloud-panel.service
```

文件服务使用同样流程，将服务名替换为 `codex-cloud-files.service`。不为文件或面板故障重启整个桌面。

## 连接与操作边界

- 有效登录可以在面板恢复后继续使用；已有另一页面控制时仍需明确接管。
- 输入、粘贴、Enter、审批和创建／结束操作不因网络恢复自动重发。结果未知时由用户核对。
- 健康的原节点连接可在网关默认路由切换后继续存在；新请求不能借另一节点的登录操作旧任务。
- “快速切换待命”仅保留查看器及有限连接，不持有第二套任务。锁屏、退出与授权失效会按原规则撤销观看权限。

详细维护见[操作指南](operations.md)，HTTP／WSS／WebRTC 约束见[架构](architecture.md)和[网络](lan.md)。

[文档目录](README.md) · [部署选择](deployment.md) · [维护排障](operations.md)
