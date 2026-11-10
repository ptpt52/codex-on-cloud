> 历史归档：本文记录特定时间、环境或未实施方案，不是当前部署指南。请从[文档目录](../README.md)选择部署方式。

# TURN 中继与自有 VPS 公网入口：设计和实施规划

状态：待实施。基于提交 `77502e1`（2026-11-07）的代码分析；本文中的新增配置、接口、脚本和测试名称均为设计，不代表当前版本已支持。

实施顺序确定为：**先改造现有系统，支持经过认证的 TURN 中继；再提供自有 Linux VPS 公网入口，允许用户在 Cloudflare 和自建入口之间选择。** STUN/TURN 与公网入口分别配置，可以逐阶段交付。

## 1. 目标和范围

- 现有 Cloudflare 部署先获得 TURN 能力，不要求同时更换公网入口。
- 自建方案由 VPS 上的 Caddy、frps、coturn 和本地机器上的 frpc 组成；支持纯终端与桌面两种运行模式。
- VPS 提供 HTTPS/WSS 入口、反向隧道和可选的 STUN/TURN。本地机器继续保存工作区、Codex 登录和任务，提供前端及业务 API。
- WebRTC 支持直连和 TURN；HTTPS/WSS 保留为网页、管理接口及连接回退通道。
- 完全自建时，域名直接解析到 VPS，STUN/TURN 也使用自建服务，运行时不依赖 Cloudflare。

首版以单用户、单本地实例、单公网域名为边界。不建设多租户平台、公共 TURN 服务、通用开放代理或自研反向隧道。不把公网 IPv4 打洞、ICE-TCP 或 RFC 6062 TCP allocation 作为 TURN 接入的附带功能。

## 2. 当前代码和改造依据

| 位置 | 当前行为 | 需要的改造 |
| --- | --- | --- |
| `panel/rtc-network.mjs` | 单个 UDP STUN URL；拒绝 relay 和公网 IPv4 候选 | 分离直连与 relay 策略、严格解析 ICE 配置和候选 |
| `panel/rtc.mjs`、`panel/forward-rtc.mjs` | werift 使用空 `iceServers`，过滤候选对和探测来源 | 两端 ICE 配置、TURN transport、候选对与接收保护适配 |
| `panel/rtc-guard.mjs` | 清除依赖默认 STUN，在 UDP 接收入口校验 ICE HMAC、ufrag 和授权 | 分开处理 TURN 外层协议与解封装后的 ICE/DTLS 数据 |
| `panel/server.mjs`、`panel/config.mjs` | `/api/me` 返回 STUN；协商要求登录、当前控制权及 CSRF | 有权限的临时凭据签发、协商绑定及配置兼容 |
| `panel/public/rtc.js`、`rtc-stats.js`、`viewer.js`、`terminal.js` | 浏览器使用单个 STUN，候选收集上限 1.5 秒；界面主要区分直连/WSS | TURN 凭据、收集期限、路径分类及切换策略 |
| `panel/forward.mjs`、`client/forward/direct.go` | `rtc_config` 只传 STUN；Go/Pion 同样过滤公网 IPv4/relay，配置只接收一次 | 协议能力协商、临时配置更新、Go 候选和路由策略 |
| `scripts/deploy.mjs`、`native/tunnel.mjs`、`native/service-units.mjs` | 安装、启动及服务描述绑定 cloudflared | 公网入口选择与 frpc 安装、启动、迁移 |
| `panel/diagnostics.mjs`、`panel/public/app.js` | 读取 cloudflared 固定诊断接口 | 按提供方诊断，独立显示公网入口、TURN 和实际业务路径 |

目前 Node 依赖固定为 `werift@0.26.0`；Go 助手使用 `pion/webrtc/v4@v4.2.26`。服务端显式禁用依赖隐含的默认 STUN。因此 TURN 不能只靠修改一个 URL 或移除 SDP 中的 relay 过滤来实现。

## 3. 两阶段架构

### 第一阶段：保留现有入口，增加 TURN

```text
浏览器 ── HTTPS/WSS ── 现有入口（Cloudflare 或本地 HTTPS）── 本地面板
   │                                                        │
   ├──────────── WebRTC 直连：ICE / DTLS / SCTP ──────────────┤
   │                                                        │
   └──── TURN 客户端连接 ── coturn VPS ── TURN 客户端连接 ─────┘
```

