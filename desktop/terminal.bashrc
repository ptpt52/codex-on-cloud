# shellcheck shell=bash
# User development settings may change tools and locale, but must not redirect
# this shell into the physical desktop or a different private tmux/workspace.
declare -A codex_cloud_session_values=()
codex_cloud_session_keys=(HOME DISPLAY WAYLAND_DISPLAY XAUTHORITY TMUX TMUX_PANE TMUX_SOCKET WORKSPACE_DIR TRANSFER_DIR FONTCONFIG_FILE XDG_CURRENT_DESKTOP XDG_SESSION_TYPE)
for codex_cloud_key in XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS SESSION_MANAGER; do
    if [[ -v $codex_cloud_key ]]; then codex_cloud_session_keys+=("$codex_cloud_key"); fi
done
for codex_cloud_key in "${codex_cloud_session_keys[@]}"; do
    if [[ -v $codex_cloud_key ]]; then codex_cloud_session_values[$codex_cloud_key]=${!codex_cloud_key}; fi
done

# The host uses a fixed locale. Interactive shells use the user's locale from
# bashrc/shared development settings; an inherited LC_ALL would override LANG.
unset LC_ALL
# shellcheck source=/dev/null
if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
for codex_cloud_key in "${codex_cloud_session_keys[@]}"; do
    if [[ ${codex_cloud_session_values[$codex_cloud_key]+present} ]]; then
        export "$codex_cloud_key=${codex_cloud_session_values[$codex_cloud_key]}"
    else
        unset "$codex_cloud_key"
    fi
done
if [ -z "${LANG:-}" ]; then export LANG=C.UTF-8; fi

# Project helper binaries are a fallback. Never put the service's captured
# Node/Codex PATH ahead of the user's selected toolchain.
codex_cloud_tools="${BASH_SOURCE[0]%/*}/../data/host-tools/usr/bin"
if [ -d "$codex_cloud_tools" ]; then
    codex_cloud_tools=$(CDPATH='' cd -- "$codex_cloud_tools" && pwd)
    case ":${PATH:-}:" in
        *":$codex_cloud_tools:"*) ;;
        *) export PATH="${PATH:+$PATH:}$codex_cloud_tools" ;;
    esac
fi
unset codex_cloud_session_values codex_cloud_session_keys codex_cloud_key codex_cloud_tools
bind 'set enable-bracketed-paste on'
