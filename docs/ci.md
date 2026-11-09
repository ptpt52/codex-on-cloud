# 自动检查

`.github/workflows/check.yml` 在推送 master、Pull Request 和手动触发时运行。工作流仅有仓库读取权限，checkout 不保存凭据。相同分支的新运行取消旧运行。

## 检查范围

| 作业 | 内容 | 期限 |
| --- | --- | --- |
| portal | 固定 Wrangler/workerd，真实 SQLite Durable Object 注册、撤销与重启持久化 | 15 分钟 |
| backend | 脚本语法、Node、Python、Go race/vet/mod verify、工作流 actionlint | 15 分钟 |
| terminal | 只安装 tmux/Python/util-linux 与生产 JS，验证无 noVNC/X11 的真实终端后台 | 10 分钟 |
| browsers | Chromium、Firefox、WebKit 三个独立环境、七种配置的兼容性流程；Chromium 另跑完整手机/电脑回归 | 每个环境 35 分钟 |
| native | 真实隔离 Xvfb、XFCE、xterm、tmux、剪贴板、noVNC、端口映射协议及四架构助手发布检查 | 25 分钟 |

Actions 使用完整 commit SHA；Node 固定 24.22.2、Go 固定项目已有的 1.26.4，Playwright 和应用依赖继续由现有锁文件固定。检查运行在 Ubuntu 24.04，浏览器矩阵最多同时三个作业。失败浏览器产物保留七天，内容来自临时测试实例。

工作台和显示控件用例已改成每项测试独立的网关和访问地址，两个页面接管测试只在同一个临时实例内共享状态。完整浏览器回归可使用两个 worker，不依赖公共演示桌面。`npm run demo` 仍可独立启动演示。

## 本地执行

```sh
npm run check
npm test
npm run test:desktop
npm run test:compat
CHROME_PATH=/usr/bin/google-chrome npm run test:browser -- --workers=2
```

真实隔离桌面与协议检查：

```sh
npm run test:lifecycle
npm run test:display
npm run test:viewport
CHROME_PATH=/usr/bin/google-chrome npm run test:pointer
npm run test:forward
npm run test:forward:publication
npm run test:serial
npm run test:terminal-only
```

CI 为这些检查安装临时虚拟桌面依赖，使用固定 Playwright 对应的 Chromium。真实 systemd 恢复检查 `npm run test:recovery` 由具有 systemd 用户管理器的主机单独执行，不将普通 CI 的进程组检查记为 systemd 验收。该测试默认使用锁定 Playwright 包提供的 Chromium，并只对唯一临时 unit 的 MainPID 发送 SIGKILL，兼容 systemd 255 对辅助进程信号的限制。

浏览器兼容矩阵与 Chromium 全量回归是两个独立作业。兼容矩阵继续按引擎并行，Chromium 全量回归单独使用 40 分钟预算，避免完整回归与兼容检查共享 35 分钟期限。

工作流已用固定 actionlint 1.7.11 在本地校验。宿主的旧 ShellCheck 不支持 actionlint 使用的参数，本地禁用了这个子检查；CI 的 Ubuntu 24.04 执行完整 actionlint。GitHub Actions 的首次远端运行需要将工作流推送到仓库，结果应以实际运行记录为准。

自动化使用临时目录、测试凭据和隔离显示；浏览器中的 RFB/管理上游与真实 X11、TCP/DTLS、systemd 验证分别记录。真实手机和其他设备的系统输入法、选区菜单及剪贴板仍通过人工验收。

串口的 `test:serial` 和 Go Linux PTY 测试使用隔离进程及伪终端，不打开宿主机物理串口。Windows/Mac 交叉构建和 Linux 测试不代表对应系统的 USB 串口真机验收。

backend还覆盖维护故障：旧任务部署变量、后续平台构建失败、提交确认丢失、空锁/半截锁、父进程SIGKILL及编译后代回收、文件租约前后发生配置修改。Cloudflare发布使用模拟API，不能当作真实账户发布验收；native的`test:forward:publication`另行执行四平台实际编译、Mac打包和版本固定下载哈希检查，全部产物留在临时目录。

2026-11-09实现提交`6830fa2`的七个作业均成功。该轮Chromium兼容检查约14分钟，随后串行执行完整回归，接近当前35分钟期限；后续建议将完整回归拆成独立作业，兼容配置与断言保持，避免耗时增长导致超时。本轮仅更新记录，工作流编排未变。

## 原生 RFB 客户端的请求顺序

`test:viewport` 的测试客户端采用首帧全量请求、后续增量请求，与 noVNC 的正常更新方式一致。连续整帧请求会让 Ubuntu 24.04 的 x11vnc 0.9.16 忙于重绘，后续 RandR 通知可能无法及时处理。隔离复现确认该请求顺序同时兼容 x11vnc 0.9.13 和 0.9.16；七种尺寸、DesktopSize 通知、同一私有连接及原桌面/终端进程的断言均保留。

## 终端历史的原生浏览器用例

`terminal-history.spec.mjs` 的原生用例使用独立 tmux 和 Python PTY，管理上游仍为模拟实现。主动断开后，测试等待第二条 WebSocket 的 `ready` 消息，再继续发送输入。颜色断言逐字检查实际输出的红色、粗体，覆盖同一颜色片段包含尾部空格的情况，不依赖 HTML `span` 的分组方式。失败时附加有界的历史文字、样式片段、tmux 捕获与连接状态，供 CI 产物定位；不会读取真实桌面或用户终端。

## 布局与混合时钟的等待

兼容性用例在旋转后轮询按钮的边界和实际命中位置，等待 `requestAnimationFrame` 中的浮层布局完成。快捷键菜单用例先确认忙碌状态已传入桌面 iframe，再推进探测时间；恢复真实 HTTP/ICE/DTLS 协商时用 `clock.runFor` 按顺序执行计时器，避免一次跳跃让握手超时先于网络回复执行。两者均保留原有可见范围、遮挡、连接数和不发送输入的断言。

门户测试包括事务模拟的 Node/浏览器检查，以及独立 `portal` 作业的真实 workerd/SQLite 验证。后者使用固定 `wrangler@4.158.0` 和临时存储，不连接 Cloudflare 账户或真实节点；详见[统一门户](portal.md#验证范围)。
