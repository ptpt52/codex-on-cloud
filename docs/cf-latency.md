# X-Wrt / OpenWrt 上的 CF IP 延迟排序

独立脚本：[scripts/cf-latency.sh](../scripts/cf-latency.sh)。只需把这一个文件复制到路由器，不需要安装本项目的面板、Node.js 或桌面。

默认抽样 256 个 Cloudflare 候选 IP，每个进行六次 TCP 443 建连探测，并发八条。最终**只按平均连接延迟升序排序**；不测速下载带宽，不自动更改 DNS、hosts、代理、防火墙或 Tunnel。探测成功次数和失败比例作为参考列，不影响排序。延迟是路由器到该入口的 TCP 建连耗时，不能直接当作浏览器到面板的应用 RTT，也不能作为 Tunnel 的 UDP 出口优选结果。

## 使用

将脚本复制到路由器 `/tmp/cf-latency.sh`，在路由器 SSH 终端运行：

```sh
# IPv4，默认参数
sh /tmp/cf-latency.sh

# IPv6
sh /tmp/cf-latency.sh 6

# 多抽样一些地址，每个测八次，最多十六条并发
sh /tmp/cf-latency.sh 4 -c 1024 -t 8 -n 16
```

首次运行自动识别 x86、ARM、AArch64、MIPS/MIPS64 的用户空间位数和字节序，从上游下载固定 **CFST v2.3.5**，校验脚本内置 SHA256 后提取工具及地址资料。MIPS / MIPSLE 发行包为 `CGO_ENABLED=0`、`GOMIPS=softfloat`。需要固件提供 BusyBox 的基本命令（包含 `awk`、`sort`、`tar`、`sha256sum`、`timeout`、`od`、`stat`），以及支持 HTTPS 的 `curl` 或 `wget`；缺少时明确报错，不自动安装软件包或修改系统。支持旧式和新式 BusyBox `timeout` 参数。

固定发行包和平台列表见 [CFST v2.3.5](https://github.com/XIU2/CloudflareSpeedTest/releases/tag/v2.3.5)，测速参数见[上游说明](https://github.com/XIU2/CloudflareSpeedTest/tree/v2.3.5)。IPv4 默认范围来自 [Cloudflare 官方列表](https://www.cloudflare.com/ips-v4)，于 2026-11-07 核对；IPv6 使用固定发行包中的候选前缀。脚本先生成有界的具体 IP 清单，再交给 CFST，不让工具展开整个 IPv6 网段。结果是本次抽样中可连接地址的排序，不是对全部 Cloudflare 地址的穷举。

若路由器上有透明代理，需让这些 TCP 探测走希望测量的实际出口；脚本不会调整代理规则。在路由器运行得到的是路由器当前出口的质量，另一台电脑、手机或其他运营商的排序可能不同。没有 IPv6 出口时，IPv6 探测可能没有成功结果。

## 结果

默认目录为 `/tmp/cf-latency-用户ID`。路由器 root 用户通常是 `/tmp/cf-latency-0`：

```sh
# IP、平均延迟及探测成功情况
cat /tmp/cf-latency-0/ipv4.csv

# 只有 IP，第一行是本次平均延迟最低的地址
cat /tmp/cf-latency-0/ipv4.txt

# 用同一组候选重新测试，便于比较不同时段
sh /tmp/cf-latency.sh 4 -f /tmp/cf-latency-0/ipv4-candidates.txt
```

CSV 列为 `rank,ip,avg_ms,success,attempts,failed_pct`，表示排名、IP、平均毫秒数、成功次数、总次数和 TCP 探测失败百分比。例如部分探测成功的低延迟 IP 仍可能排在前面，选择使用时可结合成功次数判断。全部失败的 IP 没有可计算的平均延迟，不进入结果；`failed_pct` 不是 ICMP 丢包率。

`ipv6.csv`、`ipv6.txt`、`ipv6-candidates.txt` 对应 IPv6。每次终端显示前二十项，文件包含全部成功项。使用 `-o /tmp/另一个目录` 可指定结果位置；新目录自动设为私有，已有目录须归当前用户所有、权限 700。默认 `/tmp` 中的缓存和结果在路由器重启后清除，不写入闪存。

已有具体地址也可放进文件，每行一个 IP，支持空行和 `#` 注释：

```sh
sh /tmp/cf-latency.sh 4 -f /tmp/my-ipv4.txt
sh /tmp/cf-latency.sh 6 -f /tmp/my-ipv6.txt
```

自定义文件最多 128 KiB、所选地址族最多 4096 项，不接受 CIDR；另一地址族的行会忽略。若使用固件原生编译的固定版工具，可显式指定 `CFST_BIN=/绝对路径/cfst`，同时用 `-f` 提供 IP 清单；不会自动升级已指定工具。上游固定版无自动下载包的架构也可用此方式。

## 运行边界

候选数量最多 4096、每 IP 最多二十次、并发最多 64。一次探测最多 900 秒；工具内单次 TCP 连接超时为一秒。探测阶段使用 `-dd` 禁止下载测速文件，但首次使用仍需下载约 3 MiB 的工具包。

结果目录内固定缓存一个不超过 8 MiB 的已校验发行包、每种地址族三份最新结果，以及最多一个临时工作目录。原始 CSV 最多 1 MiB，候选和排序各最多 4096 项；每文件写入另有不高于 32 MiB 的进程限制。Go 使用 32 MiB 的**软内存目标**及最多两个执行线程，实际进程内存还含运行时和二进制映射，不保证适合所有小内存机型。

同一目录使用原子锁阻止并发执行。常规完成、超时、Ctrl+C 或 TERM 会清理临时目录并释放锁；探测失败或解析失败保留原有结果并返回非零状态。断电或 SIGKILL 可能留下锁，确认没有旧任务运行后再手动清理该目录中的 `.lock` 和对应 `.run.*`；重启也会清除默认 `/tmp` 目录。

验证覆盖 POSIX `/bin/sh`、BusyBox 1.27.2 ash 与其基本 applet、旧式 timeout、数值排序、零毫秒、部分失败、IPv6 清单、资源限制及下载校验失败。真实固定版工具另用隔离回环 TCP 端口验证建连、CSV 和未发送应用数据；候选生成验证将探测器替换为固定输出，不扫描外部网络。没有在 X-Wrt 路由器硬件上执行，不将 Linux 工具包检查当作全部机型的真机验收。