浏览器、Node 面板和 Go 助手按需使用 TURN。验证必须包含两端都只能经 TURN 连接的情况，不能只验证“浏览器有 relay 候选”。网页首次加载、认证和 SDP 信令继续依赖 HTTPS 入口。

### 第二阶段：自有 VPS 承担完整公网入口

```text
浏览器 ── HTTPS/WSS :443 ── Caddy ── 127.0.0.1:37080 ── frps
                                                        ▲
                                        本地主动建立 TLS 隧道 :7000
                                                        │
                                                       frpc
                                                        │
                                              127.0.0.1:36080 面板

浏览器 / Go 助手 ── WebRTC 直连或同一 VPS 上的 coturn ── 本地面板
```

隧道由本地发起，业务流量双向传输。本地不需要公网 IP 或路由器端口映射。VPS 上不安装 Codex、桌面栈或项目工作区。

STUN 负责地址发现；TURN 转发 DTLS 密文；frp 转发面板的 HTTP/WebSocket。三者分别承担不同职责，TURN 不能替代网页与 API 的公网入口。

## 4. 第一阶段：TURN 能力设计

### 4.1 配置和兼容

建议新增以下配置；具体 schema 在第一个实现变更中固定：

```dotenv
# 当前行为在未配置 TURN 时继续保持。
WEBRTC_ENABLED=1
WEBRTC_STUN_URL=stun:stun.example.com:3478
# 应用路径策略，取值 direct / auto / relay。
WEBRTC_ROUTE_POLICY=auto
# 服务器、relay 地址和凭据文件路径；不是浏览器可编辑的配置。
WEBRTC_TURN_CONFIG_FILE=./secrets/turn.json
```

| 策略 | 行为 |
| --- | --- |
| `direct` | 只尝试当前允许的直连候选，失败使用 WSS；不申请 TURN allocation |
| `auto` | ICE 同时具备直连和 TURN 能力，通常优先直接候选；以实际选中的候选对判定路径，失败使用 WSS |
| `relay` | 使用 ICE 的 relay-only 策略，失败使用 WSS；用于受限网络及验收 |

`direct/auto/relay` 为应用策略；浏览器标准 `iceTransportPolicy` 仍只使用 `all/relay`。`direct` 通过不配置 TURN 并过滤 relay 实现。未设置新策略时默认 `direct`，旧部署保持原行为；显式选择 `auto/relay` 时要求有效 TURN 配置，配置错误应明确拒绝，不能静默切换策略。`WEBRTC_ENABLED=0` 优先于上述全部配置。

TURN 配置描述固定服务器 URL、允许的 relay 公网 IP 和端口范围、realm、共享密钥文件路径。生产 URL 支持目标为 `turn:…?transport=udp`、`turn:…?transport=tcp`、`turns:…?transport=tcp`；每一种都必须通过依赖兼容和真实测试后才开放配置。URL 不包含用户名或密码，不允许任意路径、查询参数、重定向或客户端指定服务器。

继续支持原 `WEBRTC_STUN_URL`，允许为空。TURN 不依赖 `WEBRTC_IPV6=1`：纯 IPv4 网络也必须能通过配置的 TURN relay 工作。第一阶段允许使用已有 coturn，提供手工部署说明；第二阶段再自动化两端安装。

### 4.2 依赖验证是第一项交付

保持现有依赖固定版本，先验证以下能力：

1. werift、Pion 和目标浏览器分别申请 UDP allocation，完成 relay-to-relay DataChannel。
2. 客户端到 TURN 的 UDP、TCP、TLS 连接及可信证书验证；TCP/TLS 接入仍可以承载 UDP relay allocation，不等于 ICE-TCP。
3. TURN 的认证挑战、Refresh、CreatePermission、ChannelBind、关闭释放，以及超时、错误凭据和证书错误。
4. werift 的 TURN socket、解封装入口与现有 ICE guard 的调用顺序；明确哪些接收器会被当前保护包装。
5. 同一 coturn 上的双端 allocation、IPv4/IPv6 relay 地址、端口范围，以及后台 peer 的资源释放。

若固定 werift 无法满足要求，应先提交最小兼容适配或单独的固定版本升级，补充安全回归，再进入业务集成。不能在启动、恢复或安装重试时静默升级依赖。UDP 通过不代表 TCP/TLS 已通过；未完成的传输方式必须拒绝配置或明确标记不支持。

