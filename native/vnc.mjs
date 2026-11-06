// Enable RandR's X error traps before the very first framebuffer read. The
// old automatic mode only enables them after processing its first resize event;
// shrinking in that gap can terminate x11vnc with MIT-SHM BadMatch.
export function vncArguments(display, authority) {
  return ['-norc', '-inetd', '-display', display, '-auth', authority, '-xrandr', 'resize',
    '-no6', '-noipv6', '-rfbport', '0', '-nopw', '-noremote', '-nolookup', '-noxrecord', '-quiet'];
}
