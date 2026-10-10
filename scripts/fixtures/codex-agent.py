#!/usr/bin/env python3
"""A Codex-like PTY composer: no startup hook, a screen drawn in pieces, then a prompt."""
import sys,os,json,tty,time
tty.setraw(0)
def emit(data): os.write(1,(json.dumps(data)+'\n').encode())
# Codex draws its first screen over a few hundred milliseconds and then sits
# at its composer; nothing tells gild it is ready.
for part in ['\x1b[2J', 'OpenAI Codex\r\n', '› Ask Codex to do anything\r\n']:
    os.write(1,part.encode());time.sleep(.2)
emit({'ready':True,'argv':sys.argv[1:]})
buffer=b''
while True:
    b=os.read(0,1)
    if b in [b'\x15',b'\x03']: buffer=b'';continue
    if b==b'\r':
        line=buffer.decode();buffer=b''
        emit({'line':line})
        if line=='quit':sys.exit(0)
    else:buffer+=b
