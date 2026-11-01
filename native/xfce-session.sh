#!/usr/bin/env bash
set -eu
# Start the desktop components explicitly. A full xfce4-session would also run
# the host's global autostart entries (backup, power management, screen locker).
xfwm4 --compositor=off &
xfsettingsd --no-daemon &
xfdesktop &
xfce4-panel --disable-wm-check &
wait -n
exit 1
