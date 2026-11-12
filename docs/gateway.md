# 固定域名网页切换节点

固定入口由自己的 Cloudflare Worker 提供，每台机器保留独立 Tunnel 和后端域名。浏览器在 `/__nodes/` 查看并选择节点；网关检查就绪后更新默认路由，原任务留在原机器。

桌面与纯终端节点可混合接入。登记和日常切换不读取 `cf_token`，不修改 DNS；首次创建 Worker、Tunnel 和域名仍需要账户权限。

## 规划自己的地址

| 用途 | 示例 |
| --- | --- |
| 浏览器固定入口 | `https://desk.example.com` |
| 节点选择页 | `https://desk.example.com/__nodes/` |
| 节点 A 后端 | `https://node-a.example.com` |
| 节点 B 后端 | `https://node-b.example.com` |

所有地址都需替换。后端必须不同于固定入口，并位于配置的 `backendZone` 中。接入后后端域名只供网关转发，浏览器使用固定入口登录。

推荐为固定入口选择尚未使用的主机名。每台机器先按[单节点接入](cloudflare.md)部署所选工作区模式和独立 Tunnel；选择固定入口不会改变机器的部署模式。已经通过独立域名运行的部署不需要重新安装，按[独立域名迁移 SOP](gateway-migration.md)接入现有网关。

## 1. 初始化网关

在一台有本仓库、Node.js 和 Python 的维护机器上执行：

```sh
npm run gateway:setup -- \
  --origin https://desk.example.com --backend-zone example.com
npm run gateway:build
```

生成私有配置 `data/gateway.json`、密码 `secrets/gateway_password` 和构建目录 `data/gateway-build/`。重复初始化保留密码与配置，拒绝隐式改绑。不要复制他人的 `data/`、`secrets/` 或生成配置作为自己的部署。

## 2. 发布到自己的 CF 账户

通过 Wrangler 登录自己的账户；多账户时明确指定自己的账户 ID：

```sh
npx --yes wrangler@4.158.0 login
export CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID
npx --yes wrangler@4.158.0 deploy --config data/gateway-build/wrangler.json \
  --durable-objects-code-update-mode immediate
npx --yes wrangler@4.158.0 secret bulk data/gateway-build/worker-secrets.json \
  --config data/gateway-build/wrangler.json
```

