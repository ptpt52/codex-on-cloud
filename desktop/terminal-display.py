#!/usr/bin/env python3
"""Fixed xterm font lookup and EWMH window actions; no shell commands or input text."""
import ctypes
import json
import os
from pathlib import Path
import sys
import stat


def font_size():
    file = Path(__file__).resolve().parents[1] / 'data' / 'desktop-settings.json'
    try:
        fd = os.open(str(file), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return 15
    with os.fdopen(fd, 'rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError('settings must be a regular file')
        body = source.read(1025)
    if len(body) > 1024:
        raise ValueError('settings too large')
    value = json.loads(body)
    size = value.get('fontSize')
    if value.get('version') != 1 or type(size) is not int or not 10 <= size <= 28:
        raise ValueError('invalid terminal font size')
    return size


def window_state(action, window):
    if action not in ('maximize', 'restore') or not window.isdecimal():
        raise ValueError('invalid window action')
    x11 = ctypes.CDLL('libX11.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]

    class Message(ctypes.Structure):
        _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                    ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong),
                    ('format', ctypes.c_int), ('data', ctypes.c_long * 5)]

    class Event(ctypes.Union):
        _fields_ = [('message', Message), ('padding', ctypes.c_long * 24)]

    display = x11.XOpenDisplay(None)
    if not display:
        raise RuntimeError('virtual display unavailable')
    try:
        atom = lambda name: x11.XInternAtom(display, name.encode(), 0)
        event = Event()
        event.message = Message(33, 0, 1, display, int(window), atom('_NET_WM_STATE'), 32,
                                (ctypes.c_long * 5)(1 if action == 'maximize' else 0,
                                 atom('_NET_WM_STATE_MAXIMIZED_VERT'), atom('_NET_WM_STATE_MAXIMIZED_HORZ'), 2, 0))
        if not x11.XSendEvent(display, x11.XDefaultRootWindow(display), 0, (1 << 20) | (1 << 19), ctypes.byref(event)):
            raise RuntimeError('window manager did not accept action')
        x11.XFlush(display)
    finally:
        x11.XCloseDisplay(display)


if __name__ == '__main__':
    if sys.argv[1:] == ['font']:
        print(font_size())
    elif len(sys.argv) == 3:
        window_state(sys.argv[1], sys.argv[2])
    else:
        raise SystemExit('unsupported terminal display action')
