#!/usr/bin/env bash
set -euo pipefail
# Invoked only inside unshare's private user/mount namespaces. The bind mount
# does not change the host's resolv.conf or the resolver used by other services.
resolver_file="${1:?missing resolver file}"
shift
if [ "$#" -eq 0 ] || [ ! -r "$resolver_file" ]; then
  printf 'Tunnel 的独立 DNS 配置不可用\n' >&2
  exit 1
fi
mount --bind -- "$resolver_file" /etc/resolv.conf
exec "$@"
