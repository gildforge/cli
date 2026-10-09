"""Native fallback preconditions, preserved configuration and one terminal SIGINT."""
import json, os, pathlib, pty, select, signal, subprocess, sys, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = json.loads(os.environ['TEST_GILD_COMMAND'])
NODE = os.environ['TEST_NODE']
if CLI[0] == 'node': CLI[0] = NODE
WORKER = os.environ['TEST_WORKER']
CASE = sys.argv[1]
with tempfile.TemporaryDirectory(dir=ROOT/'.tmp', prefix='r-') as d:
    root=pathlib.Path(d)
    native=root/'agent'
    native.write_text('#!'+sys.executable+'\nimport json,os,sys,signal,time\n'
        'print(json.dumps({"args":sys.argv[1:],"oauth":os.getenv("CLAUDE_CODE_OAUTH_TOKEN"),"bedrock":os.getenv("CLAUDE_CODE_USE_BEDROCK"),"effort":os.getenv("CLAUDE_EFFORT"),"marker":os.getenv("CLAUDECODE"),"chain":os.getenv("GILD_SPAWN_CHAIN")}),flush=True)\n'
        'if "interrupt" in sys.argv:\n'
        ' def interrupted(*_):\n'
        '  with open(os.environ["COUNTS"],"a") as f:f.write("SIGINT\\n")\n'
        ' signal.signal(signal.SIGINT,interrupted)\n'
        ' print("READY",flush=True)\n'
        ' time.sleep(0.6)\n'
        ' sys.exit(130)\n'
        'sys.exit(37)\n')
    native.chmod(0o755)
    env={**os.environ,'HOME':d,'CLAUDECODE':'nested','CLAUDE_CODE_CHILD_SESSION':'nested','CLAUDE_CODE_OAUTH_TOKEN':'fixture-config','CLAUDE_CODE_USE_BEDROCK':'1','CLAUDE_EFFORT':'high','COUNTS':str(root/'counts')}
    env.pop('GILD_DEBUG',None)
    interactive=CASE!='native-env' and CASE!='native-interrupt'
    args=['interrupt'] if CASE=='native-interrupt' else ['payload']
    cmd=CLI+['spawn',str(native)]+args
    if CASE=='no-node':env['PATH']=str(root)
    if CASE in ('no-addon','pty-failure','windows'):
        options={'agent':str(native),'args':args,'id':'test','idleMs':50,'resolveFrom':[],'hookCommand':CLI}
        if CASE=='pty-failure':
            module=root/'node_modules/node-pty';module.mkdir(parents=True)
            (module/'package.json').write_text('{"main":"index.js"}')
            (module/'index.js').write_text('exports.spawn = () => { throw new Error("fixture PTY creation failure") }')
            options['resolveFrom']=[str(root/'entry.js')]
        prefix="Object.defineProperty(process, 'platform', {value:'win32'});" if CASE=='windows' else ''
        cmd=[NODE,'--input-type=module','-e',prefix+'process.argv[1]='+json.dumps(json.dumps(options))+';await import('+json.dumps(pathlib.Path(WORKER).as_uri())+')']
    master=slave=None
    try:
        if interactive:
            master,slave=pty.openpty()
            import termios
            saved=termios.tcgetattr(slave)
            proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env,cwd=ROOT,start_new_session=True)
            stream=b'';deadline=time.monotonic()+8
            while proc.poll() is None and time.monotonic()<deadline:
                if select.select([master],[],[],.05)[0]:stream+=os.read(master,65536)
            code=proc.wait(timeout=1)
            while select.select([master],[],[],0)[0]:stream+=os.read(master,65536)
            assert termios.tcgetattr(slave)==saved,('fallback terminal mismatch', saved, termios.tcgetattr(slave))
            assert code == 37, (code, stream)
            result=json.loads(stream)
        elif CASE=='native-interrupt':
            proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,cwd=ROOT,start_new_session=True)
            result=json.loads(proc.stdout.readline());assert proc.stdout.readline()==b'READY\n'
            os.killpg(proc.pid,signal.SIGINT)
            out,err=proc.communicate(timeout=8);code=proc.returncode
            assert out==b'' and err==b'',(out,err)
            assert (root/'counts').read_text().splitlines()==['SIGINT'],'SIGINT delivered twice'
        else:
            proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,cwd=ROOT,start_new_session=True)
            out,err=proc.communicate(timeout=8);code=proc.returncode
            assert err==b'',err
            result=json.loads(out)
        assert code==(130 if CASE=='native-interrupt' else 37),code
        assert result['args']==args,result
        assert result['oauth']=='fixture-config' and result['bedrock']=='1' and result['effort']=='high',result
        assert result['marker'] is None,result
        assert not list(root.glob('.gild/sessions/*')),list(root.glob('.gild/sessions/*'))
        assert not list(root.glob('.gild/sessions/*/settings.json'))
        print(json.dumps({'case':CASE,'passed':True}))
    finally:
        if 'proc' in locals() and proc.poll() is None:proc.kill();proc.wait()
        if master is not None:os.close(master);os.close(slave)
