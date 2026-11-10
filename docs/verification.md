# 测试与验证

本页说明如何验证自己的代码和部署，不提供跨环境通用的“已通过”结论。测试结果以当前提交、实际环境和 [CI 配置](../.github/workflows/check.yml)为准；历次结果在[历史记录](archive/verification.md)。

## 开发检查

在隔离开发目录安装锁定依赖，再执行：

```sh
npm ci
npm run check
npm test
npm run test:desktop
```

后端变更至少完成上述三类检查；浏览器行为变更增加浏览器测试。不要为运行测试在活动纯终端部署中补装整套开发依赖。

```sh
# 使用自己已安装的 Chrome，或安装锁定 Playwright 对应的浏览器
CHROME_PATH=/usr/bin/google-chrome npm run test:browser -- --workers=2
npm run test:compat
```

兼容矩阵、系统库要求及真机边界见[浏览器兼容性](compatibility.md)。

## 验证环境的区别

| 检查 | 实际运行 | 不代表什么 |
| --- | --- | --- |
| Node／Python 单元检查 | 业务逻辑、临时文件、部分真实网络与锁 | 不代表生产 Cloudflare 或桌面验收 |
| 浏览器规格 | 实际引擎和协议，许多上游由 fixture 模拟 | 不代表手机系统键盘或真实 Codex 操作 |
| `test:gateway:worker` | 真实 workerd／SQLite、HTTP／WSS 与私有面板入口 | 终端／文件宿主仍为夹具，不连接生产 CF |
| `test:terminal-only` | 隔离 tmux／PTY、最小依赖、任务生命周期 | 不代表生产终端或所有发行版 |
| 原生显示、指针与恢复检查 | 隔离 Xvfb／x11vnc／noVNC；部分测试需 systemd | 不应对生产桌面注入故障 |

真实 Worker 检查：

```sh
npm install --prefix /tmp/codex-worker-tools --no-save --ignore-scripts \
  --no-audit --no-fund wrangler@4.158.0
WORKER_TOOLS=/tmp/codex-worker-tools npm run test:gateway:worker
```

原生检查命令及依赖见[CI 说明](ci.md)。`test:native` 会操作目标桌面、发送测试文字并重载面板，只能在专用验收实例使用。

## 自己部署后的验收

1. 从预期入口访问 `/healthz`、`/readyz`，确认宿主与文件服务就绪。
2. 使用自己的账号登录，确认终端或桌面可用；明确区分粘贴与 Enter。
3. 关闭并重开浏览器，确认原任务保留，没有重复输入；验证另一页面接管。
4. 验证文件、所选网络路径及自己启用的可选功能。
5. 网关部署还需验证每个真实节点的登记、目标就绪和切换，确认原节点任务保留。

手机键盘、剪贴板、后台恢复和真实跨机器网络应单独验收。不能用 fixture 通过代替这些结果，也不要为验收中断正在执行的生产任务。
