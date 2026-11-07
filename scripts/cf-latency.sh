#!/bin/sh
# X-Wrt/OpenWrt BusyBox ash. TCP connect latency only; no network configuration changes.
set -eu
umask 077
export LC_ALL=C

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'HELP'
用法：sh cf-latency.sh [4|6] [选项]
  4 / 6             IPv4 / IPv6，默认 4
  -c 数量           抽样候选数，默认 256，范围 1–4096
  -n 并发           默认 8，范围 1–64
  -t 次数           每个 IP 的探测次数，默认 6，范围 1–20
  -f 文件           测试已有 IP 清单，每行一个具体 IP，不接受 CIDR
  -o 目录           缓存和结果目录，默认 /tmp/cf-latency-当前用户ID
  -h                显示帮助
仅测 TCP 443 建连耗时，按平均延迟升序排列，不下载测速文件。
结果：ipv4.csv / ipv4.txt / ipv4-candidates.txt（IPv6 为 ipv6.*）。
目录内每种地址族仅保留最新结果。失败或取消时保留上次结果。
可用 CFST_BIN=/绝对路径/cfst 指定已有的 v2.3.5 工具。
HELP
}
family=4; samples=256; threads=8; attempts=6; input_file=''
output_dir="/tmp/cf-latency-$(id -u)"
case "${1:-}" in 4|6) family=$1; shift;; esac
while getopts 'c:n:t:f:o:h' option; do
    case "$option" in
        c) samples=$OPTARG;; n) threads=$OPTARG;; t) attempts=$OPTARG;;
        f) input_file=$OPTARG;; o) output_dir=$OPTARG;; h) usage; exit 0;;
        *) usage >&2; exit 1;;
    esac
done
shift "$((OPTIND - 1))"
[ "$#" -eq 0 ] || die '存在无法识别的参数'
number() {
    case "$1" in ''|*[!0-9]*|0*) die "$3 必须是 1–$2 的整数";; esac
    if [ "${#1}" -gt 4 ] || [ "$1" -gt "$2" ]; then die "$3 超出范围"; fi
}
number "$samples" 4096 '候选数量'; number "$threads" 64 '并发'; number "$attempts" 20 '探测次数'
for command in awk sort tar sha256sum mktemp stat timeout od uname wc mv chmod; do
    command -v "$command" >/dev/null 2>&1 || die "缺少命令：$command"
