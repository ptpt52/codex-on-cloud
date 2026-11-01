# 本机与局域网直连设计

本页为设计与部署准备，尚未安装网关、申请证书、修改 DNS 或开放端口。

## 当前情况

2026-11-01 检查本机：局域网 IPv4 为 `192.168.16.224/24`，网关为 `192.168.16.1`。地址来自当前网络配置，部署前应在路由器预留地址。端口 80 已有其他服务，443 尚未监听。

面板固定监听 `127.0.0.1:36080`。当前 `PUBLIC_ORIGIN=https://remote-codex.x-wrt.dev`，Host 白名单只有该域名，Cookie 使用 Secure；直接请求 `http://127.0.0.1:36080/` 与健康接口均因 Host 不匹配返回 400。仅增加 `ALLOWED_HOSTS` 不能同时解决 HTTPS Origin 与 Secure Cookie。

## 推荐：同一个域名，按访问位置选择路径

浏览器始终访问 `https://remote-codex.x-wrt.dev`，保持当前应用配置及登录、Host、Origin、CSRF 校验。

| 访问位置 | 域名解析 | 网页与 WebSocket 路径 |
| --- | --- | --- |
| 主机本身 | hosts 或本机 DNS 指向 `127.0.0.1` | 回环 HTTPS 网关 → `127.0.0.1:36080` |
| 同一局域网 | 路由器 DNS 覆盖为 `192.168.16.224` | 局域网 HTTPS 网关 → `127.0.0.1:36080` |
| 外网 | 保留现有公网 DNS | Cloudflare → Tunnel → `127.0.0.1:36080` |

HTTPS 网关就在本机，不需要外部中转。本机与局域网路径的网页、API 和画面流都绕过 Cloudflare；外网连接继续使用既有 Tunnel。面板及 Python helper 保持回环绑定，VNC 继续使用私有 Unix socket，不开放 VNC TCP。

内网 DNS 只覆盖这个完整域名，不覆盖整个 `x-wrt.dev`。除 A 记录外，也需处理 AAAA：配置稳定的局域网 IPv6，或在内网对该名称的 AAAA 返回无记录，避免浏览器仍通过公网 IPv6 连接 Cloudflare。浏览器的独立 DoH、安全 DNS 或手机私有 DNS 若绕过路由器，也需为该域名采用本地解析；系统代理/VPN 同样需要允许 LAN 地址直连。这不改动 Tunnel 的 IPv6 优先出站策略。

## HTTPS 和反向代理

网关需要浏览器信任、名称匹配 `remote-codex.x-wrt.dev` 的证书。可通过 ACME DNS-01 申请，网站无需开放公网 80/443；证书续期仍要验证 DNS。使用范围受限的 DNS 凭据，Tunnel 运行 token 不能代替 DNS API 凭据。[Let's Encrypt DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)

Cloudflare Origin CA 主要用于 Cloudflare 到源站的连接，不能作为浏览器局域网直连的默认可信证书。[Cloudflare Origin CA 说明](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)

网关监听回环和明确的 LAN 地址，允许网段限定为当前局域网；复用已有网关或固定版本部署，保留既有 80 端口服务。若使用 Nginx，除了域名证书，必须传递实际 Host、Origin 以及 WebSocket 升级头，网页和 `/desktop/websockify` 都走同一个入口。[Nginx WebSocket 转发](https://nginx.org/en/docs/http/websocket.html)

核心转发配置示意（不是完整部署文件）：

```nginx
location / {
    proxy_pass http://127.0.0.1:36080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
}
```

`$connection_upgrade` 需在网关 http 上下文中按 Upgrade 头是否为空映射；上传上限保持 50 MiB。实施时为网关与证书维护补齐固定路径和资源界限：仅一组活动证书/密钥与最多一组备份，每个文件最多 64 KiB；DNS 凭据最多 4 KiB、私有目录 0700、密钥 0600；日志使用宿主受限 journal 或明确轮转上限。证书、密钥、凭据和运行文件全部留在忽略目录。

普通局域网 HTTP 不具备 HTTPS 的浏览器能力；例如剪贴板与 Service Worker 涉及安全上下文。`localhost` 是浏览器的本机例外，但不会使局域网 IP HTTP 自动可信，也不会绕过本项目的 Origin 检查。[MDN 安全上下文](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)

## 验证与回退

部署网关后，先通过指定解析测试，不必立即改路由器 DNS：

```bash
curl --noproxy '*' --resolve remote-codex.x-wrt.dev:443:192.168.16.224 \
  https://remote-codex.x-wrt.dev/healthz
curl --noproxy '*' --resolve remote-codex.x-wrt.dev:443:127.0.0.1 \
  https://remote-codex.x-wrt.dev/healthz
```

不用 `-k`，以同时验证证书。浏览器 Network 的远端地址应为局域网地址或回环地址，WebSocket 应正常升级并持续显示画面。修改解析后需清理旧解析缓存并重新建立连接；已经建立的公网 WebSocket 不会仅因 DNS 改动立即切换路径。再验证登录、接管、剪贴板、文件传输及错误 Origin 拒绝；同一桌面、相同分辨率和画质下比较交互延迟，HTTPS 首次请求时间不能直接当作 VNC 帧延迟。

然后从另一局域网设备确认 A/AAAA 解析，再启用单域名 DNS 覆盖；使用蜂窝网络验证公网入口仍经过 Cloudflare。回退时移除 DNS/hosts 覆盖即可恢复公网路径。切换网络可能关闭画面连接，恢复只重连画面，不重放输入。

本次只完成设计。实际直连效果、LAN HTTPS 证书及另一台局域网设备的连通性，需在网关部署后验证。
