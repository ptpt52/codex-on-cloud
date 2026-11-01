#!/usr/bin/env bash
set -eu
# Start the desktop components explicitly. A full xfce4-session would also run
# the host's global autostart entries (backup, power management, screen locker).
xfwm4 --compositor=off &
window_manager=$!
xfsettingsd --no-daemon &
# Old xfdesktop builds divide by zero when an icon grid has no rows on a short
# screen. This virtual workspace uses the application menu rather than icons.
xfconf-query -c xfce4-desktop -p /desktop-icons/style --create -t int -s 0
xfdesktop &
xfce4-panel --disable-wm-check &
# A wallpaper or panel failure must not terminate the X server and tmux task.
wait "$window_manager"
exit 1
