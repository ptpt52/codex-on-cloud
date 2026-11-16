#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  case "${1:-status}" in
    install) printf '%s\n' '中心安装需要 root 权限，请使用 sudo ./scripts/selfhost-server.sh install。' >&2 ;;
    status) printf '%s\n' '中心状态查询需要 root 权限，请使用 sudo ./scripts/selfhost-server.sh status。' >&2 ;;
    rollback) printf '%s\n' '中心应用回滚需要 root 权限，请使用 sudo ./scripts/selfhost-server.sh rollback。' >&2 ;;
    recover) printf '%s\n' '中心更新恢复需要 root 权限，请使用 sudo ./scripts/selfhost-server.sh recover。' >&2 ;;
    *) printf '%s\n' '中心服务器管理需要 root 权限，请使用 sudo 运行。' >&2 ;;
  esac
  exit 1
fi

NODE_VERSION=24.22.2
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; NODE_SHA256=361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9 ;;
  aarch64|arm64) NODE_ARCH=arm64; NODE_SHA256=95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2 ;;
  *) printf '%s\n' '中心安装仅支持 x86_64 或 arm64。' >&2; exit 1 ;;
esac
ROOT='/opt/codex-selfhost/bootstrap'
NODE=$ROOT/node/bin/node
INSTALLED='/opt/codex-selfhost/bin/node'
SCRIPT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/selfhost-server.mjs

umask 077
mkdir -p "$ROOT"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || { printf '%s\n' '引导目录无效。' >&2; exit 1; }
[ ! -L "$ROOT/bootstrap.lock" ] && { [ ! -e "$ROOT/bootstrap.lock" ] || [ -f "$ROOT/bootstrap.lock" ]; } || exit 1
exec 9>"$ROOT/bootstrap.lock"
flock -n 9 || { printf '%s\n' '另一个中心运行时引导正在执行，请稍后重试。' >&2; exit 1; }

if [ ! -x "$NODE" ]; then
  if [ -x "$INSTALLED" ] && [ "$(timeout 10 "$INSTALLED" --version 2>/dev/null)" = "v$NODE_VERSION" ]; then
    NODE=$INSTALLED
  elif [ "${1:-status}" != install ]; then
    printf '%s\n' '固定版本运行时尚未就绪；status、rollback 和 recover 不会下载依赖，请先运行 install 准备运行时。' >&2
    exit 1
  else
    STAGE=$ROOT/node.prepare
    [ ! -L "$STAGE" ] && [ ! -L "$ROOT/node" ] || { printf '%s\n' '运行时暂存路径无效。' >&2; exit 1; }
    rm -rf -- "$STAGE"
    mkdir -m 700 "$STAGE"
    trap 'rm -rf -- "$STAGE"' 0
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    archive=$STAGE/node.tar.gz
    # util-linux prlimit uses bytes across shells. The kernel cap also bounds
    # chunked responses on curl releases that only inspect Content-Length.
    prlimit --fsize=134217728:134217728 -- curl -fsSL --connect-timeout 15 --max-time 300 --max-filesize 134217728 --retry 2 --retry-delay 1 \
      "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.gz" -o "$archive"
    printf '%s  %s\n' "$NODE_SHA256" "$archive" | sha256sum -c -
    # Extract just the pinned executable; one staging directory contains at
    # most a 128 MiB archive and a 256 MiB binary, never an entire SDK tree.
    prlimit --fsize=268435456:268435456 -- tar -xzf "$archive" -C "$STAGE" --strip-components=1 --no-same-owner --no-same-permissions "node-v$NODE_VERSION-linux-$NODE_ARCH/bin/node"
    [ "$(wc -c < "$STAGE/bin/node")" -le 268435456 ] && [ "$(timeout 10 "$STAGE/bin/node" --version)" = "v$NODE_VERSION" ] || { printf '%s\n' '暂存运行时校验失败，未发布。' >&2; exit 1; }
    rm -f -- "$archive"
    rm -rf -- "$ROOT/node"
    mv -T -- "$STAGE" "$ROOT/node"
    trap - 0 HUP INT TERM
  fi
fi

[ "$(timeout 10 "$NODE" --version 2>/dev/null)" = "v$NODE_VERSION" ] || { printf '%s\n' '已有运行时与固定版本不符或不完整，未自动替换。' >&2; exit 1; }
flock -u 9
exec 9>&-
exec "$NODE" "$SCRIPT" "$@"
