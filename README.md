# Codex on Cloud

在自己的 Ubuntu 电脑上运行一个独立开发桌面，出门后用手机或平板浏览器继续操作 Codex。

当前版本提供单用户、单桌面：登录面板、KasmVNC 桌面代理、手机中文粘贴、常用按键、文件中转、tmux 会话和可选 Cloudflare Tunnel。桌面不挂载 Docker socket，浏览器离开不会主动停止任务。

**验证范围：**已在本地验证面板与内部接口、HTTP/WebSocket 代理，以及手机和桌面浏览器的完整操作流程。当前开发环境未安装 Docker，因此真实桌面镜像构建、KasmVNC 串流、Codex 登录与外网连接尚待实机验证。`npm run demo` 使用明确标注的模拟桌面，不代表实际桌面串流成功。

## 架构

```text
手机 / 平板浏览器
        │ HTTPS
Cloudflare Access（个人账号验证）
        │
Cloudflare Tunnel（Ubuntu 主动出站连接）
        │
Web 面板（登录、凭据注入、HTTP / WebSocket 代理）
        │ 私有 Docker 网络
开发桌面容器（KasmVNC + XFCE + xterm + tmux + Codex）
        ├── 持久化用户目录 /home/kasm-user
        └── 宿主项目目录 → /workspace
```

本地模式不需要 Cloudflare。桌面容器不发布端口，只有面板的 `127.0.0.1:36080` 映射到宿主。远程模式由 `cloudflared` 直接连接面板。

## 环境

- Ubuntu / Linux 主机，Docker Engine 和 Docker Compose v2。
- x86_64 或 ARM64；桌面基础镜像同时提供两种架构。
- Node.js 22+，用于初始化和开发。容器内自带 Node.js。
- 首版默认桌面和面板进程使用 UID `1000`。宿主绑定的工作目录及 `secrets/` 文件必须对这个 UID 可读写；默认 Ubuntu 首个用户通常就是 `1000`。
- 主机保持供电、联网且不休眠。

## 本地启动

```bash
cd /home/ptpt52/Sources2/codex-on-cloud
npm ci
npm run setup
docker compose up -d --build
```

访问 `http://localhost:36080`。登录信息保存在 `secrets/credentials.txt`，初始化不会把密码打印到终端。`.env`、密钥、数据和项目目录均被 Git 忽略。

桌面首次出现后：

1. 在面板点击“打开终端”。终端会连接名为 `codex` 的 tmux 会话。
2. 在终端执行 `codex login --device-auth`，按提示用手机浏览器完成登录。该方式需要你的账号或工作空间允许设备码登录。
3. 执行 `codex`，开始工作。后续打开终端会连接原会话。

也可以在容器中的终端使用其他 Codex 登录方式。工作台登录和 Codex 登录是两个不同的身份；面板不会读取或转发 Codex 的登录文件。

初始化脚本再次执行时会保留原配置和密钥，不自动覆盖。

### 项目目录

默认宿主的 `./workspaces` 映射为容器内 `/workspace`。可以先把仓库克隆到这个目录，或修改 `.env`：

```dotenv
WORKSPACE_DIR=/home/your-user/projects
```

修改后运行 `docker compose up -d`。容器拥有该目录内的读写权限。宿主原有软件和登录状态不会自动出现在容器中，需要在桌面镜像或用户目录内配置开发环境。

### 手机输入和文件

- 先点击桌面里需要输入的位置，再在“输入助手”中输入或粘贴中文、多行指令。
- “终端”模式发送 `Ctrl+Shift+V`；“其他应用”模式发送 `Ctrl+V`。**只粘贴，不自动按 Enter。**
- `Enter`、`Tab`、`Esc`、`Ctrl+C` 和方向键有独立按钮。
- 通过“文件中转”上传和下载 `/workspace/transfer` 中的普通文件，每个文件最多 50 MiB。同名上传会原子替换旧文件；下载链接不接受目录或符号链接。
- 新页面打开桌面会接管旧页面；旧页面停止自动抢回，需要用户点击“在这里继续使用”。

## Cloudflare 外网访问

需要 Cloudflare 账号及托管域名。完整步骤见 [Cloudflare 部署](docs/cloudflare.md)。

