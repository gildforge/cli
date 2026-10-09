"""Trigger bridge end to end: fake forge + `gild spawn agent` alice (trigger) and bob (channel).

alice carries `--on issues.labeled:triage`; bob is a plain channel agent. Labeling
an issue wakes alice once; her unprompted `chat send "@bob ..."` wakes bob.
"""
import os,sys,pty,subprocess,pathlib,tempfile,json,socket,select,time,signal,fcntl,struct,http.server,threading,urllib.parse,termios,re,socketserver
ROOT=pathlib.Path(__file__).resolve().parents[2]
CLI=json.loads(os.environ['TEST_GILD_COMMAND'])
AGENTS={'fixture-token-alice':'owner/alice','fixture-token-bob':'owner/bob'}
class Server(http.server.ThreadingHTTPServer):
    def server_bind(self):
        # http.server.HTTPServer.server_bind resolves the host with socket.getfqdn,
        # a reverse DNS lookup that hangs where the resolver is slow; tests bind 127.0.0.1.
        socketserver.TCPServer.server_bind(self);self.server_name=self.server_address[0];self.server_port=self.server_address[1]
(ROOT/'.tmp').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=ROOT/'.tmp',prefix='trigger-') as d:
    home=pathlib.Path(d);bin=home/'bin';bin.mkdir();(bin/'claude').symlink_to(ROOT/'scripts/fixtures/events-agent.py')
    for p in [home/'.claude/settings.json']:p.parent.mkdir(parents=True,exist_ok=True);p.write_text('{"hooks":{}}')
    env={**os.environ,'HOME':d,'PATH':str(bin)+os.pathsep+os.environ['PATH']}
    forge={'events':[],'requests':[],'lock':threading.Lock()}
    def next_cursor():
        with forge['lock']:return str(len(forge['events'])+1)
    def issue(number,title,action='labeled',label=None,actor='sami',ident=None):
        payload={'action':action,'issue':{'number':number,'title':title,'labels':[{'name':label}] if label else [],'user':{'login':actor}},'sender':{'login':actor}}
        if label:payload['label']={'name':label}
        event={'id':ident or f'issues:{number}:{action}:{next_cursor()}','cursor':next_cursor(),'event':'issues','repository':'owner/demo','created_at':'2026-10-09T00:00:00Z','payload':payload}
        with forge['lock']:forge['events'].append(event)
    def mention(message_cursor,body,agent,author,kind='agent',mid=None):
        mid=mid or f'm{message_cursor}'
        message={'cursor':str(message_cursor),'id':mid,'created_at':'2026-10-09T00:00:00Z','reply_to':None,'author':{'name':author,'kind':kind},'kind':'message','body':body,'link':None}
        with forge['lock']:
            n=len(forge['events'])+1
            forge['events'].append({'id':f'mention:{mid}:{agent}','cursor':str(n),'event':'channel.mention','repository':'owner/demo','created_at':'2026-10-09T00:00:00Z','payload':{'repository':{'full_name':'owner/demo'},'message':message,'author':message['author'],'agent':agent,'history_cursor':str(message_cursor)}})
        return message
    class API(http.server.BaseHTTPRequestHandler):
        def log_message(self,*a):pass
        def address_string(self):return self.client_address[0]
        def do_GET(self):
            url=urllib.parse.urlparse(self.path);q=urllib.parse.parse_qs(url.query)
            assert url.path=='/api/v1/events',url.path
            if self.headers.get('Authorization') not in [f'Bearer {t}' for t in AGENTS]:
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
            except (BrokenPipeError,ConnectionResetError):pass
        def do_POST(self):
            url=urllib.parse.urlparse(self.path)
            assert url.path=='/api/v1/repos/owner/demo/channel/messages',url.path
            name=AGENTS.get((self.headers.get('Authorization') or '')[7:])
            assert name,name
            body=json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)))
            with forge['lock']:
                cursor=str(len(forge['events'])+1)
                message={'cursor':cursor,'id':f'id{cursor}','created_at':'2026-10-09T00:00:00Z','reply_to':body.get('reply_to'),'author':{'name':name,'kind':'agent'},'kind':'message','body':body['body'],'link':None}
            for match in re.finditer(r'@([A-Za-z0-9_-]+)',body['body']):
                if f'owner/{match[1]}' in AGENTS.values():
                    mention(cursor,body['body'],f'owner/{match[1]}',name,mid=f'm{cursor}-{match[1]}')
            self.send_response(201);self.send_header('Content-Type','application/json');self.end_headers()
            self.wfile.write(json.dumps(message).encode())
    api=Server(('127.0.0.1',0),API);threading.Thread(target=api.serve_forever,daemon=True).start()
    origin=f'http://127.0.0.1:{api.server_port}'
    for label,token in [('alice','fixture-token-alice'),('bob','fixture-token-bob')]:
        agent_file=home/f'.config/gild/agents/{label}.json';agent_file.parent.mkdir(parents=True,exist_ok=True)
        agent_file.write_text(json.dumps({'schema':1,'name':f'owner/{label}','server':origin,'token':token,'publicKey':'test-public','secretKey':'test-private','requestId':'test-request','createdAt':'2026-10-08T00:00:00Z'}));agent_file.chmod(0o600)
    for label,profile in [('alice',{'name':'alice','runtime':'claude','directory':str(home/'work-alice'),'args':[],'channels':['owner/demo'],'on':['issues.labeled:triage'],'env':['PATH','HOME']}),('bob',{'name':'bob','runtime':'claude','directory':str(home/'work-bob'),'args':[],'channels':['owner/demo'],'env':['PATH','HOME']})]:
        pathlib.Path(profile['directory']).mkdir()
        profile_file=home/f'.gild/agents/{label}.json';profile_file.parent.mkdir(parents=True,exist_ok=True)
        profile_file.write_text(json.dumps(profile))
    class Run:
        def __init__(self,label):
            self.label=label;self.path=home/f'.gild/sessions/{label}.sock'
            self.m,self.s=pty.openpty();fcntl.ioctl(self.s,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
            self.proc=subprocess.Popen(CLI+['spawn','agent',label],stdin=self.s,stdout=self.s,stderr=self.s,env=env,cwd=ROOT,start_new_session=True)
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
                c.connect(str(self.path));c.sendall(json.dumps(body).encode()+b'\n');return c.recv(65536)
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
            p=subprocess.run(CLI+['hook','--session',self.label],input=json.dumps({'hook_event_name':name,**extra}).encode(),env=env,capture_output=True,timeout=3)
            assert p.returncode==0 and p.stdout==b'' and p.stderr==b''
        def lines(self):return [json.loads(l)['line'] for l in self.buf.splitlines() if l.startswith(b'{') and 'line' in json.loads(l)]
        def prompts(self):return [l for l in self.lines() if '[gild]' in l]
        def stages(self,kind,mid=None):
            out=[]
            for l in self.events.decode().splitlines():
                e=json.loads(l)
                if e.get('type')==kind and (mid is None or e['id']==mid):out.append((e['id'],e['stage']))
            return out
        def subscribe(self):
            self.stream=socket.socket(socket.AF_UNIX);self.stream.connect(str(self.path));self.stream.sendall(b'{"type":"subscribe"}\n')
        def stop(self):
            if self.proc.poll() is None:
                self.proc.send_signal(signal.SIGTERM);assert self.proc.wait(timeout=8)==143
            if self.stream:self.stream.close()
            os.close(self.m);os.close(self.s)
    alice=bob=None
    try:
        alice=Run('alice');alice.wait(lambda:b'"ready": true' in alice.buf);alice.wait(lambda:alice.status()['state']=='idle')
        bob=Run('bob');bob.wait(lambda:b'"ready": true' in bob.buf);bob.wait(lambda:bob.status()['state']=='idle')
        alice.wait(lambda:alice.status()['channels']==[{'repo':'owner/demo','state':'listening'}])
        bob.wait(lambda:bob.status()['channels']==[{'repo':'owner/demo','state':'listening'}])
        alice.subscribe();bob.subscribe()
        issue(12,'Triage me',label='triage')
        alice.wait(lambda:len(alice.prompts())==1)
        first=alice.prompts()[0]
        assert '[gild] issue #12 "Triage me" labeled triage in owner/demo by sami' in first,first
        context=re.search(r'Read:  (.+) issue view owner/demo#12',first)
        post=re.search(r'Post:  (.+) chat send owner/demo --agent alice',first)
        assert context and post and context[1]==post[1] and context[1]!='gild' and 'gild' in context[1],first
        # A non-matching label and a duplicate of the delivered event add nothing.
        issue(13,'Not it',label='wontfix')
        issue(12,'Triage me',label='triage',ident='issues:12:labeled:1')
        alice.read(.8)
        assert len(alice.prompts())==1,alice.prompts()
        assert [s for _,s in alice.stages('trigger','issues:12:labeled:1')]==['received','queued','delivered'],alice.events.decode()
        assert alice.stages('trigger','issues:13:labeled:2')==[],alice.events.decode()
        assert bob.prompts()==[],bob.prompts()
        saved=json.loads(pathlib.Path(home/'.gild/sessions/alice.mentions.json').read_text())
        assert saved['delivered']==['trigger:issues:12:labeled:1'] and saved['cursors']['owner/demo']==str(len(forge['events'])),saved
        # Restart: the persisted cursor and delivered ids stop any replay.
        alice.hook('Stop');alice.stop();alice=None
        forge['requests'].clear()
        alice=Run('alice');alice.wait(lambda:b'"ready": true' in alice.buf)
        alice.wait(lambda:alice.status()['channels'][0]['state']=='listening')
        assert forge['requests'][0]['since']==str(len(forge['events'])),forge['requests'][:2]
        alice.read(.6);assert alice.prompts()==[],alice.prompts()
        # Alice's unprompted post hands off to bob, whose bridge types the mention.
        p=subprocess.run(CLI+['chat','send','owner/demo','@bob take this','--agent','alice'],env=env,capture_output=True,timeout=8)
        assert p.returncode==0 and p.stderr==b'',p.stderr
        bob.wait(lambda:len(bob.prompts())==1)
        handoff=bob.prompts()[0]
        assert '@owner/alice mentioned you in owner/demo' in handoff and 'take this' in handoff,handoff
        alice.read(.5)
        assert alice.prompts()==[],alice.prompts() # the mention was bob's, nothing replays
        assert [s for _,s in bob.stages('mention','m4-bob')]==['received','queued','delivered'],bob.events.decode()
        print(json.dumps({'passed':True}))
    finally:
        for run in [alice,bob]:
            if run is not None:
                if run.proc.poll() is None:run.proc.terminate();run.proc.wait(timeout=8)
                try:os.close(run.m);os.close(run.s)
                except OSError:pass
        api.shutdown()
