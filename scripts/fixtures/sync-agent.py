#!/usr/bin/env python3
"""Edits its working directory on command (for spawn --vm working-directory sync)."""
import os, json, sys, tty
tty.setraw(0)
def emit(data): os.write(1, (json.dumps(data) + '\n').encode())
def write(path, text):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w') as f: f.write(text)
def round1():
    write('new.txt', 'created in the guest\n')
    write('marker.txt', 'edited in the guest\n')
    os.remove('gone.txt')
    write('sub/dir/deep.txt', 'nested\n')
    os.chmod('run.sh', 0o755)
    os.symlink('marker.txt', 'link')
    write('both.txt', 'guest version\n')
def round2():
    write('later.txt', 'written after the on-demand sync\n')
emit({'ready': True, 'cwd': os.getcwd()})
buffer = b''
while True:
    b = os.read(0, 1)
    if b != b'\r':
        buffer += b
        continue
    line, buffer = buffer.decode(), b''
    if line == 'round1': round1()
    elif line == 'round2': round2()
    emit({'done': line})
    if line == 'quit': sys.exit(0)
