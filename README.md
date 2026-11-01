# Codex on Cloud

在 Ubuntu 本机运行独立开发桌面，通过手机或平板浏览器操作 Codex。**无需 Docker**，复用当前用户的工具、项目和 Codex 登录。

```text
手机浏览器 → Cloudflare Access（可选）→ Cloudflare Tunnel
                                      ↓
                         本机 Web 面板 127.0.0.1:36080
                                      ↓ 已认证的 WebSocket
                              私有 Unix socket
                                      ↓
                       x11vnc → Xvfb 独立显示 :93
                                      ↓
                        XFCE + xterm + tmux + 本机 Codex
```

面板与桌面使用独立的 systemd 用户服务。关闭浏览器、切换网络或重启面板，都不会主动停止桌面任务。VNC 不监听 TCP 端口，内部输入接口只监听回环地址。

## 环境与安装

需要 Linux、可运行的 Node.js 22+、Python 3.8+ 和本机 Codex CLI。已在本机 Ubuntu 18.04、Node 24、Python 3.11 上实测。Ubuntu 18.04 的系统默认 Node/Python 版本不满足要求，不要直接用旧系统包替换已有环境。

在新主机上安装桌面依赖，只有这一步需要 sudo：

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  xvfb x11vnc xfwm4 xfdesktop4 xfce4-panel xfce4-settings \
  xterm tmux xclip xdotool xauth x11-utils dbus fontconfig fonts-noto-cjk
