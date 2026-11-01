# 验证记录与验收

开发机：Ubuntu 18.04.6，Node.js 24.21，Python 3.11，Chrome 137。原生部署不安装 Docker。

本机已有 XFCE、x11vnc、xterm、tmux、xdotool、Codex。无 sudo 实机验证使用从 Ubuntu 仓库下载并解压到 `data/host-tools` 的包：

- xvfb `2:1.19.6-1ubuntu4.15`
- xclip `0.12+svn84-4build1`
- fonts-wqy-microhei `0.2.0-beta-3`

这些私有文件不进入 Git，不修改系统包数据库。cloudflared `2026.10.0` 安装在同一私有目录，使用固定 SHA-256 校验。

## 自动化检查

```bash
npm run check
npm test
npm run test:desktop
CHROME_PATH=/usr/bin/google-chrome npm run test:browser
```

Node 集成测试覆盖登录、Host/Origin/CSRF、已认证 noVNC 资源、Unix socket WebSocket 桥接、多页面接管、会话持久化与文件代理。Python 测试使用真实 HTTP/文件，模拟 X11 动作。浏览器测试使用实际 noVNC 客户端与模拟 RFB 服务器，覆盖手机和桌面尺寸、中文输入、独立 Enter、文件、退出和接管。

2026-11-01：7 项 Node、7 项 Python、4 项浏览器测试通过；真实桌面验收也通过。真实检查确认浏览器断开和面板重启期间 tmux shell PID 不变，中文通过 X11 剪贴板原样写入中转测试文件，粘贴阶段没有执行命令。

2026-11-01 并发与接管修复：30 个脚本语法检查、10 项 Node、7 项 Python、6 项浏览器测试通过。新增回归测试先在修复前复现失败，再验证延迟请求体不能绕过登录并发及失败次数限制、并发失败不会丢失计数，以及页面接管可以替换未完成的轮询并忽略旧的归属响应。浏览器测试分别覆盖手机和桌面尺寸，仍使用模拟 RFB 上游；本轮未运行真实桌面或公网验收，未重启运行中的服务。

2026-11-01 桌面高度调整：默认分辨率改为 `1280x1000`，同步初始化配置、配置示例与模拟 RFB 桌面；网页电脑端显示区增加 100 像素，较矮的横屏视口使用 75dvh。语法检查、10 项 Node、7 项 Python、6 项浏览器测试通过。当前真实 Xvfb 的上限仍为 `1280x800`，需结束现有 Codex 任务后重启桌面服务才能应用新分辨率；本轮未重启服务，未执行真实桌面或公网验收。

2026-11-01 进一步加高：默认、本机配置及模拟 RFB 桌面同步改为 `1280x1280`，30 个脚本语法检查、10 项 Node、7 项 Python、6 项浏览器测试通过；浏览器测试仍使用模拟上游。按用户授权重启独立桌面后，真实 X11 显示尺寸确认为 `1280x1280`，终端已最大化并按准确会话 ID 恢复当前对话，未附带提示词。公网 `/healthz` 返回 `200 {"ok":true}`。本次未运行会发送终端测试命令的 `test:native`。

2026-11-01 桌面加宽：默认、本机配置与模拟 RFB 桌面同步改为 `1600x1280`，高度保持不变。30 个脚本语法检查、10 项 Node、7 项 Python、6 项浏览器测试通过，浏览器仍连接模拟上游。重启独立桌面后实测 X11 为 `1600x1280`，终端已最大化并按原会话 ID 恢复当前对话，未附带提示词；公网健康检查返回 200，VNC socket 权限仍为 0600。本次未运行 `test:native`。

2026-11-01 高度增至 1600：默认、本机配置与模拟 RFB 桌面同步改为 `1600x1600`。30 个脚本语法检查、10 项 Node、7 项 Python、6 项浏览器测试通过，浏览器仍连接模拟上游。重启后实测 X11 为 `1600x1600`，终端已最大化，当前会话按准确 ID 恢复且未附带提示词；公网健康检查返回 200，VNC socket 权限为 0600。本次未运行 `test:native`。

2026-11-01 显示控件：31 个脚本语法检查、10 项 Node、7 项 Python、14 项浏览器测试通过。新增浏览器测试在手机和桌面视口使用实际 noVNC 与模拟 RFB 上游，覆盖适应窗口、原始比例、缩放后的输入坐标、输入助手折叠、浏览器偏好、全屏及窗口尺寸变化；鼠标和 CDP 触摸测试确认拖动、点击、滚轮和按键不产生远程输入。主动断开模拟 Unix socket 后，画面自动重连并恢复显示选项，没有调用粘贴、按键或打开终端接口。

只重启 Web 面板后，另从真实公网入口验证 noVNC 的 `1600x1600` 画面、100% / 125% 比例、折叠输入助手和手机视口。验证过程未发送远程点击、按键、调整分辨率或输入助手请求；公网健康检查返回 200，浏览器无脚本错误。桌面、Tunnel 和 Codex pane 的 PID 均保持不变。本次未运行会向终端发送测试命令的 `test:native`，也未使用真实手机。

