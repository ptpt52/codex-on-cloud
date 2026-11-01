#!/usr/bin/env bash
set -euo pipefail
export VNC_PW
VNC_PW="$(cat /run/secrets/desktop_password)"
if [ "${#VNC_PW}" -lt 16 ]; then
  echo '桌面密钥未初始化，请运行 npm run setup' >&2
  exit 1
fi
exec /dockerstartup/kasm_default_profile.sh /dockerstartup/vnc_startup.sh "$@"