done
case "$output_dir" in /*) ;; *) output_dir="$PWD/$output_dir";; esac
[ ! -L "$output_dir" ] || die '结果目录不能是符号链接'
mkdir -p "$output_dir"
[ "$(stat -c '%u:%a' "$output_dir")" = "$(id -u):700" ] || die '结果目录须由当前用户拥有，权限为 700；请换一个新目录'
mkdir "$output_dir/.lock" 2>/dev/null || die "已有任务或遗留锁：$output_dir/.lock；确认无任务运行后才能删除此空锁目录"
work_dir=''; runner_pid=''
cleanup() {
    if [ -n "$runner_pid" ]; then kill -TERM "$runner_pid" 2>/dev/null || :; wait "$runner_pid" 2>/dev/null || :; fi
    [ -z "$work_dir" ] || rm -rf "$work_dir"
    rmdir "$output_dir/.lock" 2>/dev/null || :
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
work_dir=$(mktemp -d "$output_dir/.run.XXXXXX")
# Per-file writes are bounded, including downloads/extraction. Go's heap target
# is a soft limit; the probe count and worker count are independently bounded.
ulimit -f 32768
export GOMEMLIMIT=32MiB GOMAXPROCS=2
version=v2.3.5
bin=${CFST_BIN:-}
tool_dir=$work_dir
if [ -z "$bin" ]; then
    machine=$(uname -m)
    case "$machine" in
        x86_64|amd64) arch=amd64;; i386|i486|i586|i686) arch=386;;
        aarch64|arm64) arch=arm64;; armv7*|armv8l) arch=armv7;; armv6*) arch=armv6;; arm*) arch=armv5;;
        mips*)
            elf_file=/bin/busybox; [ -f "$elf_file" ] || elf_file=/bin/sh
            elf=$(od -An -tu1 -j4 -N2 "$elf_file")
            elf_class=$(printf '%s\n' "$elf" | awk '{print $1}')
            endian=$(printf '%s\n' "$elf" | awk '{print $2}')
            case "$elf_class" in 1) arch=mips;; 2) arch=mips64;; *) die '无法识别 MIPS ELF 类型';; esac
            case "$endian" in 1) arch="${arch}le";; 2) ;; *) die '无法识别 MIPS 字节序';; esac;;
        *) die "固定版没有 $machine 的自动下载，请通过 CFST_BIN 指定 v2.3.5 工具";;
    esac
    case "$arch" in
        386) digest=e0706d0301deed9dad8c9c8c116e1b8e21f09abc0d5ec859c3308d1880574802;;
        amd64) digest=c4c8fc76b4e1bf2bdb5ced8b765956d82dda7bc4eb59df5c04053f0f7db98d90;;
        arm64) digest=0ac992fcf24d4684caed33620deb9b83ce82f32d2418dc1f90be490ce5900300;;
        armv5) digest=ffe209c1cf654e8e08fc7135cc6135195215d55ebe6b8c34c2afa7a33c58d145;;
        armv6) digest=a176a78b7883c92fe04b29e1682af2ce76ef0ca57a5b0abfc85c423fc27ff836;;
        armv7) digest=73386234fe07a766071709859168e19b37f6878345317ccaa992efe35f4ef5f0;;
        mips) digest=fe8f21157bc5862a2cdc417253984cd97e2ed6f52d6c0314c37c0e191d72b7fd;;
        mipsle) digest=405ac8f8d0ae018163f9acf6e1b7185b20b8539adf4f9302474e3336a29785ee;;
        mips64) digest=01441efc723bd06506943384ca962ada504498cacaa17d773b04623c6ad1d09d;;
        mips64le) digest=8df76aa0639fc23f3004b9ae0fb28fc7db0f9b93b6349bda6deeab83b90af9bf;;
    esac
    archive="$output_dir/cfst-$version.tar.gz"
    valid_archive() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %s "$1")" -le 8388608 ] && [ "$(sha256sum "$1" | awk '{print $1}')" = "$digest" ]; }
    if ! valid_archive "$archive"; then
        url="https://github.com/XIU2/CloudflareSpeedTest/releases/download/$version/cfst_linux_$arch.tar.gz"
        printf '下载固定版 %s（%s）…\n' "$version" "$arch"
        if command -v curl >/dev/null 2>&1; then
            curl --fail --location --connect-timeout 10 --max-time 120 --max-filesize 8388608 --output "$work_dir/package.tar.gz" "$url"
        elif command -v wget >/dev/null 2>&1; then
            case "$(timeout --help 2>&1 || :)" in *'-t SECS'*) set -- -s KILL -t 120;; *) set -- -s KILL 120;; esac
            timeout "$@" wget -O "$work_dir/package.tar.gz" "$url"
        else die '需要 curl 或 wget，以及可用的 HTTPS 证书支持'; fi
        valid_archive "$work_dir/package.tar.gz" || die '下载文件大小或 SHA256 校验失败'
        mv -f "$work_dir/package.tar.gz" "$archive"
    fi
    tool_dir="$work_dir/cfst_linux_$arch"
    tar -xzf "$archive" -C "$work_dir" "cfst_linux_$arch/cfst" "cfst_linux_$arch/ip.txt" "cfst_linux_$arch/ipv6.txt"
    bin="$tool_dir/cfst"
    chmod 700 "$tool_dir" "$bin"
    chmod 600 "$tool_dir/ip.txt" "$tool_dir/ipv6.txt"
fi
case "$bin" in /*) ;; *) bin="$PWD/$bin";; esac
if [ ! -f "$bin" ] || [ ! -x "$bin" ]; then die 'CFST_BIN 不是可执行文件'; fi
help_text=$("$bin" -h) || die '工具无法运行；请检查 CPU、字节序及固件兼容性'
case "$help_text" in *'CloudflareSpeedTest v2.3.5'*) ;; *) die '需要固定版本 CFST v2.3.5';; esac

if [ -n "$input_file" ]; then
    if [ ! -f "$input_file" ] || [ "$(stat -c %s "$input_file")" -gt 131072 ]; then die 'IP 清单须为不超过 128 KiB 的普通文件'; fi
    awk -v family="$family" '
        { sub(/#.*/, ""); gsub(/^[ \t\r]+|[ \t\r]+$/, ""); if ($0 == "") next }
        /\// || /[^0-9a-fA-F:.]/ || length($0)>45 { exit 2 }
        { if ((family==6) != (index($0, ":")>0)) next; if (++n>4096) exit 2; print }
    ' "$input_file" > "$work_dir/candidates.txt" || die 'IP 清单格式无效或超过 4096 项；请使用具体 IP，不要填写 CIDR'
else
    if [ ! -f "$tool_dir/ip.txt" ] || [ ! -f "$tool_dir/ipv6.txt" ]; then die '使用 CFST_BIN 时需同时用 -f 提供 IP 清单'; fi
    # Cloudflare's published IPv4 prefixes, checked 2026-11-07. Keep this
    # separate from the older, wider ranges bundled with CFST v2.3.5.
    cat > "$work_dir/official-ipv4.txt" <<'IPV4'
