import os,sys,pty,subprocess,pathlib,tempfile,json,socket,select,time,signal,fcntl,struct,hashlib,http.server,threading,socketserver
ROOT=pathlib.Path(__file__).resolve().parents[2]
CLI=json.loads(os.environ['TEST_GILD_COMMAND'])
class Server(http.server.ThreadingHTTPServer):
    def server_bind(self):
        # http.server.HTTPServer.server_bind resolves the host with socket.getfqdn,
        # a reverse DNS lookup that hangs where the resolver is slow; tests bind 127.0.0.1.
        socketserver.TCPServer.server_bind(self);self.server_name=self.server_address[0];self.server_port=self.server_address[1]
with tempfile.TemporaryDirectory(dir=ROOT/'.tmp',prefix='ev-') as d:
    home=pathlib.Path(d);bin=home/'bin';bin.mkdir();(bin/'claude').symlink_to(ROOT/'scripts/fixtures/events-agent.py')
    configs=[home/'.claude/settings.json',home/'project/.claude/settings.json',home/'project/.claude/settings.local.json']
    for p in configs:p.parent.mkdir(parents=True,exist_ok=True);p.write_text('{"hooks":{}}')
    before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in configs]
    env={**os.environ,'HOME':d,'PATH':str(bin)+os.pathsep+os.environ['PATH']}
    names_mode='--profile-names' in sys.argv
    local_mode='--profile-local' in sys.argv
    stale_mode='--profile-stale' in sys.argv
    profile_mode='--profile' in sys.argv or names_mode or local_mode or stale_mode
    reporting='--report' in sys.argv or profile_mode
    reports=[];api=None;cwd=ROOT;extra=[]
    if reporting:
        class API(http.server.BaseHTTPRequestHandler):
            def log_message(self,*a):pass
            def address_string(self):return self.client_address[0]
            def do_GET(self):
                if self.path.endswith('/instructions'):
                    body={'text':'','revision':hashlib.sha256(b'').hexdigest(),'history':[]}
                    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(body).encode())
                elif self.path.startswith('/api/v1/events'):
                    time.sleep(.5);self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"events":[],"cursor":"0"}')
                else:self.send_response(404);self.end_headers()
            def do_POST(self):
                assert self.headers.get('Authorization')=='Bearer fixture-scoped-token'
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                reports.append({'at':time.monotonic(),'body':body})
                self.send_response(201);self.send_header('Content-Type','application/json');self.end_headers()
                self.wfile.write(json.dumps({**body,'repository':'owner/demo','target':'commit:'+sha,'created_at':body['started_at'],'updated_at':body['started_at'],'version':len(reports),'closed':body['ended_at'] is not None,'reported_by':'agent'}).encode())
        api=Server(('127.0.0.1',0),API);threading.Thread(target=api.serve_forever,daemon=True).start()
        cwd=home/'repo';cwd.mkdir()
        subprocess.run(['git','init','-q',str(cwd)],check=True)
        subprocess.run(['git','-C',str(cwd),'fetch','-q',str(ROOT),'HEAD','--depth=1'],check=True)
        subprocess.run(['git','-C',str(cwd),'checkout','-q','FETCH_HEAD'],check=True)
        sha=subprocess.check_output(['git','-C',str(cwd),'rev-parse','HEAD'],text=True).strip()
        origin=f'http://127.0.0.1:{api.server_port}'
        subprocess.run(['git','-C',str(cwd),'remote','add','origin',origin+'/owner/demo.git'],check=True)
        agent_file=home/'.config/gild/agents/fixture.json';agent_file.parent.mkdir(parents=True)
        agent_file.write_text(json.dumps({'schema':1,'name':'owner/fixture','server':origin,'token':'fixture-scoped-token','publicKey':'test-public','secretKey':'test-private','requestId':'test-request','createdAt':'2026-10-08T00:00:00Z'}));agent_file.chmod(0o600)
        extra=['--as','fixture']
    if local_mode:
        cwd=home/'workspace';cwd.mkdir()
    session='fixture' if profile_mode else 'events'
    native=['claude']
    if profile_mode:
        profile_file=home/'.gild/agents/fixture.json';profile_file.parent.mkdir(parents=True)
        profile_file.write_text(json.dumps({'name':'fixture','runtime':'claude','model':'claude-opus-5-5','effort':'high','directory':str(cwd),'args':['--allowedTools','Read'],'channels':['owner/demo'],'env':['PATH','HOME','KEEP_TEST']}))
        env.update({'KEEP_TEST':'allowed','KEEP_DROP':'blocked'})
        extra=[];native=['agent','fixture','--resume','a b','--','--as','literal']
    if stale_mode:
        stale=home/'.gild/sessions/fixture.sock';stale.parent.mkdir(parents=True,exist_ok=True)
        old=socket.socket(socket.AF_UNIX);old.bind(str(stale));old.close()
    m,s=pty.openpty();fcntl.ioctl(s,termios_TIOCSWINSZ:=getattr(__import__('termios'),'TIOCSWINSZ'),struct.pack('HHHH',24,80,0,0))
    proc=subprocess.Popen(CLI+['spawn']+([] if profile_mode else ['--name','events'])+extra+native,stdin=s,stdout=s,stderr=s,env=env,cwd=ROOT if profile_mode else cwd,start_new_session=True)
    path=home/f'.gild/sessions/{session}.sock';buf=b''
    def read(t=.1):
        global buf
        until=time.monotonic()+t
        while time.monotonic()<until:
            if select.select([m],[],[],max(0,until-time.monotonic()))[0]:buf+=os.read(m,65536)
            else:break
    def request(body):
        with socket.socket(socket.AF_UNIX) as c:
            c.connect(str(path));c.sendall(json.dumps(body).encode()+b'\n');return c.recv(65536)
    def status():return json.loads(request({'type':'info'}))
    def wait(check):
        until=time.monotonic()+8
        while time.monotonic()<until:
            read(.05)
            if check():return
        raise AssertionError(buf)
    def hook(name,**extra):
        p=subprocess.run(CLI+['hook','--session',session],input=json.dumps({'hook_event_name':name,**extra}).encode(),env=env,capture_output=True,timeout=2)
        assert p.returncode==0 and p.stdout==b'' and p.stderr==b''
    def send(text):
        p=subprocess.run(CLI+['send',session,text],env=env,capture_output=True);assert p.returncode==0,p.stderr
    def lines():
        return [json.loads(l)['line'] for l in buf.splitlines() if l.startswith(b'{') and 'line' in json.loads(l)]
    stream=None;second=None;second_m=None;second_s=None
    try:
        wait(lambda:b'"ready": true' in buf)
        assert status()['state']=='idle' # a new session waits at its prompt
        if profile_mode:
            ready=next(json.loads(l) for l in buf.splitlines() if l.startswith(b'{') and json.loads(l).get('ready'))
            assert ready['cwd']==str(cwd),ready
            assert ready['env']=={'KEEP_TEST':'allowed'},ready
            assert ready['argv'][2:]==['--model','claude-opus-5-5','--effort','high','--allowedTools','Read','--resume','a b','--','--as','literal'],ready
            assert status()['profile']=='fixture' and status()['id']=='fixture'
            assert status()['identity']=='owner/fixture'
            assert status()['channels']==[{'repo':'owner/demo','state':'connecting'}]
            assert 'fixture-scoped-token' not in profile_file.read_text()

        if names_mode:
            second_m,second_s=pty.openpty()
            second=subprocess.Popen(CLI+['spawn','--print-id','agent','fixture'],stdin=second_s,stdout=second_s,stderr=second_s,env=env,cwd=ROOT,start_new_session=True)
            second_buf=b'';deadline=time.monotonic()+8
            while b'"ready": true' not in second_buf and time.monotonic()<deadline:
                if select.select([second_m],[],[],.05)[0]:second_buf+=os.read(second_m,65536)
                if second.poll() is not None:break
            assert b'"ready": true' in second_buf,second_buf
            assert b'fixture-2\r\n' in second_buf or b'fixture-2\n' in second_buf,second_buf
            listed=subprocess.run(CLI+['sessions','--json'],env=env,capture_output=True,timeout=8)
            assert listed.returncode==0,listed.stderr
            sessions=json.loads(listed.stdout)
            assert {x['id'] for x in sessions}=={'fixture','fixture-2'},sessions
            assert all(x['profile']=='fixture' and x['cwd']==str(cwd) for x in sessions),sessions
            with socket.socket(socket.AF_UNIX) as c:
                c.connect(str(home/'.gild/sessions/fixture-2.sock'));c.sendall(b'{"type":"info"}\n')
                assert json.loads(c.recv(65536))['state']=='idle'
            # Delivered straight after start: no turn has to finish first.
            sent=subprocess.run(CLI+['send','fixture-2','second session'],env=env,capture_output=True,timeout=8)
            assert sent.returncode==0,sent.stderr
            deadline=time.monotonic()+8
            while b'"line": "second session"' not in second_buf and time.monotonic()<deadline:
                if select.select([second_m],[],[],.05)[0]:second_buf+=os.read(second_m,65536)
            assert b'"line": "second session"' in second_buf,second_buf
            second.send_signal(signal.SIGTERM);assert second.wait(timeout=8)==143
            assert not (home/'.gild/sessions/fixture-2.sock').exists()
            assert not (home/'.gild/sessions/fixture-2/settings.json').exists()
            reports.clear() # Subsequent assertions concern the original live receipt.
        if reporting:
            argv=subprocess.check_output(['ps','-p',str(status()['pid']),'-o','command='],text=True)
            assert 'fixture-scoped-token' not in argv
        stream=socket.socket(socket.AF_UNIX);stream.connect(str(path));stream.sendall(b'{"type":"subscribe"}\n')
        hook('UserPromptSubmit',prompt='human turn')
        send('first');send('second');read(.2);assert lines()==[]
        os.write(m,b'draft');hook('Stop');read(.3);assert lines()==[]
        os.write(m,b'\x15');wait(lambda:lines()==['first'])
        assert status()['state']=='busy'
        if reporting:
            argv=subprocess.check_output(['ps','-p',str(status()['pid']),'-o','command='],text=True)
            assert 'fixture-scoped-token' not in argv;read(.2);assert lines()==['first']
        hook('PreToolUse',tool_name='Edit',tool_input={'secret':'local only'});assert status()['state']=='tool_start' and status()['tool']=='Edit'
        hook('PostToolUse',tool_name='Edit');assert status()['state']=='busy'
        hook('Notification',notification_type='permission_prompt');assert status()['state']=='waiting'
        hook('Stop');wait(lambda:lines()==['first','second'])
        hook('Stop');os.write(m,b'paste\x1b[200~one\ntwo\x1b[201~');send('third');read(.2);assert lines()==['first','second']
        os.write(m,b'\x03');wait(lambda:lines()==['first','second','third'])
        hook('Stop');assert status()['state']=='idle'
        settings=home/f'.gild/sessions/{session}/settings.json';assert settings.stat().st_mode&0o777==0o600
        proc.send_signal(signal.SIGTERM);assert proc.wait(timeout=8)==143
        assert not path.exists() and not settings.exists()
        assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in configs]==before
        stream.settimeout(2);events=stream.recv(65536).decode().splitlines()
        assert any(json.loads(e)['type']=='waiting' for e in events)
        if local_mode:assert reports==[],reports
        if reporting and not local_mode:
            assert reports and reports[-1]['body']['state']['status']=='ended',reports
            assert reports[-1]['body']['ended_at'] is not None
            assert len({r['body']['id'] for r in reports})==1
            for previous,current in zip(reports,reports[1:]):assert current['at']-previous['at']>=.98
            for r in reports:
                b=r['body'];assert b['notes']=='' and b['commands']==[] and b['files']=={'read':[],'written':[]}
                assert set(b['state'])<= {'status','tool','last_activity'}
                assert 'local only' not in json.dumps(b) and 'secret' not in json.dumps(b)
        print(json.dumps({'passed':True,'events':[json.loads(e)['type'] for e in events]}))
    finally:
        if proc.poll() is None:proc.terminate();proc.wait(timeout=8)
        if second is not None and second.poll() is None:second.terminate();second.wait(timeout=8)
        if second_m is not None:os.close(second_m);os.close(second_s)
        if api:api.shutdown()
        if stream:stream.close()
        os.close(m);os.close(s)
