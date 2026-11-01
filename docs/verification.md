# 验证记录与实机验收

## 当前开发环境

2026-11-01，开发机为 Ubuntu 18.04，Node.js 24，Chrome 137。没有可用 Docker 命令 / daemon。

已运行：

- JavaScript、Python、Bash 脚本语法检查。
- 使用独立的 Docker Compose v2.39.4 CLI 验证完整 Compose 配置（包括 Cloudflare profile）；不连接 Docker daemon。
- Node.js 集成测试：真实 HTTP/WebSocket 网关，模拟桌面与内部接口上游。
- Python 内部接口测试：真实 HTTP 请求、文件写入、符号链接与输入命令参数验证；X11 动作通过测试替身验证。
- Playwright：手机 390×844 和桌面 1440×1000，登录、桌面 iframe、WebSocket、中文粘贴、独立 Enter、上传下载、退出、多页面接管。

结果：7 项 Node.js 集成测试、7 项 Python 接口测试、4 项浏览器测试全部通过。20 个脚本通过语法检查，桌面 Shell 脚本通过 ShellCheck；使用生成的真实本地配置验证面板启动、登录和会话读取正常。

浏览器测试生成的画面明确标注“模拟上游”。这些检查不能代替真实 KasmVNC、Docker、X11、Codex 和 Cloudflare 的联合验证。

## 有 Docker 后的必做验收

### 构建与启动

```bash
npm run setup
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

确认 desktop 与 panel 均健康，桌面里能打开终端，`codex --version` 正常，`/workspace` 可以创建文件。使用实际需要的审批 / 沙箱配置验证命令执行；容器内命名空间支持取决于宿主和 Docker 配置，不把自动批准或关闭沙箱作为默认修复。

### 中文与焦点

1. 选中终端，粘贴中文、多行文本、反引号和 `$()`。
2. 确认文字完整且只出现一次；未按 Enter 前没有执行。
3. 检查终端粘贴模式、Esc、Tab、Ctrl+C 和方向键。
4. 使用“其他应用”模式对普通文本编辑器测试 Ctrl+V。

### 断线保活

1. 在 tmux 终端里启动一个需要数分钟的普通任务，或经你授权的 Codex 任务。
2. 关闭浏览器、锁屏、Wi-Fi 切换蜂窝网络。
3. 重新打开桌面，确认原进程仍在，输入没有被自动重放。
4. 关闭 xterm 窗口后点击“打开终端”，确认回到原 tmux 会话。
5. 单独重建面板，确认桌面任务不被结束，工作台登录仍有效。

### 持久化

先结束运行中的任务，再重建 desktop，确认项目文件、Codex 登录与历史仍在；确认不会自动重启之前的任务。

### 外网

按 Cloudflare 文档配置 Access 和 Tunnel，然后用手机蜂窝网络验证登录、桌面、中文输入、文件与接管。记录网络延迟与断线重连体验。

### 升级

保留前一版桌面镜像与 home 卷备份。新版本先在独立环境中验证现有 home 卷，再升级工作桌面。不要在任务执行中重建 desktop。
