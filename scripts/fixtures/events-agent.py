#!/usr/bin/env python3
"""A PTY composer that runs the actual generated Claude hook commands."""
import sys,os,json,tty,pathlib,subprocess,shlex
if '--version' in sys.argv:
    print('claude fixture 1.0');sys.exit(0)
settings=json.loads(pathlib.Path(sys.argv[sys.argv.index('--settings')+1]).read_text())
tty.setraw(0)
def hook(name,**extra):
    payload={'hook_event_name':name,'session_id':'fixture-native-id','transcript_path':'/fixture/transcript.jsonl',**extra}
    for match in settings['hooks'][name]:
        for h in match['hooks']:
            p=subprocess.run(shlex.split(h['command']),input=json.dumps(payload).encode(),capture_output=True)
            assert p.returncode==0 and not p.stdout and not p.stderr
    return payload
def emit(data): os.write(1,(json.dumps(data)+'\n').encode())
hook('SessionStart');emit({'ready':True,'argv':sys.argv[1:],'cwd':os.getcwd(),'env':{k:v for k,v in os.environ.items() if k.startswith('KEEP_')}})
buffer=b''
while True:
    b=os.read(0,1)
    if b in [b'\x15',b'\x03']: buffer=b'';continue
    if b==b'\r':
        line=buffer.decode();buffer=b''
        if line!='quit':hook('UserPromptSubmit',prompt=line)
        emit({'line':line})
        if line=='quit':sys.exit(0)
    else:buffer+=b