173.245.48.0/20
103.21.244.0/22
103.22.200.0/22
103.31.4.0/22
141.101.64.0/18
108.162.192.0/18
190.93.240.0/20
188.114.96.0/20
197.234.240.0/22
198.41.128.0/17
162.158.0.0/15
104.16.0.0/13
104.24.0.0/14
172.64.0.0/13
131.0.72.0/22
IPV4
    source_file="$work_dir/official-ipv4.txt"; [ "$family" = 4 ] || source_file="$tool_dir/ipv6.txt"
    # Sample a fixed number of literal addresses BEFORE giving them to CFST.
    # In particular, never let its unbounded IPv6 CIDR expansion run on a router.
    awk -v count="$samples" -v family="$family" '
        NF { if (++n>128) exit 2; ranges[n]=$1 }
        END {
            if (!n || n>128) exit 2; srand();
            for (i=0;i<count;i++) {
                split(ranges[i%n+1], cidr, "/");
                if (family==4) {
                    span=1; for (bit=cidr[2];bit<32;bit++) span*=2;
                    split(cidr[1], d, "."); value=((d[1]*256+d[2])*256+d[3])*256+d[4]+int(rand()*span);
                    printf "%d.%d.%d.%d\n", int(value/16777216)%256,int(value/65536)%256,int(value/256)%256,value%256;
                } else {
                    if (cidr[1]!~/::$/ || (cidr[2]!=32 && cidr[2]!=48)) exit 2;
                    sub(/::$/, "", cidr[1]); printf "%s::%x:%x\n",cidr[1],int(rand()*65536),int(rand()*65536);
                }
            }
        }
    ' "$source_file" > "$work_dir/candidates.txt" || die '候选地址生成失败'
fi
sort -u "$work_dir/candidates.txt" > "$work_dir/input.txt"
total=$(wc -l < "$work_dir/input.txt" | awk '{print $1}')
[ "$total" -gt 0 ] || die '没有所选地址族的候选 IP'
printf 'IPv%s：%s 个候选，每个 %s 次，并发 %s；仅测 TCP 443，最多运行 900 秒。\n' "$family" "$total" "$attempts" "$threads"
case "$(timeout --help 2>&1 || :)" in *'-t SECS'*) set -- -s KILL -t 900;; *) set -- -s KILL 900;; esac
timeout "$@" "$bin" -f "$work_dir/input.txt" -n "$threads" -t "$attempts" -tp 443 -tlr 1 -dd -p 0 -o "$work_dir/raw.csv" &
runner_pid=$!
if wait "$runner_pid"; then runner_pid=''; else runner_pid=''; die '测速失败或超过 900 秒，旧结果未覆盖'; fi
if [ ! -s "$work_dir/raw.csv" ] || [ "$(stat -c %s "$work_dir/raw.csv")" -gt 1048576 ]; then die '没有可用结果，旧结果未覆盖'; fi
# CFST sorts by failure rate first. Explicitly re-sort on latency alone here.
awk -F, 'NR>1 {
    gsub(/\r/, ""); if (NF<5 || $1!~/^[0-9a-fA-F:.]+$/ || $2!~/^[0-9]+$/ || $3!~/^[0-9]+$/ || $2<1 || $2>20 || $3>$2 || $5!~/^[0-9]+([.][0-9]+)?$/ || ++n>4096) exit 2;
    if ($3>0) printf "%.2f\t%s\t%d\t%d\t%.2f\n",$5,$1,$3,$2,100*($2-$3)/$2;
}' "$work_dir/raw.csv" > "$work_dir/rows.txt" || die '测速结果格式无效，旧结果未覆盖'
sort -n -k1,1 "$work_dir/rows.txt" > "$work_dir/sorted.txt"
[ -s "$work_dir/sorted.txt" ] || die '没有成功的延迟样本，旧结果未覆盖'
awk 'BEGIN {print "rank,ip,avg_ms,success,attempts,failed_pct"} {printf "%d,%s,%s,%s,%s,%s\n",NR,$2,$1,$3,$4,$5}' "$work_dir/sorted.txt" > "$work_dir/result.csv"
awk '{print $2}' "$work_dir/sorted.txt" > "$work_dir/result.txt"
mv -f "$work_dir/result.csv" "$output_dir/ipv$family.csv"
mv -f "$work_dir/result.txt" "$output_dir/ipv$family.txt"
mv -f "$work_dir/input.txt" "$output_dir/ipv$family-candidates.txt"
printf '\n按平均延迟升序（前 20 项；失败率是 TCP 探测失败比例）：\n'
awk 'BEGIN {printf "%4s %-39s %10s %10s %10s\n","排名","IP","平均毫秒","成功/次数","失败%"} NR<=20 {printf "%4d %-39s %10s %5d/%-4d %9s%%\n",NR,$2,$1,$3,$4,$5}' "$work_dir/sorted.txt"
printf '\n完整排序：%s/ipv%s.csv\n纯 IP 排序：%s/ipv%s.txt\n复测清单：%s/ipv%s-candidates.txt\n' "$output_dir" "$family" "$output_dir" "$family" "$output_dir" "$family"
