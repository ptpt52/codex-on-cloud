# 本机与局域网加密直连

浏览器继续访问 `https://remote-codex.x-wrt.dev`。无需另备本地 HTTPS 证书、修改路由器 DNS 或安装客户端 CA：网页和连接协商使用现有 HTTPS 入口，noVNC 的画面与原生键鼠字节通过 WebRTC DataChannel 直连主机。

```text
浏览器 ── HTTPS：登录、协商、管理 API ── Cloudflare / Tunnel ── 面板回环接口
   └──────── 局域网 UDP：ICE + DTLS + SCTP ───────────────┘
                                                       ↓
                                               私有 VNC Unix socket
```

## 当前支持

- 同一台主机或可互通的 IPv4 局域网优先尝试加密直连。
- 连接状态窗口的“画面路径”显示实际使用的“WebRTC 加密直连”或“HTTPS / WebSocket 中转”。不是根据地址猜测结果。
- 直连协商最多等待 8 秒；失败或连接断开后，本次画面生命周期回退到既有 WebSocket。刷新页面可重新尝试直连。连接恢复只建立新画面，不补发提示词、粘贴、Enter、审批或其他输入。
- 画面、noVNC 原生键鼠，以及输入助手的粘贴、白名单按键和剪贴板读取支持加密直连。“输入助手路径”单独显示实际路径。登录、健康轮询、打开终端、桌面管理及文件 API 仍使用 HTTPS；网页初次打开仍依赖公网入口可达。
- 第一阶段不使用外部 STUN 或 TURN，不做公网打洞，也不承诺跨网直连。外网、AP 客户端隔离、防火墙或浏览器策略阻止 UDP 时使用原有 WebSocket。

WebRTC 使用标准 DTLS 加密，不另设计密码协议。临时证书不需要浏览器 CA 信任；双方通过已认证 HTTPS 协商证书指纹，再在 DTLS 握手中校验指纹。该安全性仍依赖 HTTPS 页面与协商入口可信。Cloudflare 参与页面、协商和管理 API；直连的画面字节不经过它。[WebRTC Data Channels 标准](https://www.rfc-editor.org/rfc/rfc8831.html)、[WebRTC 浏览器规范](https://www.w3.org/TR/webrtc/)

现有 WebSocket 回退使用原有 HTTPS/WSS 链路，不等同于 WebRTC 两端之间的 DTLS 加密。后续接入 TURN 后，TURN 可转发 DTLS 密文；当前未部署 TURN。

## 配置和端口

默认启用，可在 `.env` 中关闭或明确指定本机接口：

```dotenv
WEBRTC_ENABLED=1
# 可选；不填时选择本机第一个私有 IPv4，找不到则使用回环。
WEBRTC_LAN_ADDRESS=192.168.16.224
```

多网卡、VPN 或容器网桥环境建议明确指定 LAN 地址；必须是本机已分配的 RFC 1918 私有 IPv4 或回环地址。DHCP 地址变化后需更新配置并重启面板，建议在路由器预留地址。主机本身的浏览器也可连接该 LAN 地址。

WebRTC 仅在协商时绑定指定地址的 **UDP 40000–40015**，不监听公共 TCP VNC 端口。主机防火墙如需放行，只允许可信 LAN 网段访问此 UDP 范围；不配置路由器公网端口转发。浏览器 mDNS 地址解析可能使用局域网 UDP 5353。面板 `127.0.0.1:36080`、helper 回环地址、VNC 私有 Unix socket 以及 Tunnel 的 IPv6 优先出站策略保持原状。

运行 `npm ci` 安装锁定的 `werift@0.26.0`，再只重启面板：

```bash
systemctl --user restart codex-cloud-panel.service
```

关闭直连时设置 `WEBRTC_ENABLED=0` 并重启面板。桌面、tmux 和 Codex 会话独立运行。

## 认证与资源界限

协商接口要求有效登录、Host、Origin、CSRF 及当前页面控制权。延迟请求体、协商过程中发生接管或退出均不能获得旧控制权。WebRTC 与 WebSocket 共用单一画面连接、退出、登录到期、接管和桌面维护的关闭机制；数据转发前再次检查授权，不将 Cookie 或 CSRF 发给 VNC。

只接受一个 data m-section、有 SHA-256 指纹的 SDP；请求体最多 48 KiB，SDP 最多 32 KiB，最多保留 8 个私有 IPv4 或单标签 `.local` 的 UDP host 候选。候选配对和 STUN 响应再次限定为私有 IPv4。只允许各一个可靠、有序的 `codex-vnc` 和 `codex-control` 数据通道，不接受媒体或任意代理目标。

控制通道仅分派 `paste`、`key`、`clipboard` 三种固定动作，每次处理前校验会话和页面认领对象，读取返回前再次校验。沿用私有管理 socket、输入互斥锁、文字 32 KiB 上限、固定快捷键及独立 Enter。请求 ID 单调递增，重复、并发或无权限的消息关闭控制通道，不重复执行。控制请求发出后，即使断线、超时或页面切换，也不会换成 HTTP 重发；后续新的明确操作才可使用 HTTP 回退。

控制 JSON 记录最多 256 KiB，按最多 16 KiB 二进制消息分块，单个长度前缀限定接收缓冲；每端仅一个待完成请求，发送缓冲上限 512 KiB，客户端等待最多 8 秒。取消读取会关闭控制通道并丢弃迟到结果；观看连接仍可继续，后续操作可走 HTTPS。iframe 消息同时验证来源、父窗口、页面代次及请求 ID；正文只暂存在请求和预览中，不写入浏览器存储或服务日志。

每次仅一项协商、一个活动 peer；替换时先关闭原 peer。连接建立窗口最多 10 秒，活动连接受登录有效期约束。消息最多 64 KiB，画面切为 16 KiB 消息，应用发送高水位 256 KiB，暂停读取上游形成背压；终端方向超过 256 KiB 就关闭连接，不排队重试。没有新增持久化证书、SDP、候选缓存、终端内容或连接日志。

## 验证与后续

自动化测试使用真实 Chrome、noVNC、WebRTC、DTLS 和 UDP，桌面源为模拟 RFB；检查加密状态、无需 WebSocket 的画面、接管、草稿保留和故障回退。Node 测试覆盖协商认证、延迟请求、候选与大小限制。这些测试不能代替另一台 LAN 设备的验收。

实际验收时，手机与主机连接同一局域网，打开原来的 HTTPS 域名，查看“连接状态 → 画面路径”。再使用蜂窝网络确认能回退至中转。不要把 HTTPS 首次请求时间当作画面交互延迟。

后续可接入有独立凭据与配额的 TURN，提供跨网加密中转；若需要断网时完整访问网页和所有 API，仍需另行部署浏览器可信的 LAN HTTPS 入口及单域名 DNS 覆盖。后者可用 ACME DNS-01 签发，无需开放公网网站端口。[Let's Encrypt DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)
