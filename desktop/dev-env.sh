# shellcheck shell=sh
# Shared development environment for this user. Maximum size: 64 KiB.
# Loaded before interactive tool managers by ~/.bashrc and the login profile.
# Keep this file compatible with /bin/sh. Repeated sourcing must be harmless.
# Move existing development exports here; keep nvm/pyenv initialization in
# ~/.bashrc. Use absolute paths, never $PWD or a repository-relative path.

# Rebuild from an explicit base so an old service PATH cannot select old tools.
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export LANG=C.UTF-8
unset LC_ALL

# Add your existing proxy, editor and tool environment settings here.
# Do not change DISPLAY, XAUTHORITY, desktop XDG_* or tmux/workspace identity.
# Do not start tasks, activate a project virtualenv, install or upgrade tools.
