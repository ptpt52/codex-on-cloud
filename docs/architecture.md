# 原生实现

## 进程与显示

三个独立的 systemd 用户服务分别运行桌面、Web 面板和可选 cloudflared。面板对桌面没有 systemd 管理接口，重启面板不影响桌面。桌面关键进程退出时停止本次桌面，不自动重放任务。

桌面 supervisor 创建 Xvfb 显示（默认 `:93`），生成私有 Xauthority，并建立独立 D-Bus。只显式启动 XFCE 窗口管理器、桌面、面板与设置进程，不运行宿主的完整会话自动启动项，避免启动额外的备份、锁屏或电源管理程序。XFCE 配置、缓存、数据保存在项目 `data/desktop`。

VNC 的 Unix socket 位于权限 0700 的运行目录内，socket 权限为 0600。Node 接受连接后将文件描述符交给 `x11vnc -inetd`，x11vnc 不打开 TCP 监听。旧 Ubuntu 的 x11vnc 虽在帮助中列出 `-unixsockonly`，其系统构建可能没有实现，因此不依赖这个选项。

每个观看连接使用一个 x11vnc 进程。断开或接管只结束画面连接，不结束 Xvfb、XFCE、终端和 tmux。新连接替换旧连接，不累积观看进程。

tmux 使用本项目运行目录下的专用 socket，历史行数固定 2000；不会连接宿主默认 tmux server。Codex 使用本机可执行程序、HOME 和权限。项目不修改 Codex 配置，不自动启动任务。

## 浏览器与认证

noVNC `1.7.0` 作为固定 npm 依赖从面板提供，不依赖 CDN 或 websockify 服务。桌面 HTML、脚本、noVNC 资源和 WebSocket 都要求登录。面板将已认证 WebSocket 的二进制流与固定 Unix socket 连接，应用层存在背压，单帧上限 1 MiB，不转发 HTTP Cookie 或 Cloudflare 身份头。

会话令牌只通过 HttpOnly、SameSite=Strict Cookie 发送，HTTPS 增加 Secure。服务端保存令牌哈希，持久化最多 8 个会话，绝对有效期 7 天；密码轮换使旧会话失效。

Host 白名单保护 HTTP 与 WebSocket。写操作验证 Origin 和 CSRF。每页 viewer ID 只用于认领桌面，不能替代登录。新页认领会断开旧流，旧页等待手动接管。会话过期也会关闭现有 WebSocket。

## 固定动作与文件

Python 内部接口只监听 `127.0.0.1:36902`，校验独立 Bearer 密钥，最多 12 个并发工作线程。它只接受固定操作，不接受 shell 命令、程序名或任意文件路径。

输入文字通过 UTF-8 stdin 交给 xclip；xdotool 使用固定参数发送 Ctrl+Shift+V、Ctrl+V 或白名单按键。粘贴和 Enter 分离，网络错误不重试写操作。

文件只来自配置工作目录下的 `transfer`。每个上传最大 50 MiB，同一时间一份上传，下载只接受普通文件。使用目录 fd、O_NOFOLLOW、临时文件和原子替换阻止路径穿越与符号链接跟随。文件列表上限 1000 项，中转文件由用户整理，不自动删除工作文件。

桌面子进程输出限制为每 30 秒 32 KiB，再进入 systemd journal；总保留量由宿主 journald 控制。不记录输入正文或认证令牌。配置、缓存和用户项目位于本机磁盘，用户负责磁盘空间和备份，不设无人观看自动清理。

## 边界

原生部署提供单用户、单桌面、单面板实例。显示会话分开，文件与用户权限共享。没有多租户隔离、主机休眠保活、进程内存恢复或断电后自动恢复 Codex 任务。
