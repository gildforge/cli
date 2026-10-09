#!/usr/bin/env python3
"""A raw terminal agent; stdout is the only observable event stream."""
import json, os, signal, sys, tty

tty.setraw(0)
mode = sys.argv[1] if len(sys.argv) > 1 else 'lines'
def output(value):
    os.write(1, (json.dumps(value) + '\n').encode())
def resized(*_):
    size = os.get_terminal_size(0)
    output({'size': [size.columns, size.lines]})
signal.signal(signal.SIGWINCH, resized)
if mode == 'jobs':
    pid = os.fork()
    if pid == 0:
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        while True: signal.pause()
    output({'job': pid, 'group': os.getpgrp()})
output({'ready': True, 'pid': os.getpid(), 'env': {k: v for k, v in os.environ.items() if k in ('CLAUDECODE','CLAUDE_PID','CLAUDE_CODE_CHILD_SESSION','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_MESSAGING_TOKEN','CLAUDE_EFFORT','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CODEX_SESSION_ID','CODEX_THREAD_ID','KEEP_TEST','CLAUDE_OTHER','CODEX_OTHER')}, 'term': os.environ.get('TERM')})
resized()
if mode == 'flood':
    while True: os.write(1, b'X'*65536)
if mode == 'bytes':
    expected = bytes([0, 1, 3, 9, 10, 13, 27, 127, 128, 255]) + '🦊'.encode()
    data = b''
    while len(data) < len(expected): data += os.read(0, 4096)
    os.write(1, data)
    sys.exit(37)
if mode == 'ctrl-c':
    while True:
        if b'\x03' in os.read(0, 4096): sys.exit(130)
data = b''
while True:
    chunk = os.read(0, 4096)
    if not chunk: break
    data += chunk
    while b'\r' in data:
        line, data = data.split(b'\r', 1)
        output({'line': line.decode()})
        if line == b'quit': sys.exit(23)
