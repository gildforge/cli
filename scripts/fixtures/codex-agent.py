#!/usr/bin/env python3
"""A Codex-like PTY composer with Codex's three traps for typed prompts:
no startup hook, an update menu, and paste-burst detection."""
import sys,os,json,tty,time,subprocess
tty.setraw(0)
def emit(data): os.write(1,(json.dumps(data)+'\n').encode())
def config(key): return any(a==key for a in sys.argv[1:])
def notify_command():
    for a in sys.argv[1:]:
        if a.startswith('notify='): return json.loads(a[len('notify='):])
def turn_complete():
    # What Codex runs after each turn: the notify program with one JSON argument.
    p=subprocess.run(notify_command()+[json.dumps({'type':'agent-turn-complete','thread-id':'fixture-thread'})],capture_output=True)
    assert p.returncode==0,p.stderr
# Codex draws its first screen over a few hundred milliseconds and then sits
# at its composer; nothing tells gild it is ready.
for part in ['\x1b[2J', 'OpenAI Codex\r\n', '› Ask Codex to do anything\r\n']:
    os.write(1,part.encode());time.sleep(.2)
emit({'ready':True,'argv':sys.argv[1:]})
update_menu=not config('check_for_update_on_startup=false')
paste_burst=not config('tui.disable_paste_burst=true')
buffer=b'';last=0.0
while True:
    b=os.read(0,1);now=time.monotonic()
    if b in [b'\x15',b'\x03']: buffer=b'';continue
    if b==b'\r':
        # Codex's update menu takes the first Enter as "Update now".
        if update_menu: update_menu=False;buffer=b'';emit({'menu':'update'});continue
        # Enter right after a burst of typed text is folded into the "paste";
        # a bracketed paste (multi-line prompts) is not a burst.
        if paste_burst and now-last<.15 and not buffer.endswith(b'\x1b[201~'): buffer+=b'\n';continue
        line=buffer.decode();buffer=b''
        emit({'line':line})
        if line=='quit':sys.exit(0)
        if notify_command(): turn_complete()
    else:buffer+=b;last=now
