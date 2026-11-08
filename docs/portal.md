# 统一门户与独立节点

门户部署在 Cloudflare Workers，目录保存在一个 SQLite Durable Object 中。每个节点仍通过自己的域名、Cloudflare Tunnel 和本机面板独立工作；门户不转发桌面、终端、文件或端口映射流量。

当前域名规划：

| 用途 | 地址 |
| --- | --- |
| 统一门户 | `https://codex.x-wrt.dev` |
| home | `https://home-codex.x-wrt.dev` |
| 后续 work | `https://work-codex.x-wrt.dev` |
| 后续其他节点 | 使用各自独立域名，例如 `xxx-codex.x-wrt.dev` |

当前门户与 home 节点已经上线；work 尚未部署，目录入口保持停用。home 继续使用原工作台账号、密码和屏幕锁，门户使用独立的 `secrets/portal_password`，两者分别登录。原节点入口已改为 home 域名，不保留旧域名兼容。

访问节点不要求先经过门户。未接入、门户离线、授权码被删除，都不结束节点自身的任务或端口映射。各节点继续使用自己的账号、登录 Cookie 和屏幕锁；门户登录不代替节点登录。

## 初始化与发布门户

构建只需 Node.js，不安装桌面组件、不修改现有 Codex 配置，不重启节点服务。首次初始化：

```sh
npm run portal:setup -- \
  --origin https://codex.x-wrt.dev \
  --home https://home-codex.x-wrt.dev \
  --work https://work-codex.x-wrt.dev
npm run build:portal
```

`portal:setup` 创建高强度随机门户密码到 `secrets/portal_password`，权限 0600，不打印密码。再次执行保留密码和初始配置。请由服务器主机用户读取该文件以登录门户，门户只有一位管理员。

在部署主机的项目目录中查看门户密码：

```sh
cat secrets/portal_password
```

初始目录位于 `data/portal-nodes.json`：home 启用，work 尚未部署，入口停用。通用示例见 [nodes.example.json](../portal/nodes.example.json)。初始目录只在新 Durable Object 第一次成功写入时导入；已经发布的门户以动态存储为准，重新构建不会覆盖它。

`build:portal` 生成三个固定私有文件，总量有界：

- `data/portal-build/worker.mjs`：自包含 Worker 和网页资源，最多 256 KiB，不含原始密码。
- `data/portal-build/wrangler.json`：独立门户配置、SQLite Durable Object 绑定和固定兼容日期。
- `data/portal-build/worker-secrets.json`：门户密码校验值，用于上传 Workers Secret。

使用拥有目标域名的 Cloudflare 账户，通过固定版本 Wrangler 登录并发布：

```sh
npx --yes wrangler@4.158.0 login
npx --yes wrangler@4.158.0 deploy --config data/portal-build/wrangler.json
npx --yes wrangler@4.158.0 secret bulk data/portal-build/worker-secrets.json \
  --config data/portal-build/wrangler.json
```

多账户时可设置 `CLOUDFLARE_ACCOUNT_ID`。也可采用 Wrangler 支持的 API Token 认证；不把 API Token 写入源码或生成配置。部署会绑定门户的自定义域名，请先确认 `codex.x-wrt.dev` 没有其他用途。

首次使用 Workers 的账户可能在上传时返回错误 `10063`，要求先创建账户级 `workers.dev` 子域名；这与门户是否启用该访问入口是两件事。可以在 Cloudflare 控制台打开 Workers & Pages 完成初始化，也可以使用本项目的命令：

```sh
npm run portal:account -- --account-id YOUR_ACCOUNT_ID \
  --api-token-file /path/to/cf_token --subdomain your-workers-name
```

已有子域名时只查询并保留，不会改名；尚未初始化时必须显式提供 `--subdomain`，名称需在 Cloudflare 可用。命令只读取最多 512 字节、当前用户拥有且权限为 0600 的令牌文件，请求与响应均有超时和大小限制，不打印令牌、不自动重试写入。它不发布 Worker，随后仍需执行上面的发布步骤。门户配置继续保持 `workers_dev: false` 和 `preview_urls: false`。