2026-11-01 连接状态与诊断：34 个脚本语法检查、16 项 Node、7 项 Python、24 项浏览器测试通过。模拟 RFB 测试覆盖健康轮询期间画面断线、断网恢复、桌面健康与画面状态分离、工作台会话过期、外层验证过期，以及接管后忽略旧画面消息；未重放输入、登录或接管请求。诊断测试覆盖认证、汇总字段过滤、IPv4/IPv6 活动连接统计、原生空连接列表、省略字段、大小和超时限制、单请求缓存及拒绝重定向；慢诊断不会阻塞面板健康接口。

更新面板和 Tunnel 后，真实公网 noVNC 验证显示实际分辨率 `1600x1600`，诊断汇总为 4 条活动连接且均为 IPv6。未登录诊断请求返回 401，登录后仅返回可用性、连接总数、IPv4/IPv6 数量与更新时间。诊断端口实测仅监听 `127.0.0.1:36903`；桌面和 Codex pane 的 PID 保持不变。浏览器实机检查没有发送远程点击、按键、分辨率修改或输入助手请求，也无脚本错误；本轮没有真实手机验收或执行 `test:native`。

## 真实桌面

```bash
npm run native:doctor
npm run native:install
npm run native:start
CHROME_PATH=/usr/bin/google-chrome npm run test:native
```

`test:native` 只操作空闲 bash，会发出无害的 printf/sleep 命令并重启一次面板。验证真实 noVNC / Unix socket / x11vnc / Xvfb 链路、中文粘贴不自动执行、Enter 提交、浏览器断开后任务完成、手机视口、面板重启时原 tmux PID 与登录状态保留。结束后删除中转测试文件。

截图：`test-results/native-desktop.png`、`test-results/native-mobile.png`，不进入 Git。监听检查应只有回环 HTTP 面板和内部接口，不应出现项目的 VNC TCP 监听。

## 仍需人工验收

- 用实际 Codex 任务验证所需的审批、沙箱和工具链。自动化验收只运行 `codex --version`，不会自动创建付费模型请求。
- 用实际手机蜂窝网络测试输入、手势及网络切换；当前已完成公网链路和手机尺寸浏览器验收，尚未使用真实手机。
- 启用 linger 后验证注销及主机重启；关闭休眠并验证外出时供电、联网。
- 在普通编辑器中验证“其他应用”的 Ctrl+V。不同编辑器的快捷键可能不同。

重启桌面前先结束任务。文件保留不等于进程恢复；重启主机或桌面服务会终止正在运行的任务。

## 当前公网实例

2026-11-01 已通过 Cloudflare API 创建本项目专用 Tunnel 与 `remote-codex.x-wrt.dev` 的代理 CNAME，上游为 `http://127.0.0.1:36080`。桌面、面板、Tunnel 三个用户服务均在运行。API Token 仅从用户指定的 `/tmp/cf_token` 读取，运行时只保存专用 Tunnel 的 token，未进入 Git。

```bash
CHROME_PATH=/usr/bin/google-chrome npm run test:native -- --public
```

已从 HTTPS 公网入口验证：真实 noVNC 握手与画面、中文粘贴不自动执行、独立 Enter、断开浏览器后任务完成、手机视口，以及重启面板后登录保留和 tmux PID 不变。另用真实公网 HTTP 请求验证 Secure / HttpOnly / SameSite Cookie、中文文件上传下载、未登录桌面返回 401。

当前使用工作台密码认证，未创建 Cloudflare Access 应用。用户已执行 `sudo loginctl enable-linger ptpt52`；检查确认 `Linger=yes`，桌面、面板和 Tunnel 三个用户服务均为 enabled / active。注销与主机重启后的实际恢复仍需人工验收；主机重启会结束原来的运行任务。

## DNS 故障恢复

2026-11-01，后续重连出现系统 DNS 查询 Tunnel SRV 记录失败，公网 IPv4 / IPv6 均返回 Cloudflare 1033。本机面板仍返回 200，公共 DNS 查询正常，IPv4 / IPv6 到接入节点 TCP 7844 均可达。

已仅为 Tunnel 启用公共 DNS 的私有 user/mount namespace，并为 Tunnel 用户服务增加失败后 10 秒重试。宿主 `/etc/resolv.conf` 仍指向原系统解析器。实际日志确认 Tunnel 通过 IPv6 建立四条连接；公网 `curl -4` 和 `curl -6` 的健康检查都恢复为 `200 {"ok":true}`。桌面 MainPID 保持不变，未重启桌面或执行用户终端中的命令。

新增回归测试验证专用 DNS 仅在子进程中可见、宿主 DNS 文件不变、包装脚本不解释传入参数中的 shell 字符。此测试在允许非特权 namespace 的 Linux 上运行，否则明确跳过。

## IPv6 优先连接确认

2026-11-01：保留本机已有的 `TUNNEL_EDGE_IP_VERSION=auto`。在 Tunnel 的独立 DNS 环境中，`region1.v2.argotunnel.com` 与 `region2.v2.argotunnel.com` 各返回 10 个 IPv6 和 10 个 IPv4 地址，IPv6 均排在前面。cloudflared 日志记录的四条边缘连接均为 IPv6，实时 `cloudflared_tunnel_ha_connections` 指标为 4；公网 `curl -4`、`curl -6` 健康检查均返回 `200 {"ok":true}`。本次只完善配置示例与策略说明，未修改运行参数或重启服务，桌面、面板和 Tunnel 的 MainPID 均保持不变；未通过中断网络模拟故障回退。