### 4.3 临时凭据和授权

采用 coturn 的共享密钥临时凭据机制。共享密钥仅保存在本地面板和 coturn 的私密文件，浏览器与 Go 助手只获得短期 username/credential，保存在连接内存，不写入 URL、浏览器存储或日志。用户名包含过期时间和不含真实账号的作用域标识，按所选 coturn 版本支持的 REST 机制生成 HMAC；双方时钟必须同步。

建议新增 `POST /api/rtc/config`，复用现有登录、Host、Origin、CSRF、屏幕权限及当前 viewer 检查。终端请求还绑定终端槽及 pane token。返回有界的 `iceServers`、`policy`、`expiresAt`、一次协商标识和能力版本；响应使用 `Cache-Control: no-store`，不向无观看权限的账号签发桌面或终端凭据。

配置申请与后续 offer 绑定同一个会话、控制权代次、业务目标和协商标识；接管、退出、授权变化或超时后拒绝使用。标识不能复用来建立额外 peer。服务端为自身的 peer 生成独立凭据，避免两端共用同一个 allocation 身份。

端口映射按既有映射授权签发，不依赖桌面控制权。通过已认证 WSS 的版本化 `rtc_config` 扩展下发短期 ICE 配置，增加受限的配置刷新消息；更新 Go 当前“只接收一次配置”的逻辑。保留旧 STUN 字段，旧助手继续使用原直连/WSS，不默认获得 TURN 能力。

初始凭据有效期建议 10 分钟，协商标识有效期 30 秒。提前两分钟刷新凭据；在确需替换 allocation 时，通过已有单候选机制预建新 peer。映射有活动 TCP 流时不得迁移或重放字节，应在到期前停止向旧 peer 分配新流，由 WSS 或新 peer 承接新连接；旧连接尽量排空，若 allocation 到期失效则明确断开。长期连接必须覆盖跨过期时间测试，不能假设过期凭据可无限 Refresh。

Go 映射的续期仍受全局 peer 上限约束：没有空余名额时由现有 WSS 承接新流，旧 peer 排空后再替换，不为续期开设额外的无界候选。凭据轮换后已有 allocation 能继续多久，以固定 coturn 的真实验证结果为准。

撤权立即关闭应用 peer、控制通道和业务访问。已泄露的临时 TURN 凭据可能在有效期内继续消耗 coturn 资源；通过短有效期、签发限额与全局 allocation 配额约束，不能把应用退出描述为即时吊销 coturn 凭据。

### 4.4 候选、接收保护和防滥用

保留现有直连地址规则，不顺带开放任意公网 IPv4 host/srflx。新增的公网 IPv4/IPv6 relay 候选仅允许配置中的 relay IP 和端口范围；TURN 未启用时继续拒绝 relay。

生产 relay 地址需为明确允许的普通公网地址；排除回环、链路本地、组播、映射地址及其他特殊范围。允许集合来自管理员配置和受控解析，绑定到当次协商，不能因为远端声称 `typ relay` 就信任任意地址。TURN 控制域名与 relay 地址可能不同，需要分别配置。测试可显式注入隔离地址，生产不自动放宽。

SDP、实际 candidate pair、peer-reflexive 学习和收包路径必须使用一致策略。仍要求单 data m-section、SHA-256 DTLS 指纹、合法端口及协议；不能只修改 SDP 过滤而保留运行时丢包，也不能简单把 `peerAddress()` 改为允许全部地址。

ICE guard 分为两层：

- 外层只接受配置的 TURN 服务端连接及对应事务，验证 TURN 认证、事务匹配和连接状态；STUN 地址发现也只接受配置端点的有效响应。
- 解封装后继续验证 ICE 原始 HMAC、双方 ufrag、会话权限和已认证端点，DTLS 校验协商指纹。保留报文大小、每秒检查数、early checks 与端点数限制。

TURN Allocate/Refresh 响应和 ChannelData 不能被当成普通 ICE Binding 请求，也不能绕过所有保护。现有清除隐含默认 STUN 的行为继续保留，仅对显式配置的服务启用发现。

