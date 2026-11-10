# 纯网页终端模式

`--mode terminal` 在新部署中省去图形栈，保留网页终端、多终端、历史、文件中转和 TCP 映射。它可组合本机／SSH、单节点 Tunnel 或固定网关入口，见[部署组合](deployment.md)。

## 安装

准备普通 Linux 用户、systemd 用户服务和 Node.js 22+：

```sh
npm run deploy -- --mode terminal --install-deps --enable-linger
```

依赖已齐时省略 `--install-deps`。系统包为 tmux、Python 和 util-linux，npm 安装使用锁文件并省略开发依赖与 noVNC。Codex CLI 可选，安装器不安装或登录 Codex。

本机访问 `http://localhost:36080`，登录信息位于 `secrets/credentials.txt`。域名参数和 Token 准备见[Cloudflare](cloudflare.md)，网页多节点入口见[固定网关](gateway.md)，Windows 主机见[WSL](wsl.md)。

## 与桌面模式的区别

| 内容 | 桌面 | 纯终端 |
| --- | --- | --- |
| XFCE／Xvfb／x11vnc／Xterm | 安装并运行 | 不安装、不启动 |
| 网页终端、终端管理、历史 | 支持 | 支持 |
| 文件、网络直连／回退、TCP 映射 | 支持 | 支持 |
| 远程桌面剪贴板、桌面分辨率 | 支持 | 不适用 |
| 任务宿主 | `codex-cloud-desktop.service` | `codex-cloud-terminal.service` |
| 其余核心服务 | actions、manager、files、panel | manager、files、panel |

登录直接进入终端，不读取旧浏览器的桌面模式选择。原终端 shell 由私有 tmux 持有，网页和面板只提供观看、输入及管理。

## 生命周期

关闭网页、重连或更新 panel／manager 不主动结束原 shell。明确结束终端、停止／重启 terminal 宿主或重启主机会影响任务。所有用户终端关闭后，宿主仍保留；只有明确新开才创建新 shell，不自动重新提交旧工作。

模式在首次部署时确定，已有桌面不能在线转换成纯终端。终端数默认 4、最多 8，调整方法见[配置参考](deployment-config.md#终端数量)。恢复、锁和服务关系见[生命周期](reliability.md)，隔离测试见[验证说明](verification.md)。
