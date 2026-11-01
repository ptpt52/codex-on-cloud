#!/usr/bin/env bash
set -eu
mkdir -p /workspace/transfer "$HOME/.codex"
if [ ! -e "$HOME/.inputrc" ]; then
  printf 'set enable-bracketed-paste on\n' > "$HOME/.inputrc"
fi
if [ ! -e "$HOME/.codex/config.toml" ]; then
  # The container has no desktop keyring service. Store credentials in its private home volume.
  (umask 077; printf 'cli_auth_credentials_store = "file"\n' > "$HOME/.codex/config.toml")
fi
python3 /opt/codex-cloud/agent.py &
agent_pid=$!
trap 'kill "$agent_pid" 2>/dev/null || true' EXIT TERM INT
# Do not watchdog-restart the desktop or Codex when nobody is viewing it.
# Only open the initial terminal after the display accepts input.
for ((attempt = 0; attempt < 60; attempt++)); do
  if xdotool getdisplaygeometry >/dev/null 2>&1; then
    /usr/local/bin/open-codex-terminal &
    break
  fi
  sleep 1
done
wait "$agent_pid"