coturn 启用认证、明确 realm 和资源配额，限制 peer 目标，禁止访问回环、私网、链路本地、元数据地址及组播等目标；规则同时覆盖 IPv4/IPv6。保留本实例 relay 公网地址之间的必要通信，并验证同机 relay-to-relay 可用。管理、指标与调试接口不公开。

### 4.5 连接调度和诊断

WSS 保持可快速恢复，不能因 TURN 申请或超时延迟首次可用连接。直连和 TURN 属于同一 WebRTC 候选机制，不创建三组长期竞争的连接：观看仍最多一个活动 peer 和一个候选 peer，沿用输入空闲检查、两次 ping、授权重检和显式 activate。

未启用 TURN 时保留现有 1.5 秒收集、12 秒总协商期限。启用 TURN 后建议候选收集最多 4 秒，总期限最多 20 秒，覆盖凭据请求、双方收集、信令和 DataChannel；所有客户端及服务端待激活定时器同步调整。候选失败继续现有 WSS，不延长为无限等待。

实际直连失败时先恢复 WSS，再后台尝试包含 TURN 的候选。TURN 活动期间仅为更优的直连路径或必要的凭据续期创建候选，禁止同质量路径循环切换。沿用当前 15/30/60 秒退避、隐藏/离线暂停和切换冷却机制。

诊断区分 `WebRTC 直连`、`WebRTC TURN 中继`、`HTTPS/WSS 中转`。任一选中候选为 relay 即归类 TURN；不得根据“配置了 TURN”推断实际使用。记录候选类型、地址族、RTT，并在浏览器提供时显示 `relayProtocol`；ICE candidate 的 UDP 类型不能冒充客户端到 TURN 的 TCP/TLS 传输类型。未知字段显示未知。

服务器就绪、TURN 认证/分配失败、ICE 超时、DTLS 失败及信令超时分别报告。只保留当前状态和有界错误码，不持久化 SDP、凭据、候选历史或终端内容。

## 5. 第二阶段：自有 Linux VPS 入口

### 5.1 服务与网络

推荐 Caddy + frp。Caddy 处理浏览器可信 HTTPS 和 WebSocket；frps 接收本地反向隧道，frpc 固定转发面板回环端口；coturn 复用第一阶段能力。

| 位置/服务 | 初始端口 | 边界 |
| --- | --- | --- |
| VPS Caddy | TCP 443；通常 TCP 80 | 公网入口，ACME 证书及跳转；首版不依赖 HTTP/3 |
| VPS frps | TCP 7000 | 强制经验证的 TLS 和隧道认证 |
| VPS frps 转发监听 | `127.0.0.1:37080` | 仅供 Caddy；限制允许申请的远端端口 |
| VPS coturn | UDP/TCP 3478、TCP 5349 | 分别用于 STUN、TURN UDP/TCP、TURN TLS；按已验证能力启用 |
| VPS coturn relay | UDP 49160–49223 | 初始固定 allocation 范围；同步配置防火墙、云安全组和候选策略 |
| 本地面板/helper | 现有回环地址 | 不改为公网监听；VNC 继续使用私有 Unix socket |
| 本地 WebRTC | 现有 UDP 范围 | 直连按原规则；额外允许出站访问配置的 TURN 服务 |

STUN/TURN 直接访问公网 socket，不经过 Caddy HTTP 反代。TURN 客户端经 TCP/TLS 接入时，VPS 仍需允许 UDP relay 端口间通信。首版使用独立的 443、7000、5349；仅允许出站 443 的企业网络不保证可用。如需 TURN TLS 也使用 443，后续采用独立公网 IP 等明确方案，不能让 Caddy HTTPS 与 coturn 在同一 IP:443 直接争用监听。

面板域名与 TURN 域名可解析到同一 VPS。A/AAAA 只发布真实可达的地址；NAT VPS 需要正确设置 relay 外部地址。浏览器 HTTPS 和 TURN TLS 都必须验证证书；规划证书续期后安全 reload，并验证不结束现有任务。VPS 需要时间同步、systemd、开放所需端口和足够带宽；首版自动安装限定 Ubuntu/Debian，其他发行版提供手工配置。

### 5.2 公网入口选择与迁移

新增 `INGRESS_PROVIDER=local|cloudflare|selfhost`，与 `DEPLOY_MODE=desktop|terminal` 独立。TURN 设置同样独立，可组合 Cloudflare + 自建 TURN、自建入口 + TURN、自建入口 + WSS 等部署。

