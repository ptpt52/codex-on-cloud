#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' '请使用 sudo 运行中心安装命令。' >&2
  exit 1
fi

NODE_VERSION=24.22.2
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; NODE_SHA256=361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9 ;;
  aarch64|arm64) NODE_ARCH=arm64; NODE_SHA256=95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2 ;;
  *) printf '%s\n' '中心安装仅支持 x86_64 或 arm64。' >&2; exit 1 ;;
esac
ROOT=/opt/codex-selfhost/bootstrap
NODE=$ROOT/node/bin/node
SCRIPT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/selfhost-server.mjs

if [ ! -x "$NODE" ]; then
  mkdir -p "$ROOT/node"
  archive=$ROOT/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.gz
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.gz" -o "$archive"
  printf '%s  %s\n' "$NODE_SHA256" "$archive" | sha256sum -c -
  tar -xzf "$archive" -C "$ROOT/node" --strip-components=1
  rm -f "$archive"
fi

exec "$NODE" "$SCRIPT" "$@"