```

普通用户初始化、检查和安装服务：

```bash
cd /home/ptpt52/Sources2/codex-on-cloud
npm ci
npm run setup
npm run native:doctor
npm run native:install
npm run native:start
npm run native:status
```

本机已经有大部分组件。为完成无 sudo 的实机验证，Xvfb、xclip 和备用中文字体已从 Ubuntu 官方包解压到被 Git 忽略的 `data/host-tools/`；启动器会优先查找这个目录。这不是系统级安装，删除 `data/host-tools` 后需要用上面的 apt 命令补齐。

浏览器访问 **http://localhost:36080**。登录信息保存在 `secrets/credentials.txt`，不会打印到日志。

如需本机用户退出登录后及开机继续运行，执行一次：

```bash
sudo loginctl enable-linger "$USER"
```

这让用户服务在无人登录时也能运行；主机仍需保持供电、联网且不休眠。

## 使用 Codex

打开桌面后点击“打开终端”，在已有 tmux 会话中运行 `codex`。需要登录时运行 `codex login`。项目不会读取、改写或复制本机 `~/.codex` 配置，也不会更改审批和沙箱设置。

初始终端只打开 shell，重新连接不会自动启动 Codex、提交指令或重放按键。关闭 xterm 后点击“打开终端”会重新连接原 tmux 会话。

桌面、面板都以当前用户运行，**拥有这个用户的本机文件权限**。独立显示、Xauthority、D-Bus、XFCE 设置和 tmux socket 与物理桌面分开；文件系统和用户身份没有隔离。

## 配置

`.env` 使用 dotenv 格式解析，不作为 shell 脚本执行。初始化保留已有密码和配置。旧版 Docker 配置中的 `CODEX_VERSION`、`desktop_password` 不再使用，可自行移除。

```dotenv
PUBLIC_ORIGIN=http://localhost:36080
ALLOWED_HOSTS=127.0.0.1:36080
ADMIN_USER=admin
PANEL_PORT=36080
AGENT_PORT=36902
DISPLAY_NUMBER=93
DESKTOP_SIZE=1600x1600
WORKSPACE_DIR=./workspaces
TZ=Asia/Shanghai
```

`WORKSPACE_DIR` 可改为现有项目目录，绝对路径直接使用，相对路径以本项目根目录为基准。中转目录固定为该目录下的 `transfer`，面板会显示真实路径。每个文件最大 50 MiB，上传同名文件会原子替换。

显示号被占用时启动器会停止并提示，绝不接管已有桌面或删除其他显示的锁。可选 `RUNTIME_DIR` 指定私有运行目录，默认在 `$XDG_RUNTIME_DIR/codex-on-cloud`，无此变量时使用项目 `data/runtime/codex-on-cloud`。

修改公网域名或面板端口后，只重启面板：

```bash
systemctl --user restart codex-cloud-panel.service
```

网页保存的分辨率优先于 `.env` 中的 `DESKTOP_SIZE`；尚未保存时使用该默认值。修改显示号、工作目录，或手动调整默认尺寸后，需要先结束桌面任务，再重启桌面服务。这会终止原桌面进程及 tmux 任务：

```bash
systemctl --user restart codex-cloud-desktop.service
```

Node/Codex 安装路径发生变化时重新运行 `npm run native:install`，刷新服务捕获的 PATH。该命令不重启正在运行的服务。

## 桌面显示

- “适应窗口”显示整个桌面；“原始比例”按 100% 显示，放大、缩小按钮可在 10%–200% 间调整比例。
- 开启“拖动画面”后，可以用鼠标或单指移动查看区域，也可用滚轮、方向键和 Page Up / Down 浏览。这个模式拦截画面区域的点击和键盘输入，避免误操作远程桌面；再次点击按钮恢复操作模式。
- “收起输入”隐藏输入助手，将空出的高度分配给画面；“展开输入”恢复助手与原来的草稿。
- 全屏时仍可使用显示控制。缩放、拖动和折叠只改变浏览器视图，不调整远程分辨率或重启桌面。
- 显示比例、拖动模式和输入助手状态保存在本浏览器的一个固定偏好条目中，刷新和画面重连后恢复。浏览器禁止本地存储时，控件仍可使用，但刷新后不保留偏好。

## 桌面设置

画面工具栏的“桌面设置”提供 `1280 × 1280`、`1600 × 1600`、`1920 × 1600` 预设，也可输入 320–4096 的自定义宽高，以及 10–28 的终端字号。

- “保存设置”只写入下次使用的配置，窗口分别显示实际分辨率与待应用值。刷新网页、重新连接或保存配置都不会重启桌面。
- “更新字号”按已保存字号重新打开 xterm，保留私有 tmux 中的任务。“最大化终端”和“恢复窗口”只调整本项目终端窗口。
- 应用分辨率需要勾选重启说明，再点击重启按钮。重启会终止原有进程及其他桌面应用。只有一个窗格且能准确识别 Codex `resume` 会话 ID 时，才按该 ID 和项目目录重新打开对话；不会自动继续旧任务或重发提示词。空闲 shell 则打开新的 shell。无法识别的前台任务或多个窗格会阻止应用。

设置保存在被 Git 忽略的 `data/desktop-settings.json`（0600，最多 1 KiB，固定临时文件原子替换）。管理服务独立于面板和桌面，使用私有 Unix socket，仅提供固定动作。操作状态只保留一项，不排队、不自动重试；请求结果不明确时先手动刷新查看。

升级已有部署时运行 `npm run native:install`，再启动管理服务并只重启面板，当前桌面可继续运行：

```bash
systemctl --user start codex-cloud-manager.service
systemctl --user restart codex-cloud-panel.service
```

## 连接状态

顶部“连接状态”分别显示网页服务、桌面服务与画面连接情况，并显示画面实际分辨率、Tunnel 活动连接数及 IPv6 / IPv4 数量。窗口打开时每 5 秒更新，可手动刷新；无法读取 Tunnel 诊断时显示未知，不把它当作桌面停止。

画面断开后会显示“画面重连中”，健康轮询不会将它覆盖为在线。网络不可用、画面未连接或等待接管时，输入按键暂时禁用；草稿保留，恢复后不自动提交。工作台登录过期需要重新登录，外层 Access 验证过期则显示手动刷新入口。

cloudflared 的诊断接口固定监听 `127.0.0.1:36903`，可用 `TUNNEL_METRICS_PORT` 调整。只读汇总经工作台登录保护提供，不公开原始诊断接口；升级到此版本或修改该端口时，需重启面板和 Tunnel，桌面服务独立运行。

## 手机输入

- 先点击桌面里要输入的位置，再使用输入助手粘贴中文或多行文字。
- “终端”模式使用 Ctrl+Shift+V，“其他应用”模式使用 Ctrl+V。
- 粘贴不附带 Enter，确认后单独提交。网络故障后不会自动重试写操作。
- 新标签页会接管桌面，旧页等待手动接管；不会互相不断重连。
- 手机端缩放固定尺寸的桌面，横屏或全屏可以获得更大的操作区域。
- 输入助手保留“正在发送、成功、未发送、结果未知”的状态。结果未知时先查看桌面确认，避免重复执行；网络恢复、刷新或重新接管不会重发输入。
- 一次只执行一项输入或桌面操作，繁忙时直接拒绝新输入。接管、退出或登录过期后，尚未转发的旧页面请求会被拒绝，即使随后又在原页面接管也不会补发。
- 重启桌面和更新字号期间暂停输入并关闭旧画面连接，完成后自动恢复画面；这不会自动提交指令。关闭设置窗口也不会解除操作期间的暂停。

## 取回远程文字

输入助手里的“取回文字”支持从远程桌面复制文字到手机或本机浏览器：

1. 在远程应用执行复制，或在终端用鼠标选中文字。
2. 点击“取回文字”，选择“远程剪贴板”或“选中文字”，再点击“读取远程文字”。两个来源分别读取，不自动互相替代。
3. 确认预览后点击“复制到本机”。浏览器未允许剪贴板写入时，可点击“选择文字”，再长按或使用系统复制操作。

每次最多读取 32 KiB UTF-8 纯文本，保留中文、换行和空白；不支持的内容、超限或超时会提示手动重试。读取不发送按键，不把内容粘贴到输入助手或终端。内容只在当前预览窗口暂存，不进入浏览器存储或服务日志；关闭、切换来源、失去控制权、断网或画面重连会清空预览。重新连接和刷新不会自动读取。

## Cloudflare 外网访问

详见 [Cloudflare 配置](docs/cloudflare.md)。安装固定版本的用户级 cloudflared：

```bash
npm run native:cloudflared
```

它下载官方 `2026.10.0` 程序并校验 SHA-256，保存到 `data/host-tools/usr/bin`。有 API Token 时可直接创建专用 Tunnel 和域名：

```bash
npm run native:publish -- --domain remote-codex.x-wrt.dev --zone x-wrt.dev --api-token-file /tmp/cf_token
```

脚本需要账户 Tunnel 编辑、目标区域 Zone 读取和 DNS 编辑权限，不覆盖无关记录。也可手动配置 Tunnel、HTTPS 域名并把 Tunnel 运行 token 写入 `secrets/tunnel_token`。随后启动：

```bash
systemctl --user restart codex-cloud-panel.service
npm run native:tunnel
```

Tunnel 的上游是 **`http://127.0.0.1:36080`**。不需要开放路由器端口，也不把 VNC 或内部接口直接发布出去。