显式选择优先于旧 token 探测：`selfhost/local` 下即使存在 `secrets/tunnel_token`，也不能安装或启动 cloudflared。没有新字段的旧部署按现有配置兼容推断，首次迁移明确写入选择；重复执行保持已选提供方，参数冲突直接报错。

尽量沿用 `codex-cloud-tunnel.service` 名称，runner 按提供方启动固定程序和参数；停止旧 connector 后再启动新 connector。服务重启只影响公网连接，不与 desktop/terminal host 建立重启联动。

入口变更采用校验、写入临时配置、原子替换、启动检查和失败恢复。保留至多一份私密旧配置用于回滚；DNS 变更的生效和回滚单独验证，不能承诺本地文件回滚即可恢复公网。

修改 `PUBLIC_ORIGIN` 或新增后端配置需要重启 panel 时，应明确提示观看中断、现有端口映射需重新配对；tmux/Codex 继续运行。域名改变可能需要重新登录。仅 connector 重连不能触发 panel 或宿主重启。

### 5.3 两端安装流程

1. VPS 安装入口检查 OS、架构、端口占用、域名、证书及防火墙条件，安装固定版本 Caddy/frps/coturn、专用低权限账户和 systemd 服务。
2. frps 固定 `proxyBindAddr` 为 loopback，限制 `allowPorts`，关闭公网管理面。隧道强制 TLS，使用私有 CA 验证及优先采用双向 TLS，另配置文件型 token 认证。
3. 导出非敏感连接说明；CA、客户端证书/私钥、隧道 token、TURN 共享密钥通过管理员安全传递。软件不自动 SSH 到其他主机，也不把私密配置发布到下载接口。
4. 本地安装入口读取有界配置文件，安装固定版本 frpc，验证服务端证书及名称，启动固定面板目标的反向隧道，再验证 HTTPS、登录和 WSS。
5. 配置并验证自建 STUN/TURN。完全自建时显式替换或清空原 Cloudflare STUN，不因旧默认值继续访问它。

frp 默认启用 TLS 加密不代表默认验证 frps 证书；生成配置必须显式指定可信 CA 和名称校验，不能使用跳过验证选项。隧道 token 不放入命令行或日志。

现有本地应用依赖继续按锁文件安装，Node.js 要求仍为 22+，纯终端仍需要 tmux/Python。VPS 的网关安装不要求 Node、Go、Codex 或桌面环境。新增外部软件在安装器交付前选定精确版本与各架构 SHA-256，写入版本清单；拒绝 `latest` 和不受控升级。

### 5.4 反代和信任边界

代理整站，包括 `/session/connect`、`/terminal/connect`、`/desktop/websockify`、`/forward/*`、API、静态资源、文件上传及助手下载。保留公网 Host、Origin、Cookie、Authorization、CSRF 头和 WebSocket 子协议，继续由本地面板执行权限检查。

上游 HTTP 使用回环地址，公网 `PUBLIC_ORIGIN=https://…` 继续决定 Secure Cookie。支持长连接、流式传输及背压，保持应用现有 50 MiB 上传限制和各路径资源界限。代理不自动重试变更请求，不缓存认证响应、协商结果或终端数据。

当前登录限速使用 socket 对端地址，自建反代后可能合并为一个限速键；首版保持保守行为，不直接信任公网传入的 `X-Forwarded-For`。若需要区分来源，另行实现显式可信代理列表、头覆盖及有界解析，并独立测试。

Caddy 是可信 TLS 终止点，可以接触 HTTPS/WSS 业务内容；TURN 只转发 WebRTC DTLS 密文，但页面和指纹信令仍依赖公网入口可信。基础方案不承诺抵御被攻陷的页面服务器；若需要不可信中转，另行设计端到端身份认证或 TLS 透传。

### 5.5 诊断

分别显示本地宿主、panel、connector、公网 HTTPS、TURN 服务和实际业务路径。frpc 在线不等于域名/证书正常；coturn 在线不等于已成功完成 allocation；VPS 故障不等于本地任务停止。

Cloudflare 诊断保留原有适配，自建 connector 使用固定的本地状态来源。管理和指标接口只监听 loopback，通过已认证面板返回白名单汇总；浏览器不能提交任意诊断 URL。

## 6. 资源与生命周期约束

