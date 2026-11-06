# 纯网页终端部署

新部署支持 `--mode terminal`，只运行网页终端及其后台，不启动虚拟桌面。默认 `--mode desktop` 保留原有完整桌面行为。模式保存在 `.env` 的 `DEPLOY_MODE`，未配置的旧部署按桌面模式处理；重复部署沿用已有选择。

## 安装

准备普通 Linux 用户、可用的 systemd 用户服务、Node.js 22+ 和已安装的 Codex CLI，然后运行：

```sh
git clone https://github.com/ptpt52/codex-on-cloud.git
cd codex-on-cloud
npm run deploy -- --mode terminal --install-deps --enable-linger
```

系统依赖已齐时可省略 `--install-deps`。`--enable-linger` 用于无人登录时的开机自启，需要 sudo；系统安装步骤也需要 sudo，其余操作以普通用户执行。只检查终端模式的依赖可用 `npm run deploy -- --mode terminal --check`，不会转换已有配置、安装软件或改变服务。

本机入口为 `http://localhost:36080`，登录信息只保存到 `secrets/credentials.txt`，不打印密码。面板和内部文件助手仍只监听回环。远程访问继续使用 SSH 本地端口转发，或原有 `--domain / --zone / --api-token-file` Cloudflare 部署参数。端口映射助手构建仍为可选的 `--build-forward`，只有构建助手才需要 Go。

安装器不安装、登录或修改 Codex，不改写用户 Codex 配置。首次只打开 shell；用户自行运行 Codex，重连不提交提示、输入或审批。

## 省去的组件

| 内容 | 桌面模式 | 纯终端模式 |
| --- | --- | --- |
| 运行基础 | Node.js、Codex、tmux、Python、Bash、systemd 用户服务 | 相同 |
| 图形系统 | Xvfb、x11vnc、XFCE、Xterm | 不安装、不启动 |
| 桌面输入与选区 | xdotool、xclip、xauth、X11 工具 | 不安装、不调用 |
| 桌面字体与 D-Bus 图形会话 | fontconfig、中文字体、独立图形 D-Bus 会话 | 不安装、不启动 |
| 网页桌面库 | noVNC | 跳过安装 |
| 开发测试依赖 | 默认 npm ci 安装 | 跳过安装 |
| 常驻项目服务 | desktop、actions、manager、panel | terminal、manager、panel |
| 公网入口 | 可选 Tunnel | 相同 |

轻量模式按锁文件执行 `npm ci --omit=dev --omit=optional`；noVNC 固定版本改为可选依赖，完整桌面安装仍包含它。网页终端所需的 xterm.js、WebSocket、WebRTC 和认证模块保留。系统包安装列表仅为 `tmux python3`，Node/Codex 和系统基础组件需预先具备。主要节省来自整套图形系统、字体与常驻图形进程；没有给出未经量测的内存或安装体积百分比。

## 功能与生命周期

登录后直接进入网页终端，忽略浏览器以前保存的桌面模式；隐藏桌面切换、分辨率设置和系统远程剪贴板入口。终端选字/历史复制、本机粘贴、独立 Enter、组合键、字号和宽度适配、四个终端名额、文件传输、WSS/WebRTC 及双向 TCP 映射继续可用。

`codex-cloud-terminal.service` 持有私有 tmux 服务和回环文件助手，manager 只管理固定终端名额，panel 只负责认证与浏览器连接。关闭网页、刷新、重连、重启 panel 或 manager 不结束原 shell。主终端退出后，可在终端管理中明确新建终端以重新打开主终端；不会静默恢复退出的 shell，也不会影响辅助终端。

任务边界仍为主终端与三个辅助终端。额外只有一个固定、不接收网页输入的 `codex-host` 保活会话，防止所有用户终端退出后 tmux 由管理器重新创建而改变服务归属。私有运行目录为 0700，新增 `terminal.pid` 最多 32 字节、0600；tmux socket 与物理桌面分开。现有历史、消息、缓冲、上传和映射上限保持，未新增任务队列、录制或输入日志。

Ubuntu 等发行版的 tmux 带有 systemd 集成，默认会将窗格任务移入独立的 `tmux-spawn-*.scope`。终端宿主只为自己的私有 tmux 服务进程禁用用户 D-Bus 连接，并在创建任何窗格前清除 shell 环境中的该覆盖，使保活、主终端和辅助任务留在宿主服务的 cgroup 内。用户 shell 仍可从自己的 `~/.bashrc` 配置 D-Bus；无需更换系统 tmux、安装额外依赖或修改系统 D-Bus。

显式停止或重启 terminal 服务、主机重启会结束其中的任务。terminal 服务不自动重建任务；panel 继续采用已有的有限故障恢复策略。端口映射内存授权仍随 panel 重启失效，需重新配对。

已有桌面部署不会自动切换为纯终端；请求不同模式或检测到另一种宿主服务仍在运行时，安装器会停止转换，保留当前任务。此功能用于选择新部署形态，不会删除现有图形包，也不会修改当前运行实例的模式。

## 验证

```sh
npm run check
npm test
npm run test:desktop
npm run test:terminal-only
CHROME_PATH=/usr/bin/google-chrome npm run test:browser -- test/browser/terminal-deployment.spec.mjs
```

`test:terminal-only` 在临时目录按生产依赖安装，确认没有 noVNC 或 Playwright；运行真实 tmux、Bash、PTY、Python 文件助手、manager 和 panel，并以会失败的图形命令替身确认不调用 X11。它检查文件传输、名额边界、窗口关闭、面板/管理器重启后的任务身份及 shell 环境、主终端显式重开和宿主停止清理。Codex 只是仅支持版本查询的替身，不启动真实任务；不安装 systemd unit、不改生产配置。

浏览器用例使用真实页面、xterm.js 与加密传输，管理和终端上游为 fixture。它们与真实 PTY、真实 systemd 安装及真实 Codex 使用分别记账，不能互相替代。

本机具备 systemd 用户管理器时，可额外运行 `TERMINAL_TEST_SYSTEMD=1 npm run test:terminal-only`。它只创建唯一命名的临时测试服务，验证 tmux、保活和主/辅助任务确实属于终端宿主的 cgroup，用户 D-Bus 环境不受覆盖，停止整个 panel/manager 测试 cgroup 后原任务仍保留。另检查停止宿主可清理忽略 HUP/TERM 的任务，以及宿主被 SIGKILL 后的 cgroup 清理；不会安装或停止生产 unit。