本机系统 DNS 无法解析 Tunnel 的 SRV 记录时，可只给 Tunnel 配置独立 DNS，配置及 IPv4/IPv6 选项见 [连接排查](docs/cloudflare.md#dns-与-ipv4ipv6)。Tunnel 异常退出后每 10 秒自动重试；桌面不会因此重启。

本机 Tunnel 使用 `TUNNEL_EDGE_IP_VERSION=auto`，已验证解析结果中 IPv6 排在前面，四条边缘连接均通过 IPv6 建立，并保留 IPv4 故障回退。`auto` 随主机解析顺序选择主地址族，部署到其他主机时需核对实际连接；`6` 则表示仅使用 IPv6，详见 [地址族配置](docs/cloudflare.md#dns-与-ipv4ipv6)。

公网入口使用工作台自身的账号密码登录，HTTPS Cookie 带 Secure。Cloudflare Access 是可选的额外身份验证层，配置方式见部署文档。

## 生命周期与运维

| 操作 | 桌面与 tmux 进程 | 文件与 Codex 登录 |
| --- | --- | --- |
| 浏览器关闭、断网或面板重启 | 继续 | 保留 |
| 关闭 xterm 窗口 | tmux 内任务继续 | 保留 |
| 重启/停止桌面服务、主机重启 | 终止；不会自动重放任务 | 本机文件保留 |

```bash
npm run native:status
journalctl --user -u codex-cloud-desktop -u codex-cloud-panel -n 100 --no-pager
# 查看设置操作服务
journalctl --user -u codex-cloud-manager -n 100 --no-pager
# 查看 Tunnel
systemctl --user status codex-cloud-tunnel.service
# 停止全部服务，会终止桌面任务
npm run native:stop
```

桌面服务遇到关键进程退出会整体停止并报告错误，不自动反复重建桌面。恢复前先检查日志，再运行 `npm run native:start`。

## 开发与验证

```bash
npm run check
npm test
npm run test:desktop
CHROME_PATH=/usr/bin/google-chrome npm run test:browser
# 单独的真实 X11 控件验证：使用临时显示、HOME、tmux，不启动 Codex
npm run test:display
```

前端自动化测试连接模拟 RFB 上游，但实际运行 noVNC 客户端与 Unix socket 网关；重启与恢复命令也使用模拟执行器。`test:display` 使用真实 Xvfb、xfwm4、xterm 和 tmux 验证窗口动作与字号替换，不重启正在使用的桌面。`npm run demo` 在 `127.0.0.1:36081` 提供明确标注的模拟桌面，不连接 Codex。

真实桌面已经启动且 tmux 中为**空闲 bash**时，可运行：

```bash
CHROME_PATH=/usr/bin/google-chrome npm run test:native
```

公网 HTTPS 实例可显式添加 `-- --public`；启用了外层 Cloudflare Access 的实例需要先完成相应身份验证，不能直接使用无人值守测试。

这会在终端发送无害的 printf/sleep 命令、验证中文粘贴与断线保活，并重启一次面板，测试完成删除中转测试文件。不要在桌面正在执行任务时运行。结果与待验收项目见 [验证记录](docs/verification.md)。

实现边界见 [架构说明](docs/architecture.md)。参考 WechatOnCloud 的浏览器常驻桌面与手机输入设计，以及 agent-relay 的跨设备、断线不重发需求。浏览器客户端使用 [noVNC](https://github.com/novnc/noVNC)，本项目新增代码采用 MIT 许可，依赖分别遵循自身许可。
