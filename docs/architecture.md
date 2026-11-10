# 架构与安全边界

每套部署面向一位管理员，运行在自己的 Linux 用户和工作区。客户端使用浏览器，访问入口与工作区模式独立组合，见[部署选择](deployment.md)。

## 组件

```mermaid
flowchart LR
    B[浏览器] --> E[本机 / SSH / 自有 CF 入口]
    E --> P[已认证面板]
    P --> M[管理器与固定动作]
    P --> F[文件服务]
    P --> H[任务宿主与私有 tmux]
    M --> H
    H --> D[桌面模式: Xvfb / XFCE / x11vnc]
    H --> T[纯终端模式: tmux / PTY]
```

面板、helper 监听回环，公网 Tunnel 使用私有 Unix 接口；VNC 不开启公共 TCP 监听。桌面模式有独立显示、Xauthority、D-Bus、XFCE 设置与 tmux socket，和物理桌面分开。**Linux 用户与文件系统没有沙箱隔离**，工作台拥有部署用户本身的权限。

## 生命周期

宿主持有任务，面板和浏览器持有观看／输入连接。关闭浏览器、切换网络或重载 panel 不主动结束任务。明确结束终端或重启宿主会影响相应程序；恢复连接不自动启动 Codex、重发输入或审批。[服务关系](reliability.md)

桌面部署包括 desktop、actions、files、manager、panel；纯终端包括 terminal、files、manager、panel。Tunnel 是可选入口组件，不是任务宿主。

## 认证与权限

HTTP 与 WebSocket 保留登录、Host、Origin 和 CSRF 检查。Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下使用 Secure；服务端持久化会话哈希，不向 VNC 或浏览器返回内部密钥。

控制权绑定登录、页面与观看代次，接管使旧页面停止输入。屏幕锁和临时账号在服务端限制终端、画面、剪贴板、文件及映射权限，具体见[访问权限](access.md)。

内部 helper 只接受固定动作，不把浏览器输入插入 shell 命令。文本粘贴与 Enter 分开，执行回复未知时不自动重试。

## 网络路径

HTTPS／WSS 提供登录、控制和中转；网络条件允许时，WebRTC 使用可靠、有序 DataChannel，配合认证协商与 DTLS。直连失败可回退，输入不能被两条路径重复执行。候选、UDP 范围和背压限制见[网络说明](lan.md)。当前未集成 TURN 或自建 VPS 中继。

固定网关增加 Worker 与独立 SQLite DO：DO 保存动态节点目录和默认路由，不保存终端或文件流。Worker 验证后端身份并流式转发；节点只在私有接入口接受其代理凭据，随后继续验证浏览器 Origin、CSRF 与节点身份。旧页面和下载不能在路由切换后操作另一节点。[网关](gateway.md)

## 状态与边界

| 位置 | 内容 |
| --- | --- |
| `.env`、`secrets/` | 本部署配置、私有凭据 |
| `data/` | 有界的设置、身份、会话、发布／恢复记录和构建产物 |
| `WORKSPACE_DIR` | 部署用户的项目与 `transfer` 中转目录 |
| 浏览器 | 有界显示偏好、当前标签页草稿；无终端录制 |
| 自己的 CF 账户 | Tunnel、DNS；网关模式另有 Worker 和 DO |

这些运行数据不进入 Git。新持久状态、队列、上传和日志必须有明确资源边界；当前文件上传单文件 50 MiB，终端最多 8 个，输入上限及协议限制由代码校验。私有状态写入采用内核租约、预期内容比较和原子发布，不盲目覆盖人工修改。[配置参考](deployment-config.md)

固定版本依赖由锁文件与安装脚本管理。故障恢复不默默升级依赖，也不改写用户 Codex 配置。测试使用真实组件与 fixture 的范围分别说明，见[验证方法](verification.md)。