以下为实施初始上限，真实压测后可显式调整；新增组件不能以默认无限制配置交付。

| 资源 | 初始界限 |
| --- | --- |
| ICE 配置 | 最多 4 个 URL、单 URL 256 字符，配置文件 16 KiB、返回体 8 KiB |
| 凭据文件 | 共享密钥/token 单文件最多 4 KiB；证书材料单文件最多 32 KiB；目录 0700、私钥/密钥 0600 |
| SDP/候选 | 保持 SDP 32 KiB、协商正文 48 KiB；TURN 启用时最多 12 个候选，其中直连最多 8、relay 最多 4，按类型和地址族预留名额 |
| 签发与协商记录 | 最多 16 条待协商记录，30 秒过期；每授权作用域每分钟 6 次、突发 2 次，全局每分钟 32 次、突发 8 次；沿用更严格的现有 peer 限额 |
| 活动 peer | 观看一个活动加一个候选；端口映射沿用当前最多 4 个 peer，不增加无界重试队列 |
| coturn | 初始总 allocation 上限 32、每临时用户名上限 4；配合签发限额防止通过不断换用户名绕过全局配额 |
| 中继流量 | 初始单 allocation 8 MiB/s、实例合计 20 MiB/s 上限；按固定 coturn 版本验证单位、方向及限速生效，实际需求变化时显式调整 |
| 新增进程和缓冲 | 各网关服务配置 512 MiB 内存上限和有限连接数；frp 首版最多一个 connector、一个代理、64 条业务连接，具体缓冲限制经版本验证固定 |
| 状态和日志 | 不落盘业务正文、SDP 或凭据；配置只保留当前加一份回滚；新增服务日志各最多 30 MiB，按 10 MiB × 3 轮转，不修改系统全局日志策略 |

这些是产品约束，不代表外部组件已有同名参数。安装器必须把约束映射为经验证的原生配置、systemd 限制或专用限额机制；无法落实的项须先调整方案，不能生成看似有限、实际无效的配置。

保留现有 PTY、SCTP、WebSocket、上传及映射背压。TURN allocation、TLS socket、计时器和候选记录随 peer 释放；断网退避不积累请求。浏览器关闭、切网、TURN/隧道重连、无人观看及入口切换都不结束本地任务。

不自动重放提示、审批、粘贴、Enter 或已发送的业务输入；保留现有显式流恢复协议的去重边界，不新增代理层输入重试。端口映射既有 TCP 流不跨传输迁移；断线不重放任何字节。终端粘贴与 Enter 继续分开，桌面终端粘贴继续使用 Ctrl+Shift+V。

## 7. 实施里程碑与交付顺序

| 里程碑 | 交付内容 | 进入下一步的条件 |
| --- | --- | --- |
| M0：TURN 可行性验证 | 固定版本能力矩阵、隔离 coturn 测试环境、接收保护调用链、证书和配额实验 | 浏览器↔werift、Pion↔werift 的真实 relay-to-relay 成功；明确 UDP/TCP/TLS 支持范围和必要适配 |
| M1：配置与安全基础 | 严格配置、临时凭据、授权和限额、候选策略、ICE guard 适配 | 不放宽旧直连规则；伪造候选、错误 HMAC、撤权及超限测试通过 |
| M2：浏览器 TURN | 桌面/终端接入、续期、三种路径诊断、WSS 回退和直连恢复 | 真实 coturn + 浏览器验证，路径切换及跨凭据过期不重发输入 |
| M3：Go 助手 TURN | 协议能力协商、配置刷新、Pion relay、映射排空及旧客户端兼容 | 双向 TCP/串口映射不重放字节；旧助手仍可使用原路径；第一阶段完成 |
| M4：公网入口抽象 | 提供方选择、runner/systemd/诊断解耦、旧配置与迁移回滚 | Cloudflare 原路径回归通过，selfhost/local 不受旧 CF token 影响 |
| M5：VPS 安装与连接 | Caddy/frps/coturn 固定版本安装、本地 frpc、TLS/证书及完整端口说明 | 真实 VPS 的 HTTPS/WSS/STUN/TURN 联调通过；第二阶段核心完成 |
| M6：部署验收与发布 | 两种运行模式、升级/回滚手册、跨网络及故障矩阵、验证记录 | 下列真实部署验收完成，明确剩余平台限制后再发布 |

