# Windows TCP 端口映射助手

首版提供通用 TCP 字节转发，适用于 SSH、数据库和其他 TCP 客户端。网页负责发放一次性授权，免安装助手自行通过现有网站的 WSS 入口连接服务器。关闭网页或切换桌面/终端模式可以继续使用映射；当前版本仅使用中转，不尝试 WebRTC 直连或跨通道续传。

## 使用

1. 登录工作台，在标题栏打开“端口映射”，下载适合 Windows 电脑架构的助手。大多数电脑选择 x64；Windows ARM64 设备可选择 ARM64。
2. 填写 Windows 本机端口，例如 2222；从列表选择服务器目标端口，例如 22，点击“生成一次性配对码”。
3. 双击运行下载的 exe，将配对码粘贴到助手窗口，回车确认。配对码有效期两分钟，只能使用一次。
4. 显示“映射已开启”后，将原有软件连接到 Windows 的 127.0.0.1 和本机端口。例如 SSH：

       ssh -p 2222 用户名@127.0.0.1

两个回环地址分别指 Windows 和 Linux 服务器。服务器目标固定为服务器自身的 127.0.0.1；不接受网页指定任意主机。服务仍需在目标端口监听，SSH 或数据库登录由原客户端和目标服务处理。

保持助手进程运行。Ctrl+C、关闭助手窗口或网页中“确认停止”可结束映射。退出工作台登录、另一个页面接管、登录授权到期、网关更新或连接断开也会结束映射；不会重新配对、重新连接目标或重放 TCP 数据。新连接可以在同一活动映射下正常建立。

本机端口只绑定 127.0.0.1，不能通过局域网地址使用。助手不安装服务、不设置自启动、不保存密码或配对信息，不写配置、数据或流量日志。程序当前未进行 Authenticode 签名，下载界面提供 SHA256，Windows 来源提示及兼容性需要在实际 Windows 设备上验证。

## 服务器允许的目标端口

默认允许 22。在 .env 中显式设置最多 16 个端口：

    TCP_FORWARD_PORTS=22,5432,8080

留空可禁用新映射：

    TCP_FORWARD_PORTS=

面板、内部 helper 和 Tunnel 诊断端口始终排除。修改后只需重启网页面板，桌面和 tmux 任务继续运行。管理员启用的端口代表工作台用户可向这些本机服务发起连接，应根据实际需求选择。

## 构建

构建使用 Go 1.26.4 和锁定的 Gorilla WebSocket 1.5.3；Go 工具链不是运行依赖。Windows 用户只运行 exe，无需 Go、Node.js 或 Python。构建不自动安装或升级工具链。

    npm run build:forward

默认服务器地址读取 PUBLIC_ORIGIN 并嵌入程序，之后双击仅需输入配对码。也可显式指定构建地址：

    npm run build:forward -- https://example.com

或在运行时覆盖默认地址：

    codex-cloud-forward-windows-amd64.exe --server https://example.com

公网地址必须是 HTTPS 根地址，无跳过证书校验选项；仅回环测试允许 HTTP。配对码从标准输入读取，不通过 URL 或命令行参数传递。--version 显示版本，--licenses 显示随程序内嵌的依赖许可证。

产物只保存在被 Git 忽略的 data/forward-client：两个固定文件名的 Windows exe（每个最多 32 MiB）、一个最多 4 KiB 的 manifest.json。构建期间至多一个 helper.tmp（最多 32 MiB）、一个 manifest.tmp（最多 4 KiB）及一个空 .build.lock；单一构建互斥，正常退出清除临时文件。下载要求登录，每次只读取固定文件名的普通文件，拒绝符号链接，最多同时两项下载。产物和清单不提交 Git。

如果启用了额外的 Cloudflare Access 网页登录，助手还需要能通过该外层认证；首版不读取浏览器 Cookie、不自动代办 Access 登录。工作台自身账号密码登录与一次性授权不受影响。

## 协议与资源上限

- 网页创建、停止映射校验 Host、Origin、登录、CSRF 和当前页面控制权；延迟请求不能跨接管执行。
- 最多四个待配对或活动映射。配对码和运行凭据都是 256 位随机值，只保存摘要和少量元数据于内存；每个授权仅允许一个明确目标端口和一个本机端口。
- 助手用一次性配对码认证 /forward/helper，获得仅用于该映射的流凭据；每条本机 TCP 连接独立认证 /forward/data。使用 codex-forward-v1 子协议，凭据放在 Authorization 请求头，保持 Host 和 Origin 校验；不会把工作台登录 Cookie 交给助手或目标服务。
- 服务端确认助手已绑定本机端口后才允许连接目标。配对后启用期限五秒，目标连接期限五秒。
- 每个映射最多八条并发 TCP 连接，每十秒最多 32 次连接尝试。二进制消息最多 16 KiB，服务端应用发送缓冲和目标写缓冲分别最多 256 KiB；慢接收方施加背压，超限关闭对应连接。
- TCP EOF 使用独立 FIN 记录，保留半关闭后的响应。原始字节不进入 PTY、输入助手或 shell，不解析 SSH/数据库协议，不执行任意命令。
- WebSocket 每十五秒心跳，未响应则关闭；助手读期限四十五秒、写期限十五秒。授权到期或失效最多五秒内清理，显式停止、退出和接管立即撤销。
- 状态只有固定四项映射及字节计数，不保存原始内容、连接历史或日志。网页仅在对话框打开且前台时每三秒查询，最多一项在途请求；配对码仅当前窗口暂存，关闭窗口、隐藏页面或失去控制权会清空，复制只在点击时发生。

## 验证

    npm run check
    npm test
    npm run test:desktop
    npm run test:forward
    CHROME_PATH=/usr/bin/google-chrome npm run test:browser -- test/browser/forward.spec.mjs test/browser/web-terminal.spec.mjs

Node 单元测试使用真实 WebSocket 和隔离 TCP 服务；桌面与管理执行器为 fixture。浏览器测试使用真实 Chrome 和模拟 RFB。test:forward 使用 Linux 版同源助手、临时证书、真实 TLS/WSS 代理和 TCP 服务，验证二进制传输、半关闭、心跳与撤销；不会连接工作中的 Codex 或真实 SSH 服务。Windows exe 的交叉构建与 PE 检查不替代 Windows 真机运行验收。
