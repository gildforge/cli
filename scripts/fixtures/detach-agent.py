#!/usr/bin/env python3
"""A PTY agent for detached sessions. As `claude` it runs the generated hook
commands (SessionStart, then UserPromptSubmit/Stop around each line); under any
other name it has no hooks. It reports its terminal size at start and on
SIGWINCH. Argument `stubborn` makes it ignore the hangup `gild stop` sends."""
import sys,os,json,tty,pathlib,subprocess,shlex,signal
settings=None
if '--settings' in sys.argv:
    settings=json.loads(pathlib.Path(sys.argv[sys.argv.index('--settings')+1]).read_text())
if 'stubborn' in sys.argv: signal.signal(signal.SIGHUP,signal.SIG_IGN)
tty.setraw(0)
def hook(name,**extra):
    if not settings: return
    payload={'hook_event_name':name,'session_id':'fixture-detached','transcript_path':'/fixture/transcript.jsonl',**extra}
    for match in settings['hooks'][name]:
        for h in match['hooks']:
            p=subprocess.run(shlex.split(h['command']),input=json.dumps(payload).encode(),capture_output=True)
            assert p.returncode==0 and not p.stdout and not p.stderr
def emit(data): os.write(1,(json.dumps(data)+'\r\n').encode())
def size(*_):
    s=os.get_terminal_size(0);emit({'size':[s.columns,s.lines]})
signal.signal(signal.SIGWINCH,size)
emit({'ready':True});size()
hook('SessionStart')
buffer=b''
while True:
    try: b=os.read(0,1)
    except InterruptedError: continue
    if not b: sys.exit(0)
    if b in [b'\x15',b'\x03']: buffer=b'';continue
    if b==b'\r':
        line=buffer.decode();buffer=b''
        if line=='quit':emit({'line':line});sys.exit(0)
        hook('UserPromptSubmit',prompt=line)
        emit({'line':line})
        hook('Stop')
    else:buffer+=b
