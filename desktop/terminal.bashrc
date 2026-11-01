# The user's shell setup may override PATH. Preserve the selected Node/Codex path.
codex_cloud_path="$PATH"
if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
export PATH="$codex_cloud_path:$PATH"
unset codex_cloud_path
bind 'set enable-bracketed-paste on'
