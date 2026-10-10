"""Mention bridge end to end: fake forge + `gild spawn agent` + the PTY fixture agent."""
import os,sys,pty,subprocess,pathlib,tempfile,json,socket,select,time,signal,fcntl,struct,http.server,threading,urllib.parse,termios,re,socketserver
ROOT=pathlib.Path(__file__).resolve().parents[2]
CLI=json.loads(os.environ['TEST_GILD_COMMAND'])
AUTH='--auth' in sys.argv
TRUST='--codex-trust' in sys.argv # Codex opens on its trust dialog; a person answers it
CODEX='--codex' in sys.argv or TRUST # a runtime with no startup hook (Codex)
TOKEN='fixture-scoped-token'
class Server(http.server.ThreadingHTTPServer):
    def server_bind(self):
        # http.server.HTTPServer.server_bind resolves the host with socket.getfqdn,
        # a reverse DNS lookup that hangs where the resolver is slow; tests bind 127.0.0.1.
        socketserver.TCPServer.server_bind(self);self.server_name=self.server_address[0];self.server_port=self.server_address[1]
(ROOT/'.tmp').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=ROOT/'.tmp',prefix='chat-') as d:
    home=pathlib.Path(d);bin=home/'bin';bin.mkdir();(bin/'claude').symlink_to(ROOT/'scripts/fixtures/events-agent.py');(bin/'codex').symlink_to(ROOT/'scripts/fixtures/codex-agent.py')
    for p in [home/'.claude/settings.json']:p.parent.mkdir(parents=True,exist_ok=True);p.write_text('{"hooks":{}}')
    env={**os.environ,'HOME':d,'PATH':str(bin)+os.pathsep+os.environ['PATH']}
    forge={'events':[],'requests':[],'lock':threading.Lock()}
    def mention(cursor,body,agent='owner/fixture',author='sami',mid=None,repo='owner/demo'):
        mid=mid or f'm{cursor}'
        message={'cursor':str(cursor),'id':mid,'created_at':'2026-10-09T00:00:00Z','reply_to':None,'author':{'name':author,'kind':'human'},'kind':'message','body':body,'link':None}
        with forge['lock']:
            n=len(forge['events'])+1
            forge['events'].append({'id':f'mention:{mid}:{agent}','cursor':str(n),'event':'channel.mention','repository':repo,'created_at':'2026-10-09T00:00:00Z','payload':{'repository':{'full_name':repo},'message':message,'author':message['author'],'agent':agent,'history_cursor':str(cursor)}})
    class API(http.server.BaseHTTPRequestHandler):
        def log_message(self,*a):pass
        def address_string(self):return self.client_address[0]
        def do_GET(self):
            url=urllib.parse.urlparse(self.path);q=urllib.parse.parse_qs(url.query)
            assert url.path=='/api/v1/events',url.path
            if self.headers.get('Authorization')!=f'Bearer {TOKEN}' or AUTH:
                self.send_response(401);self.send_header('Content-Type','application/json');self.end_headers()
                self.wfile.write(b'{"message":"token revoked"}');return
            since=int(q.get('since',['0'])[0] or 0)
            forge['requests'].append({'repos':q.get('repos',[''])[0],'since':q.get('since',[''])[0]})
            until=time.monotonic()+.6
            while True:
                with forge['lock']:page=forge['events'][since:]
                if page or time.monotonic()>until:break
                time.sleep(.05)
            try:
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
                self.wfile.write(json.dumps({'events':page,'cursor':str(since+len(page))}).encode())
            except (BrokenPipeError,ConnectionResetError):pass # the agent exited mid long-poll
    api=Server(('127.0.0.1',0),API);threading.Thread(target=api.serve_forever,daemon=True).start()
    origin=f'http://127.0.0.1:{api.server_port}'
    agent_file=home/'.config/gild/agents/fixture.json';agent_file.parent.mkdir(parents=True)
    agent_file.write_text(json.dumps({'schema':1,'name':'owner/fixture','server':origin,'token':TOKEN,'publicKey':'test-public','secretKey':'test-private','requestId':'test-request','createdAt':'2026-10-08T00:00:00Z'}));agent_file.chmod(0o600)
    work=home/'workspace';work.mkdir()
    profile_file=home/'.gild/agents/fixture.json';profile_file.parent.mkdir(parents=True)
    profile_file.write_text(json.dumps({'name':'fixture','runtime':'codex' if CODEX else 'claude','directory':str(work),'args':['--trust-dialog'] if TRUST else [],'channels':['owner/demo'],'env':['PATH','HOME']}))
    path=home/'.gild/sessions/fixture.sock'
    class Run:
        def __init__(self):
            self.m,self.s=pty.openpty();fcntl.ioctl(self.s,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
            self.proc=subprocess.Popen(CLI+['spawn','agent','fixture'],stdin=self.s,stdout=self.s,stderr=self.s,env=env,cwd=ROOT,start_new_session=True)
            self.buf=b'';self.stream=None;self.events=b''
        def read(self,t=.1):
            until=time.monotonic()+t
            while time.monotonic()<until:
                if select.select([self.m],[],[],max(0,until-time.monotonic()))[0]:self.buf+=os.read(self.m,65536)
                else:break
            if self.stream:
                while select.select([self.stream],[],[],0)[0]:
                    got=self.stream.recv(65536)
                    if not got:break
                    self.events+=got
        def request(self,body):
            with socket.socket(socket.AF_UNIX) as c:
                c.connect(str(path));c.sendall(json.dumps(body).encode()+b'\n');return c.recv(65536)
        def status(self):return json.loads(self.request({'type':'info'}))
        def wait(self,check,t=10):
            until=time.monotonic()+t
            while time.monotonic()<until:
                self.read(.05)
                try:
                    if check():return
                except (AssertionError,KeyError,FileNotFoundError,ConnectionRefusedError,json.JSONDecodeError,IndexError):pass
            raise AssertionError((check,self.buf,self.events))
        def hook(self,name,**extra):
            p=subprocess.run(CLI+['hook','--session','fixture'],input=json.dumps({'hook_event_name':name,**extra}).encode(),env=env,capture_output=True,timeout=3)
            assert p.returncode==0 and p.stdout==b'' and p.stderr==b''
        def lines(self):return [json.loads(l)['line'] for l in self.buf.splitlines() if l.startswith(b'{') and 'line' in json.loads(l)]
        def prompts(self):return [l for l in self.lines() if '[gild] @' in l]
        def stages(self,mid=None):
            out=[]
            for l in self.events.decode().splitlines():
                e=json.loads(l)
                if e.get('type')=='mention' and (mid is None or e['id']==mid):out.append((e['id'],e['stage']))
            return out
        def subscribe(self):
            self.stream=socket.socket(socket.AF_UNIX);self.stream.connect(str(path));self.stream.sendall(b'{"type":"subscribe"}\n')
        def stop(self):
            if self.proc.poll() is None:
                self.proc.send_signal(signal.SIGTERM);assert self.proc.wait(timeout=8)==143
            if self.stream:self.stream.close()
            os.close(self.m);os.close(self.s)
    run=None
    try:
        run=Run();run.wait(lambda:b'"ready": true' in run.buf)
        if CODEX:
            # Codex reports nothing until its first turn ends. A mention to a fresh
            # session must still be typed once its first screen has gone quiet.
            # The fixture keeps Codex's update menu and paste-burst traps unless
            # the session turns them off; either one leaves the prompt unsent.
            run.wait(lambda:run.status()['channels']==[{'repo':'owner/demo','state':'listening'}])
            mention(2,'@fixture what is 6 x 7? ask bob')
            if TRUST:
                # A channel message must never answer the trust dialog for a person.
                run.read(3);assert run.prompts()==[] and b'"dialog"' not in run.buf,run.buf
                assert run.status()['held']['reason']=='agent not idle',run.status()
                # The person presses Enter. Codex never reports that this was no
                # prompt, so the inferred busy state must fall back to idle.
                os.write(run.m,b'\r');run.wait(lambda:b'"dialog": "trusted", "typed": ""' in run.buf)
            run.wait(lambda:len(run.prompts())==1,t=10)
            assert 'what is 6 x 7? ask bob' in run.prompts()[0]
            assert b'"menu"' not in run.buf,run.buf
            # Its turn ends (Codex notify), so a typed one-line `gild send` goes in;
            # it is not bracket-pasted, which is where paste-burst detection bites.
            run.wait(lambda:run.status()['state']=='idle')
            p=subprocess.run(CLI+['send','fixture','reply with pong'],env=env,capture_output=True,timeout=8);assert p.returncode==0,p.stderr
            run.wait(lambda:'reply with pong' in run.lines(),t=5)
            print(json.dumps({'passed':True}));raise SystemExit(0)
        run.wait(lambda:run.status()['state']=='idle')
        run.subscribe()
        if AUTH:
            run.wait(lambda:run.status()['channels'][0]['state']=='error')
            ch=run.status()['channels'][0];assert ch['repo']=='owner/demo' and 'token revoked' in ch['error'],ch
            run.wait(lambda:any(json.loads(l).get('type')=='channel' and json.loads(l)['state']=='error' for l in run.events.decode().splitlines()))
            assert TOKEN not in run.events.decode() and TOKEN not in json.dumps(run.status())
            # The agent itself keeps working: a local send still reaches it.
            p=subprocess.run(CLI+['send','fixture','still alive'],env=env,capture_output=True,timeout=8);assert p.returncode==0,p.stderr
            run.wait(lambda:'still alive' in run.lines())
            print(json.dumps({'passed':True}));raise SystemExit(0)
        run.wait(lambda:run.status()['channels']==[{'repo':'owner/demo','state':'listening'}])
        assert forge['requests'][0]['repos']=='owner/demo'
        # A mention for someone else is served but never typed.
        mention(3,'@other not you',agent='owner/other')
        mention(5,'@fixture ask @bob for the number')
        run.wait(lambda:len(run.prompts())==1)
        first=run.prompts()[0]
        assert 'mentioned you in owner/demo (message 5)' in first and '@sami' in first and 'ask @bob for the number' in first,first
        # The commands name the gild that spawned the session (CLI), not a PATH lookup.
        context=re.search(r"Context: (.+) chat history owner/demo --agent fixture --before 6 --limit 30",first)
        reply=re.search(r'Reply:   (.+) chat send owner/demo --agent fixture --reply-to 5 "<your reply>"',first)
        assert context and reply and context[1]==reply[1],first
        assert context[1]!='gild' and 'gild' in context[1],first # the spawning gild's own path
        assert TOKEN not in first
        assert run.status()['state']=='busy'
        # Duplicate delivery of the same message under a new event cursor, plus a second mention while busy.
        mention(5,'@fixture ask @bob for the number',mid='m5')
        mention(7,'@fixture second')
        run.wait(lambda:forge['requests'][-1]['since']==str(len(forge['events'])));run.read(.3)
        assert len(run.prompts())==1,run.prompts() # held: agent busy
        assert not any('not you' in l for l in run.lines())
        assert run.status()['held']['queued']==1,run.status()
        # A draft in the composer holds the queued mention until cleared.
        os.write(run.m,b'draft');run.hook('Stop');run.read(.5)
        assert len(run.prompts())==1,run.prompts()
        os.write(run.m,b'\x15');run.wait(lambda:len(run.prompts())==2)
        assert 'message 7' in run.prompts()[1]
        run.wait(lambda:[s for _,s in run.stages('m5')]==['received','queued','delivered'])
        run.wait(lambda:[s for _,s in run.stages('m7')]==['received','queued','delivered'])
        assert run.stages('m3')==[],run.stages('m3')
        assert [x for x in run.stages() if x[0]=='m5']==[('m5','received'),('m5','queued'),('m5','delivered')]
        assert path.parent.joinpath('fixture.mentions.json').exists()
        saved=json.loads(path.parent.joinpath('fixture.mentions.json').read_text())
        assert saved['delivered']==['m5','m7'] and saved['cursors']['owner/demo']==str(len(forge['events'])),saved
        assert oct(path.parent.joinpath('fixture.mentions.json').stat().st_mode&0o777)=='0o600'
        run.hook('Stop')
        run.stop();run=None
        # Restart: the persisted cursor stops the replay, a new mention is typed once.
        forge['requests'].clear()
        run=Run();run.wait(lambda:b'"ready": true' in run.buf);run.wait(lambda:run.status()['channels'][0]['state']=='listening')
        assert forge['requests'][0]['since']==str(len(forge['events'])),forge['requests'][:2]
        run.read(.5);assert run.prompts()==[],run.prompts()
        run.subscribe()
        mention(9,'@fixture after restart')
        run.wait(lambda:len(run.prompts())==1);assert 'message 9' in run.prompts()[0]
        run.read(.5);assert len(run.prompts())==1
        assert '"stage": "delivered"' in run.events.decode() or '"stage":"delivered"' in run.events.decode()
        print(json.dumps({'passed':True}))
    finally:
        if run is not None:
            if run.proc.poll() is None:run.proc.terminate();run.proc.wait(timeout=8)
            try:os.close(run.m);os.close(run.s)
            except OSError:pass
        api.shutdown()
