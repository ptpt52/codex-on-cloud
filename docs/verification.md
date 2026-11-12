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

## 端口映射的重点回归

只定位助手管理离线时的规则撤销问题，可先执行：

```sh
node --test test/forward-agent-policy.test.mjs
```

此规格使用真实面板 HTTP / WebSocket 和 TCP 回显，覆盖两种方向的编辑、停用、删除、旧授权拒绝及其他规则不受影响；桌面管理是 fixture。真实 Go 助手与直连网络另用 `npm run test:forward:agents`，不能由这项 Node 回归代替。

## 验证环境的区别

| 检查 | 实际运行 | 不代表什么 |
| --- | --- | --- |
| Node／Python 单元检查 | 业务逻辑、临时文件、部分真实网络与锁 | 不代表生产 Cloudflare 或桌面验收 |
| 浏览器规格 | 实际引擎和协议，许多上游由 fixture 模拟 | 不代表手机系统键盘或真实 Codex 操作 |
| `test:gateway:worker` | 真实 workerd／SQLite、HTTP／WSS 与私有面板入口 | 终端／文件宿主仍为夹具，不连接生产 CF |
| `test:terminal-only` | 隔离 tmux／PTY、最小依赖、任务生命周期 | 不代表生产终端或所有发行版 |
| `test:selfhost:edge` | 真实 Caddy、本地 TLS、HTTP-01 路由及 Cookie 过滤 | 续期命令为夹具，不代表公网 ACME 或正式 systemd 部署 |
| `test:turn` | 真实 coturn，UDP / TCP / TLS 控制与强制 relay 数据往返 | 不代表真实云安全组、运营商及节点网络已打通 |
| `test:forward:entry` | 真实 Go 助手通过完整节点路径传输 TCP | 桌面管理为夹具，不代表真实 FRP 和生产中心验收 |
| `test:forward:agents` | 两个真实 Linux 助手、TCP、回环 WS、Pion / werift 直连、规则隔离及面板重启恢复 | 桌面管理为夹具，不代表真实 USB 串口、Windows / Mac 或公网验收 |
| `test:rtc:nat` | 隔离 Linux SNAT、防火墙、STUN、Chrome / werift 与真实 Go / Pion，校验加密字节往返及 UDP 封锁 | 不代表物理路由器、对称 NAT、运营商 CGNAT 或生产入口验收 |
| 原生显示、指针与恢复检查 | 隔离 Xvfb／x11vnc／noVNC；部分测试需 systemd | 不应对生产桌面注入故障 |

真实 Worker 检查：

```sh
npm install --prefix /tmp/codex-worker-tools --no-save --ignore-scripts \
  --no-audit --no-fund wrangler@4.158.0
WORKER_TOOLS=/tmp/codex-worker-tools npm run test:gateway:worker
```

`npm run test:rtc:nat` 需要 Linux 的 `iproute2`、`nftables`、固定 Go 和 Chrome，以及可用的 user / network namespace；缺少网络隔离条件时明确跳过，其他缺失依赖报错。`NAT_TEST_REQUIRED=1` 将缺少隔离条件也视为失败；CI 使用 `NAT_TEST_ROOT=1` 在 sudo 下只创建隔离网络，不修改主机网络。

原生检查命令及依赖见[CI 说明](ci.md)。`test:native` 会操作目标桌面、发送测试文字并重载面板，只能在专用验收实例使用。

## 自己部署后的验收

1. 按下表选择真正的工作台入口，确认节点 `/readyz` 的 `ok`、`host`、`files` 均为 true，并核对节点身份。
2. 使用自己的账号登录，确认终端或桌面可用；明确区分粘贴与 Enter。
3. 关闭并重开浏览器，确认原任务保留，没有重复输入；验证另一页面接管。
4. 验证文件、所选网络路径及自己启用的可选功能。
5. 网关部署还需验证每个真实节点的登记、目标就绪和切换，确认原节点任务保留。

| 入口 | 检查地址 |
| --- | --- |
| 本机 / SSH | `http://localhost:36080/healthz`、`http://localhost:36080/readyz` |
| CF 单节点 | `https://desk.example.com/healthz`、`https://desk.example.com/readyz` |
| CF 网关 | 固定入口的 `/readyz` 对应当前全局默认节点；另在 `/__nodes/` 验证目录和切换 |
| 自建中心 | 根路径 `/healthz` 只证明中心存活；节点就绪检查使用 `https://desk.example.com/node/node-a/readyz` |

HTTPS 已配置后，不以明文 localhost 登录代替真实入口验证。使用私有 CA 时让检测客户端信任该 CA，不通过跳过证书校验来判定 HTTPS 正常。

手机键盘、剪贴板、后台恢复和真实跨机器网络应单独验收。不能用 fixture 通过代替这些结果，也不要为验收中断正在执行的生产任务。

[文档目录](README.md) · [部署选择](deployment.md) · [维护排障](operations.md)
