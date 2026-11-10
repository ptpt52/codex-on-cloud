# 自动检查

[工作流](../.github/workflows/check.yml)在推送 master、Pull Request 和手动触发时运行；相同分支的新运行取消旧运行。结果属于具体提交，不从本地检查或历史部署推断当前 CI 已通过。

## 作业与范围

| 作业 | 主要检查 |
| --- | --- |
| backend | 脚本语法、Node、Python、Go race／vet／mod verify、actionlint |
| gateway | 固定 Wrangler／workerd、SQLite、HTTP／WSS 和路由持久化 |
| terminal | 最小生产依赖、隔离 tmux／PTY、终端生命周期 |
| browsers | Chromium 电脑／手机／平板，Firefox，WebKit 电脑／手机／平板的兼容规格 |
| chromium-regression | 独立运行完整手机／电脑 Chromium 回归 |
| native | 隔离 Xvfb、XFCE、tmux、noVNC、文件／指针／映射及助手构建 |

版本和时限以工作流与锁文件为准。失败产物由 Actions 保留，可能包含临时测试实例的截图与 trace，不使用生产账号或 Token。

## 本地执行

基础命令见[测试与验证](verification.md)，兼容环境准备见[浏览器矩阵](compatibility.md)。

原生检查需要对应系统依赖，在隔离开发环境按需执行：

```sh
npm run test:lifecycle
npm run test:supervision
npm run test:display
npm run test:viewport
npm run test:pointer
npm run test:terminal-only
npm run test:forward
npm run test:serial
npm run test:forward:publication
```

`test:recovery` 和 `TERMINAL_TEST_SYSTEMD=1 npm run test:terminal-only` 还需要可用的 systemd 用户管理器，只操作唯一命名的临时服务。普通进程组检查不等同于 systemd cgroup 验收。

真实浏览器引擎、真实内核／网络和模拟上游分别计入验证范围；跨平台构建不代表 Windows／Mac 或 USB 硬件真机验收。完整历史记录见[归档](archive/README.md)。
