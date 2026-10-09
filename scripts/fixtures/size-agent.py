#!/usr/bin/env python3
"""Reports its terminal size at start and on every resize (for spawn --vm)."""
import os, json, signal, sys, time, tty
tty.setraw(0)
def report(*_):
    c, r = os.get_terminal_size(0)
    os.write(1, (json.dumps({'size': [r, c]}) + '\n').encode())
signal.signal(signal.SIGWINCH, report)
report()
while True:
    data = os.read(0, 1)
    if data == b'q': sys.exit(0)