建议按里程碑拆分可审查的变更，第一阶段验收通过后再推进 M4–M6。诊断和配额随相应能力一同交付，不留到最后补做。

## 8. 验证矩阵

实现阶段对相关后端变更运行 `npm run check`、`npm test`、`npm run test:desktop`，浏览器行为变更运行 `npm run test:browser` 并覆盖兼容性矩阵。Go 变更运行现有 Go 单测、race、vet、依赖校验和助手构建；桌面、纯终端、端口映射及串口按改动范围运行原生测试。

计划新增隔离 TURN 与自建入口集成测试，测试入口名称在实现时确定。使用专用临时目录、测试密钥、端口和服务，测试网络封锁限定在独立网络命名空间或专用主机；不修改生产防火墙、不占用真实工作区或重启生产宿主。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 未配置 TURN 的旧实例 | 原有 LAN IPv4/公网 IPv6、Cloudflare/WSS 行为保持，未偷偷使用依赖默认 STUN |
| 纯 IPv4、无公网 IPv6、禁用直连 | 两端选中 relay，终端和桌面正常；排除同机 host 路径假阳性 |
| 客户端出站 UDP 被阻断 | 已支持的 TURN TCP/TLS 路径实际可用；失败时 WSS 可用，不冒充 UDP 直连成功 |
| TURN UDP/TCP/TLS、错误证书 | 分别验证成功与拒绝错误证书；独立记录依赖/浏览器结果 |
| 签发权限、伪造 relay、数据洪泛 | 无权限不能获凭据，任意目标不能获探测/转发，超限释放资源 |
| 凭据过期、轮换、撤权 | 长连接经过过期边界；应用撤权即时关闭业务；allocation 数量有界 |
| TURN 故障和 Wi-Fi/蜂窝切换 | 回退 WSS，恢复后可选更优路径，草稿和原任务保留，输入零重放 |
| 双向映射、活动 TCP 和串口 | 新连接按可用路径选择，既有流不迁移，故障不补发字节 |
| 真实 Caddy/frps/frpc | 登录、Host/Origin/CSRF、WSS 子协议、终端、桌面、文件、助手配对全链路通过 |
| frpc/frps/Caddy/coturn 独立重启 | 本地 shell/Codex 进程身份不变；仅受影响连接重建 |
| 提供方切换、旧 CF token、DNS 回滚 | 显式选择生效，配置有界回滚；panel 重启与重新配对影响准确告知 |
| VPS 证书续期、长连接和资源压力 | 续期后新连接正常，现有连接影响明确；限额实际生效，无无界缓冲/日志增长 |

模拟 TURN/管理上游的测试、真实浏览器协议测试、真实 coturn、真实 systemd、真实 Xvfb/x11vnc/noVNC、真实 Codex 任务、Cloudflare 部署和跨网 VPS 部署分别记录。浏览器候选带 `relay`、进程存活、端口连通或 mock 通过，都不能代替真实中继验收。

## 9. 完成标准和文档回写

第一阶段完成：在现有入口下，桌面、纯终端及 Go 助手能够按权限使用真实 TURN，覆盖凭据过期、撤权、受限网络和 WSS 回退，未改变任务生命周期及输入语义。

第二阶段完成：用户可在自己的 Linux VPS 安装完整入口，本地通过出站连接提供网页和业务；可选择 Cloudflare 或 selfhost，完全自建配置不访问默认 Cloudflare STUN，具备可验证的安装、诊断、续期、升级和回滚流程。

实施时同步更新 `README.md`、`.env.example`、`docs/lan.md`、`docs/architecture.md`、`docs/terminal-only.md`、`docs/forward.md`、`docs/cloudflare.md`、`docs/reliability.md` 及独立的 selfhost 操作手册。真实验证结果写入 `docs/verification.md`，通过的能力再从“规划”转入正式使用文档。

参考：[coturn](https://github.com/coturn/coturn)、[TURN RFC 8656](https://www.rfc-editor.org/rfc/rfc8656)、[TURN URI RFC 7065](https://www.rfc-editor.org/rfc/rfc7065)、[frp TLS](https://gofrp.org/en/docs/features/common/network/network-tls/)、[frp 认证](https://gofrp.org/en/docs/features/common/authentication/)、[frps 配置](https://gofrp.org/en/docs/reference/server-configures/)、[Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。