1. 创建 Tunnel，路由例如 `desktop.example.com` → **`http://panel:8080`**。
2. 为此域名创建 Access 应用，只放行你的账号，并启用 Tunnel 的 Access 令牌验证。
3. 修改 `.env` 的 `PUBLIC_ORIGIN=https://desktop.example.com`。
4. 将 Tunnel token 写入 `secrets/tunnel_token`，保持文件私密。
5. 启动：

```bash
docker compose --profile cloudflare up -d --build
```

随后手机浏览器访问 `https://desktop.example.com`，完成 Access 验证和工作台登录即可。

## 持久化和重启语义

| 内容 | 保存位置 | 浏览器离开 | 容器重建 |
| --- | --- | --- | --- |
| 项目与中转文件 | 宿主 `WORKSPACE_DIR` | 保留 | 保留 |
| Codex 配置、登录、历史 | `desktop-home` 数据卷 | 保留 | 保留 |
| 面板登录状态 | `panel-data` 数据卷 | 保留到过期 | 保留 |
| tmux、运行中的 Codex | 桌面容器内存 | 继续执行 | **进程终止** |

单独重建面板不会主动重启桌面。桌面没有根据观看人数触发的自动重启，也没有内存超限“自愈”脚本。容器进程异常退出时由 Docker 按 `unless-stopped` 恢复服务，**不会自动重新提交上一次任务**。

不要使用 `docker compose down -v` 作为日常停止命令，`-v` 会删除命名数据卷。正常暂停可使用 `docker compose stop`；这会中断桌面中的运行任务。

## 开发与验证

```bash
npm ci
npm run check
npm test
npm run test:desktop
npx playwright install chromium
npm run test:browser
```

已有兼容 Chrome 时可指定：

```bash
CHROME_PATH=/usr/bin/google-chrome npm run test:browser
```

测试覆盖：登录及过期、CSRF、Host / Origin 验证、代理凭据隔离、WebSocket 接管、会话持久化、文件穿越与符号链接、中文输入、手机与桌面操作流程。

无需 Docker 的界面演示：

```bash
npm run demo
```

演示只监听 `127.0.0.1:36081`，使用临时数据和固定测试密码（启动时显示），不会连接 Codex、运行系统命令或使用真实凭据。

真实部署后还需要按 [实机验收](docs/verification.md) 验证桌面启动、手机输入、断线继续任务、Codex 沙箱在容器中的可用性和 Cloudflare 链路。

## 运维

```bash
docker compose ps
docker compose logs --tail=100 panel desktop
# 只更新面板，保留桌面任务
docker compose up -d --build --no-deps panel
```

升级 Codex：显式修改 `.env` 中的 `CODEX_VERSION`，结束正在执行的任务后重建桌面：

```bash
docker compose build desktop
docker compose up -d --no-deps desktop
```

桌面、Node 和 Cloudflare 镜像已固定到摘要；Codex npm 包固定版本。系统 apt 依赖在构建时更新，因此不同时间重建的系统软件可能不同。升级前保留旧镜像，按实际构建验证后再切换。

## 代码结构

```text
panel/          Node.js 网关、持久登录和手机界面
desktop/        开发桌面镜像、固定操作接口、tmux 启动脚本
scripts/        初始化、语法检查和模拟演示
test/           网关集成、内部接口和浏览器测试
docs/           Cloudflare 配置、架构与实机验收
compose.yaml    桌面、面板和可选 Tunnel
```

## 参考

- WechatOnCloud：浏览器访问常驻应用、服务端注入桌面凭据、手机输入与多页面接管的设计参考。
- agent-relay：Codex 跨设备操作需求及断线不重发任务的设计参考。
- [Kasm 官方镜像](https://docs.kasm.com/docs/how-to/workspaces-sessions/container-workspace/custom-images)和 [KasmVNC](https://github.com/kasmtech/KasmVNC)。
- [Codex CLI](https://learn.chatgpt.com/docs/cli)与[认证](https://learn.chatgpt.com/docs/auth)。
- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/) 与 [Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

本项目新增代码采用 MIT 许可。依赖及容器软件分别遵循其自身许可。