无浏览器环境可使用 Wrangler 的 API Token 认证，通过受保护的环境注入 `CLOUDFLARE_API_TOKEN`；Wrangler 不会自动读取项目的 `secrets/cf_token`。权限要求见[CF 接入](cloudflare.md#凭据与权限)。首次使用 Workers 的账户需先完成控制台初始化。

部署使用固定版本 Wrangler、SQLite Durable Object 和固定域名 Custom Domain，关闭 `workers.dev` 与预览入口。默认 Worker 名为 `codex-cloud-gateway`；确认自己账户中没有其他部署占用它。

同账户多套网关须使用独立 Worker 名。目前每次 `gateway:build` 都会重新生成默认名称，因此要在每次构建后、发布前，手动修改各自私有 `data/gateway-build/wrangler.json` 的 `name`；deploy 与 secret 命令均使用这份配置。已有网关更新保持原 Worker 名、DO 类名及迁移身份，避免丢失目录。不同 CF 账户可以使用相同默认名称。

## 3. 登记并选择第一台机器

打开 `https://desk.example.com/__nodes/`，用维护机器的 `secrets/gateway_password` 登录，创建接入码。将完整 `cog1.` 接入码用私有编辑器保存到节点 A 的 `secrets/gateway_code`，然后在节点 A 执行：

```sh
chmod 600 secrets/gateway_code
npm run gateway:join -- \
  --gateway https://desk.example.com \
  --backend https://node-a.example.com --name node-a
```

命令保存该节点独立身份和代理凭据，调整本机入口配置，按需要重载面板，再登记到网关。不会重启桌面、任务宿主或 Tunnel。已有助手的入口 / 节点身份变化时需从对应助手页复制 key 并重新输入，保存规则保留。

在选择页点击“检查并切换”。登记本身不会改变默认节点。进入工作台后，使用该机器原来的账号密码；网关密码与节点密码分别管理。

需要 TCP / 串口助手时，在该节点完成 `gateway:join` 后执行 `npm run build:forward`，再从网关中的对应节点核对四个平台下载。不得继续使用绑定旧独立域名的下载包；完整完成标准见[共用检查清单](deployment-checklist.md#3-需要助手时完成构建与发布)。后续新节点也执行同一步骤。

## 4. 增加与切换节点

节点 B 先独立部署到 `node-b.example.com`，选择桌面或纯终端模式，保存接入码，再执行：

```sh
npm run gateway:join -- \
  --gateway https://desk.example.com \
  --backend https://node-b.example.com --name node-b
```

后续从“工具 → 切换入口节点”或直接打开 `/__nodes/` 选择。当前节点离线时，独立选择页仍可访问。节点数不设固定上限，每页 16 台；实际规模受 128 KiB 状态容量限制。接入码可复用，撤销只禁止新登记。

浏览器保存密码时，网关入口使用固定标识 `admin@gateway`；节点登录页预填 `admin@<节点名>-<节点ID前8位>`，例如 `admin@home-a1b2c3d4`，自定义管理员用户名保留自己的前缀。节点名中的空格和特殊符号格式化为连字符，未设置或格式化后为空时使用 `node`。只有登录名使用短 ID，自动填充分组、请求和会话仍绑定完整节点 ID。

节点改名后，重新部署面板可更新预填名称；原用户名、旧的 `admin@nodeid-<完整ID>` 和同一短 ID 的改名前登录名仍可使用，密码不变。浏览器已有密码条目不会自动改名，可选择旧条目登录或按新名称重新保存；浏览器仍可能列出同站点的多个账号。

切换影响后续访问的全局默认节点，不是每个浏览器各选一个默认值。已有健康 WebSocket／WebRTC 保留原节点连接；任务、文件不迁移，旧页面和旧下载链接不能误操作新节点。未确认的输入、审批与写请求不会重发。

## 更新与恢复

- **更新节点**：运行 `npm run deploy`，助手代码同时更新时增加 `--build-forward`，省略 `--domain`；网关成员拒绝旧 DNS 发布／接管以及不兼容的 `--origin`。
- **更新网关**：重新 `gateway:build`，确认发布到原账户和 Worker，再执行上面的 deploy／secret 命令。构建不自动部署。
- **常驻映射助手**：升级该功能时同步更新 Worker、节点后台和 0.9.0 助手。助手的控制、数据及恢复连接固定到签发 key 的节点；切换浏览器默认节点不改变助手归属，不需要 CF Token。旧 Worker 不支持固定路由时可能连接错误节点并被身份检查拒绝，不能只热更新网页。
- **路由协议升级**：按上面的 `immediate` 参数发布，使 DO 路由逻辑同时更新；否则 Cloudflare 默认可延迟五分钟。新网关会再次核对固定节点身份，旧 DO 不认识新参数时返回 503，不转发到默认节点。原目录仍保留。见[Cloudflare 代码更新说明](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)。
- **接入中断**：核对 `data/gateway-join.json`，修复网络后明确重跑相同接入命令；复用同一节点身份，不自动重试。人工改动会被保留。
- **撤销未完成接入**：仅在 `data/gateway-join.json` 仍存在时使用 `npm run gateway:join -- --abort`。已经向远端发送过登记时，先核对远端；仍登记的节点需先在网页切到其他节点并移除。成功接入后的独立入口恢复见[迁移维护流程](gateway-migration.md#成功接入后恢复独立入口)。
- **切换回复丢失**：页面只读核对当前路由，不再提交；核对成功后手动进入。
- **移除节点**：先切到其他节点再移除登记，不删除机器上的任务、文件或 Tunnel。

## 从独立域名迁移

如果机器已经通过 `https://old.example.com` 独立访问，现在要成为现有 `https://desk.example.com` 网关的节点，按[独立域名迁移 SOP](gateway-migration.md)执行。迁移会为原 Tunnel 增加独立后端，并可使用同一节点身份完成登记；不会迁移任务或重新部署工作台。旧入口可在验收后撤下，也可把精确主机名加入 `ALLOWED_HOSTS`，同时保留独立域名和网关访问。

如果固定网关自己的浏览器主机名目前仍直接指向某台 Tunnel，迁移还需要把该主机名从 CNAME 改成 Worker Custom Domain。Cloudflare 不允许在已有 CNAME 的主机名直接创建 Custom Domain。[官方限制与迁移](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。先保留旧记录、Tunnel ingress 和私有 socket，再按实际 API／控制台状态完成域名接管；绑定失败时可恢复保留的旧记录，不要并行运行 DNS 接管命令。

## 与 Access 组合

可将外层 Access 加在固定浏览器入口，覆盖工作台和 `/__nodes/`。网关管理登录与节点自身登录继续保留。

Worker 必须能探测各节点后端。后端不能被交互式 Access 登录页或其他 Worker 路由截住；本项目没有网关到 Access 后端的服务令牌配置。Tunnel 转发 Host 必须是后端主机名，不能覆盖为固定入口。面板只在私有 Unix 接入口接受匹配的节点与代理凭据，原 Host、Origin、CSRF 检查保持。

## 凭据与边界

节点代理凭据在私有 `data/gateway-node.json`，网关密码在初始化机器的 `secrets/gateway_password`；目录与路由保存在该账户自己的 DO。勿提交或公开这些文件。构建文件也不携带原始密码或 CF 管理 Token。

网关状态最多 128 KiB，接入码 16 个、有效会话 8 个；状态探测 4 秒，切换租约 15 秒，并发或过期结果不能覆盖新选择。控制请求最多 8 KiB；文件和 WebSocket 流不写入目录。私有节点配置最多 4 KiB，单份接入恢复记录最多 256 KiB。验证环境与生产验收分别记录，见[测试说明](verification.md)。

[文档目录](README.md) · [部署选择](deployment.md) · [维护排障](operations.md)