API Token 需要覆盖目标账户的 **Workers Scripts 编辑**权限，以及目标区域的 **Workers Routes 编辑**权限。使用新的 Workers 权限界面时，应授予包含新 Worker 创建权限的相应角色；只授权已有 Worker 不能创建本门户。沿用节点发布令牌时，还需保留原来的 DNS、Tunnel 权限。参见 [Worker 上传权限](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)和 [Workers 域名权限](https://developers.cloudflare.com/workers/authorization/workers/)。

账户令牌使用 `/accounts/{account_id}/tokens/verify` 核验，用户令牌使用 `/user/tokens/verify`。令牌有效或能够列出 Workers，不代表具备上传脚本、设置 Secret 和绑定域名的权限。发布出现 HTTP 403、`No access to the specified resource` 时，先检查权限及账户/区域范围；不要切换现有节点域名或重启服务，待门户发布成功后再继续。

没有上传密码校验值时，敏感 API 拒绝访问。`workers.dev` 和预览入口默认关闭，Worker 还会核对访问域名。门户公开的只有登录页面与固定静态资源，目录、授权码和管理接口均需认证。

## 动态管理服务器

登录门户后，可以新增、编辑、停用、删除服务器以及导出目录。保存后立即写入 Durable Object，不需要重新部署 Worker；各节点打开切换列表时读取最新目录。

同一时间保存采用目录版本检查。另一页面已经更新时，本次写入会被拒绝，需要先刷新，不会自动覆盖或重复提交。

- 停用：隐藏进入链接，保留节点及其接入身份。节点本身仍可通过域名访问。
- 删除：移除目录条目及该节点的目录访问身份。服务器、任务和端口映射不停止。
- 修改已接入节点的域名：撤销旧域名对应的目录访问凭据，需要目标节点重新接入。
- “已注册”只代表已保存节点身份，不代表节点当前在线。门户不自动探测或接管远程桌面。

“导出目录”下载 JSON，只含节点元数据，不含密码、授权码、登录状态或节点凭据。该 JSON 可以作为另一份新门户的初始配置；接入授权和登录需要重新建立。不要改动现有 Worker 名称、Durable Object 类名或固定对象名 `nodes-v1` 来更新目录，否则可能创建另一份存储。

## 长期授权码与节点界面注册

在门户打开“授权码管理”，填写名称并生成授权码。授权码以 `coc1.` 开头，同时携带门户地址，因此节点无需单独填写门户地址。

- 授权码长期有效，同一个码可以在多个服务器、多个域名使用。
- 原文只在生成时展示，关闭窗口后清空；门户只保存哈希，请自行保管需要重复使用的原文。
- 删除授权码只禁止新的注册，已经注册的节点保留身份和目录访问。
- 授权码不能登录门户、编辑其他节点或操作任何桌面。

新节点先按原流程独立部署，确认 `PUBLIC_ORIGIN` 为自己的 HTTPS 域名。随后在节点的“工具 → 门户接入”中填写名称、粘贴授权码，确认显示的目标门户地址，再点“保存并注册”。

域名、模式和节点私有身份由节点后台确定。注册成功后自动启用入口；预先登记的同域名 home/work 条目会被接入，不会重复新增。门户填写的节点说明在注册和重新保存后保留；门户手动停用已接入节点后，普通重新保存不会把它自动启用。

节点获得自己的目录访问身份，共享授权码不会被存入节点配置。以后留空授权码可以保存原有接入。响应丢失时不会自动发送，手动重试使用已保存的节点身份，避免创建重复节点。门户允许同一节点凭自己的身份更新自己，不允许仅凭共享授权码覆盖另一节点已经绑定的身份。

节点的私有文件：

| 路径 | 内容与上限 |
| --- | --- |
| `data/panel/portal.json` | 当前门户地址、节点名称、节点 ID 和节点私有身份，最多 2 KiB，0600 |
| `data/panel/portal-pending.json` | 在途接入身份，最多 2 KiB，0600，用于丢失响应后的手动重试 |

注册失败时保留原有有效门户配置。门户配置不可用只影响目录功能，不阻止面板启动、登录、文件传输或桌面/终端工作。

修改节点域名后，长时间运行的桌面终端可能仍继承旧 `PUBLIC_ORIGIN`。请从新域名的网页保存接入，先确认界面显示的“当前节点”正确。宿主命令需要读取最新 `.env` 时，可先移除旧终端的同名覆盖，例如 `env -u PUBLIC_ORIGIN -u ALLOWED_HOSTS npm run native:doctor`；不要用旧环境中的地址注册节点。

本次 home 改名另存了两个固定私有备份：`data/.env.before-home-rename`（最多 64 KiB）和 `data/cloudflare-deployment.before-home-rename.json`（最多 4 KiB），权限 0600，已有备份不会被覆盖。它们只用于人工核对，不自动恢复域名或服务。

## 节点切换

接入后，顶部原 Logo 文字的位置显示当前服务器与切换按钮，不增加一行。选择目标或返回门户后，需要点击明确确认，默认 Enter 和取消都不切换。

切换保留当前节点登录和已授权映射，不调用退出登录，不提交或重发终端输入；任务由原节点继续持有。目标节点仍需按自己的规则登录和解锁。草稿使用浏览器按来源隔离的现有存储，各节点不会互相读到草稿。

输入、配置、中文组合输入或上传进行中时暂不允许切换。浏览器已经启动的下载无法可靠汇总，确认文案提示先核对下载完成情况。切换到离线节点不会自动把操作转给其他服务器。

## 数据与资源边界

门户只保存一条有界的 Durable Object 状态，总计最多 64 KiB：32 个节点、16 个长期授权码、8 个七天登录会话，以及最多 64 项十五分钟的登录失败计数。失败计数只使用来源地址的哈希，不持久化原 IP。Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下加 Secure，写操作继续核对 Origin 和 CSRF。

授权码、节点目录凭据和节点身份只保存哈希。门户管理密码的校验值放在 Workers Secret；原密码只保存在初始化主机的 `secrets/portal_password`。这些运行数据、构建结果和私有文件均在 Git 忽略范围内。

忘记门户密码时，在初始化主机读取 `secrets/portal_password`；需要更换时：

```sh
npm run portal:setup -- --rotate-password
npm run build:portal
npx --yes wrangler@4.158.0 secret bulk data/portal-build/worker-secrets.json \
  --config data/portal-build/wrangler.json
```

新密码使旧门户登录失效，目录、长期授权码、节点接入和各节点原登录均保留。

## 验证范围

```sh
npm run check
npm test
npm run test:desktop
CHROME_PATH=/usr/bin/google-chrome npm run test:browser -- \
  test/browser/portal.spec.mjs test/browser/node-portal.spec.mjs
```

Node 与浏览器用例的 Durable Object 存储由事务模拟实现提供，测试包含真实本机 HTTP、WebSocket 与 TCP 回显，验证切换后映射继续传输；桌面管理仍是隔离模拟上游。

实际 workerd 与 SQLite 检查独立运行，使用临时目录并在运行时重启后核对持久化：

```sh
npm install --prefix /tmp/codex-portal-tools --no-save --ignore-scripts \
  --no-audit --no-fund wrangler@4.158.0
PORTAL_WORKER_TOOLS=/tmp/codex-portal-tools npm run test:portal:worker
```

需要 workerd 支持的系统。CI 使用 Ubuntu 24.04；旧系统可在隔离的兼容运行环境执行。本地 workerd 验证不代表已完成 Cloudflare 账户、自定义域名、实际外网或真实手机验收。

门户配置写入每个固定目标最多使用一份256 KiB的`.portal-next-v2`暂存文件及一份256字节`.portal-lock`（PID与启动身份）。当前进程仍存活的写入锁会拒绝并发，已结束进程留下的锁可恢复；符号链接、特殊文件和过大残留均拒绝。旧`.portal-next`保持原样且不再阻塞新版写入，不自动清理其他配置。提交前复查调用方权限，原子改名后同步目录；不记录授权码或节点密钥日志。

节点注册请求与发起页面的登录和控制权绑定。接管、锁屏、退出、请求断开或面板关闭会取消尚在进行的注册；本地正式配置在提交前再次验证权限。已经发往门户的请求即使取消也可能在远端完成，此时报告结果未知、不自动重试。本地有界pending身份保留，当前控制者手动重试会复用该身份，避免重复节点。
