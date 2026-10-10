import hashlib
"""Watchdog nudges end to end: fake forge + `gild spawn --nudge … agent` + the PTY fixture agent."""
import os,sys,pty,subprocess,pathlib,tempfile,json,socket,select,time,signal,fcntl,struct,http.server,threading,urllib.parse,termios
ROOT=pathlib.Path(__file__).resolve().parents[2]
CLI=json.loads(os.environ['TEST_GILD_COMMAND'])
TOKEN='fixture-scoped-token'
def iso(t):return time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime(t))+'.000Z'
(ROOT/'.tmp').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=ROOT/'.tmp',prefix='nudge-') as d:
    home=pathlib.Path(d);bin=home/'bin';bin.mkdir();(bin/'claude').symlink_to(ROOT/'scripts/fixtures/events-agent.py')
    for p in [home/'.claude/settings.json']:p.parent.mkdir(parents=True,exist_ok=True);p.write_text('{"hooks":{}}')
    env={**os.environ,'HOME':d,'PATH':str(bin)+os.pathsep+os.environ['PATH']}
    forge={'events':{},'posts':[],'messages':{},'reads':[],'lock':threading.Lock()}
    def add(repo,event,payload):
        with forge['lock']:
            lst=forge['events'].setdefault(repo,[]);n=len(lst)+1
            lst.append({'id':f'{repo}:{n}','cursor':str(n),'event':event,'repository':repo,'created_at':iso(time.time()),'payload':payload})
    def mention(cursor,body):
        message={'cursor':str(cursor),'id':f'm{cursor}','created_at':iso(time.time()),'reply_to':None,'author':{'name':'sami','kind':'human'},'kind':'message','body':body,'link':None}
        add('owner/demo','channel.mention',{'repository':{'full_name':'owner/demo'},'message':message,'author':message['author'],'agent':'owner/fixture','history_cursor':str(cursor)})
    def run_event(id,branch,actor='owner/fixture',kind='push'):
        add('owner/ci','workflow_run',{'action':'completed','workflow_run':{'id':id,'name':'CI','head_branch':branch,'event':kind,'conclusion':'failure','completed_at':iso(time.time()+1),'html_url':f'http://forge/owner/ci/actions/{id}','actor':{'login':actor}}})
    class API(http.server.BaseHTTPRequestHandler):
        def log_message(self,*a):pass
        def reply(self,code,body):
            try:
                self.send_response(code);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(body).encode())
            except (BrokenPipeError,ConnectionResetError):pass
        def do_GET(self):
            if self.path.endswith('/instructions'):
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'text':'','revision':hashlib.sha256(b'').hexdigest(),'history':[]}).encode());return
            url=urllib.parse.urlparse(self.path);q=urllib.parse.parse_qs(url.query)
            assert self.headers.get('Authorization')==f'Bearer {TOKEN}'
            if url.path=='/api/v1/events':
                repo=q.get('repos',[''])[0];since=int(q.get('since',['0'])[0] or 0)
                until=time.monotonic()+.6
                while True:
                    with forge['lock']:page=forge['events'].get(repo,[])[since:]
                    if page or time.monotonic()>until:break
                    time.sleep(.05)
                return self.reply(200,{'events':page,'cursor':str(since+len(page))})
            if url.path=='/api/v1/repos/owner/demo/channel/messages':
                after=q.get('after',['0'])[0];forge['reads'].append(after)
                msgs=forge['messages'].get(after,[])
                return self.reply(200,{'messages':msgs,'cursor':after,'before':None,'after':None})
            self.reply(404,{'message':'not found'})
        def do_POST(self):
            url=urllib.parse.urlparse(self.path)
            assert self.headers.get('Authorization')==f'Bearer {TOKEN}'
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            forge['posts'].append({'path':url.path,**body})
            self.reply(201,{'cursor':'99','id':'n','created_at':iso(time.time()),'reply_to':None,'author':{'name':'owner/fixture','kind':'agent'},'kind':'message','body':body['body'],'link':None})
    api=http.server.ThreadingHTTPServer(('127.0.0.1',0),API);threading.Thread(target=api.serve_forever,daemon=True).start()
    origin=f'http://127.0.0.1:{api.server_port}'
    agent_file=home/'.config/gild/agents/fixture.json';agent_file.parent.mkdir(parents=True)
    agent_file.write_text(json.dumps({'schema':1,'name':'owner/fixture','server':origin,'token':TOKEN,'publicKey':'test-public','secretKey':'test-private','requestId':'test-request','createdAt':'2026-10-08T00:00:00Z'}));agent_file.chmod(0o600)
    work=home/'workspace';work.mkdir()
    def gild(*args):return subprocess.run(CLI+list(args),env=env,capture_output=True,timeout=15)
    # Profile rules through the CLI; a bad rule is refused with the grammar's message.
    bad=gild('agent','add','fixture','--runtime','claude','--dir',str(work),'--nudge','idle:soon')
    assert bad.returncode!=0 and b'Use a duration' in bad.stderr,bad
    ok=gild('agent','add','fixture','--runtime','claude','--dir',str(work),'--channel','owner/demo','--env','PATH','--env','HOME','--nudge','idle:1s:2','--nudge','waiting:1s','--nudge','mention-unanswered:2s')
    assert ok.returncode==0,ok
    saved=json.loads((home/'.gild/agents/fixture.json').read_text())
    assert saved['nudges']==['idle:1s:2','waiting:1s','mention-unanswered:2s'],saved
    path=home/'.gild/sessions/fixture.sock'
    class Run:
        def __init__(self,extra):
            self.m,self.s=pty.openpty();fcntl.ioctl(self.s,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
            self.proc=subprocess.Popen(CLI+['spawn',*extra,'agent','fixture'],stdin=self.s,stdout=self.s,stderr=self.s,env=env,cwd=ROOT,start_new_session=True)
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
                except (AssertionError,KeyError,FileNotFoundError,ConnectionRefusedError,json.JSONDecodeError,IndexError,TypeError):pass
            raise AssertionError((check,self.buf,self.events,forge['posts']))
        def hook(self,name,**extra):
            p=subprocess.run(CLI+['hook','--session','fixture'],input=json.dumps({'hook_event_name':name,**extra}).encode(),env=env,capture_output=True,timeout=5)
            assert p.returncode==0 and p.stdout==b'' and p.stderr==b''
        def lines(self):return [json.loads(l)['line'] for l in self.buf.splitlines() if l.startswith(b'{') and 'line' in json.loads(l)]
        def nudges(self):return [l for l in self.lines() if l.startswith('[gild] nudge:')]
        def nudge_events(self):return [e for e in (json.loads(l) for l in self.events.decode().splitlines()) if e.get('type')=='nudge']
        def rule(self,spec):return next(n for n in self.status()['nudges'] if n['rule']==spec)
        def subscribe(self):
            self.stream=socket.socket(socket.AF_UNIX);self.stream.connect(str(path));self.stream.sendall(b'{"type":"subscribe"}\n')
        def stop(self):
            if self.proc.poll() is None:
                self.proc.send_signal(signal.SIGTERM);assert self.proc.wait(timeout=8)==143
            if self.stream:self.stream.close()
            os.close(self.m);os.close(self.s)
    run=None
    try:
        # The per-session rule adds to the profile's; ci reads a repo outside the channels.
        run=Run(['--nudge','ci:owner/ci'])
        run.wait(lambda:b'"ready": true' in run.buf)
        # A draft goes into the composer before the 1s idle rule comes due.
        os.write(run.m,b'draft');run.read(.05)
        run.subscribe()
        run.wait(lambda:run.rule('idle:1s:2')['fired']==1)
        st=run.status()
        assert st['held']['reason'].startswith('unsent draft'),st
        assert [n['rule'] for n in st['nudges']]==['idle:1s:2','waiting:1s','mention-unanswered:2s','ci:owner/ci'],st
        assert st['nudges'][0]['limit']==2 and st['nudges'][0]['nextDue'] is None and st['nudges'][0]['lastFired'],st
        assert st['channels']==[{'repo':'owner/demo','state':'listening'}],st # the watched ci repo is not a channel
        run.read(.4);assert run.nudges()==[],run.lines()
        os.write(run.m,b'\x15')
        run.wait(lambda:len(run.nudges())==1)
        assert run.nudges()[0]=="[gild] nudge: idle 1s. Report status: what's done, what's blocked, and next step. If background work finished, read its results now.",run.nudges()
        run.wait(lambda:run.nudge_events()[0]['rule']=='idle:1s:2')
        e=run.nudge_events()[0];assert e['queued'] is True and e['session']=='fixture' and e['fired']==1,e
        # No system-note route on the server yet: a prefixed message from the agent identity.
        run.wait(lambda:forge['posts'][0]=={'path':'/api/v1/repos/owner/demo/channel/messages','body':'[gild nudge] idle 1s; asked the agent for a status report'})
        # The nudge's own turn re-arms the rule once more; the limit of 2 stops a third.
        run.wait(lambda:run.status()['state']=='busy')
        run.hook('Stop')
        run.wait(lambda:len(run.nudges())==2)
        run.hook('Stop');run.read(2.5)
        assert len(run.nudges())==2 and run.rule('idle:1s:2')['fired']==2,(run.lines(),run.status())
        # waiting: reported on the events stream and in status; never typed, never posted.
        posts=len(forge['posts']);lines=len(run.lines())
        run.hook('Notification',notification_type='permission_prompt',message='Allow Bash?')
        run.wait(lambda:run.status()['state']=='waiting')
        run.wait(lambda:run.rule('waiting:1s')['fired']==1)
        run.wait(lambda:any(e['rule']=='waiting:1s' for e in run.nudge_events()))
        assert next(e for e in run.nudge_events() if e['rule']=='waiting:1s')['queued'] is False
        run.read(.5);assert len(run.lines())==lines and len(forge['posts'])==posts,(run.lines(),forge['posts'])
        # ci: runs on another agent's branch never nudge; ours does, while idle.
        run.hook('Stop')
        run.wait(lambda:run.status()['state']=='idle')
        add('owner/ci','pull_request',{'action':'opened','pull_request':{'number':4,'user':{'login':'owner/fixture'},'head':{'ref':'fx/branch'}}})
        add('owner/ci','pull_request',{'action':'opened','pull_request':{'number':5,'user':{'login':'owner/other'},'head':{'ref':'other/branch'}}})
        run_event(11,'other/branch',actor='owner/other')
        run.read(1.5);assert not any('ci owner/ci' in l for l in run.lines()),run.lines()
        run_event(12,'fx/branch')
        run.wait(lambda:any('ci owner/ci' in l for l in run.nudges()))
        assert [l for l in run.nudges() if 'ci owner/ci' in l]==['[gild] nudge: ci owner/ci: workflow "CI" failure on fx/branch (run #12, http://forge/owner/ci/actions/12). Read the result and continue.'],run.nudges()
        run.wait(lambda:any(p['body'].startswith('[gild nudge] ci owner/ci:') and p['path'].endswith('/owner/demo/channel/messages') for p in forge['posts']))
        assert run.rule('ci:owner/ci')['fired']==1
        # mention-unanswered: no reply after message 20 → nudge; a reply after 30 → none.
        run.hook('Stop')
        forge['messages']['30']=[{'cursor':'31','id':'r31','created_at':iso(time.time()),'reply_to':'30','author':{'name':'owner/fixture','kind':'agent'},'kind':'message','body':'on it','link':None}]
        forge['messages']['20']=[{'cursor':'21','id':'n21','created_at':iso(time.time()),'reply_to':None,'author':{'name':'owner/fixture','kind':'agent'},'kind':'message','body':'[gild nudge] idle 1s; asked the agent for a status report','link':None}]
        mention(20,'@fixture where is the PR?')
        run.wait(lambda:any('mentioned you in owner/demo (message 20)' in l for l in run.lines()))
        run.hook('Stop')
        mention(30,'@fixture second question')
        run.wait(lambda:any('(message 30)' in l for l in run.lines()))
        run.hook('Stop')
        # Queued while the agent may still be busy; it is typed once the agent is idle.
        run.wait(lambda:run.rule('mention-unanswered:2s')['fired']==1,t=8)
        run.hook('Stop')
        run.wait(lambda:any('mention unanswered' in l for l in run.nudges()))
        run.read(2.5);run.hook('Stop');run.read(.5)
        unanswered=[l for l in run.nudges() if 'mention unanswered' in l]
        assert unanswered==['[gild] nudge: mention unanswered 2s. @sami in owner/demo (message 20) has no reply from you yet. Reply in the channel with your status.'],unanswered
        assert sorted(set(forge['reads']))==['20','30'],forge['reads']
        st=run.rule('mention-unanswered:2s');assert st['fired']==1 and st['nextDue'] is None,st
        assert TOKEN not in run.events.decode() and TOKEN not in json.dumps(run.status())
        # gild status (the CLI) shows the same rules.
        p=gild('status','fixture');assert p.returncode==0,p
        cli=json.loads(p.stdout);assert [(n['rule'],n['fired']) for n in cli['nudges']][1:]==[('waiting:1s',1),('mention-unanswered:2s',1),('ci:owner/ci',1)],cli['nudges']
        # The mentions were turns of the agent's own, so the idle limit started over.
        assert cli['nudges'][0]['fired']>2,cli['nudges']
        print(json.dumps({'passed':True}))
    finally:
        if run is not None:
            if run.proc.poll() is None:run.proc.terminate();run.proc.wait(timeout=8)
            try:os.close(run.m);os.close(run.s)
            except OSError:pass
        api.shutdown()
