"""Real Claude Code TUI against a deterministic local Messages API; no credentials or windows."""
import http.server,threading,json,os,pathlib,tempfile,subprocess,sys,pty,select,time,socket,signal,fcntl,struct,termios,hashlib,socketserver
ROOT=pathlib.Path(__file__).resolve().parents[2];CLI=json.loads(os.environ['TEST_GILD_COMMAND'])
class Server(http.server.ThreadingHTTPServer):
    def server_bind(self):
        # http.server.HTTPServer.server_bind resolves the host with socket.getfqdn,
        # a reverse DNS lookup that hangs where the resolver is slow; tests bind 127.0.0.1.
        socketserver.TCPServer.server_bind(self);self.server_name=self.server_address[0];self.server_port=self.server_address[1]
class API(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a):pass
    def address_string(self):return self.client_address[0]
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'{}')
        tool_done=any(any(b.get('type')=='tool_result' for b in m.get('content',[]) if isinstance(b,dict)) for m in body.get('messages',[]) if isinstance(m.get('content'),list))
        content=[{'type':'text','text':'fixture done'}] if tool_done else [{'type':'tool_use','id':'toolu_fixture','name':'Bash','input':{'command':"python3 -c \"print('live-fixture')\"",'description':'Print fixture'}}]
        message={'id':'msg_fixture','type':'message','role':'assistant','content':content,'model':'claude-sonnet-4-6','stop_reason':'end_turn' if tool_done else 'tool_use','stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':1}}
        if body.get('stream'):
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            events=[('message_start',{'type':'message_start','message':{**message,'content':[],'stop_reason':None}})]
            for i,c in enumerate(content):
                initial={**c, 'text':''} if c['type']=='text' else {**c,'input':{}}
                events.append(('content_block_start',{'type':'content_block_start','index':i,'content_block':initial}))
                delta={'type':'text_delta','text':c['text']} if c['type']=='text' else {'type':'input_json_delta','partial_json':json.dumps(c['input'])}
                events.append(('content_block_delta',{'type':'content_block_delta','index':i,'delta':delta}))
                events.append(('content_block_stop',{'type':'content_block_stop','index':i}))
            events.extend([('message_delta',{'type':'message_delta','delta':{'stop_reason':message['stop_reason'],'stop_sequence':None},'usage':{'output_tokens':1}}),('message_stop',{'type':'message_stop'})])
            for e,d in events:self.wfile.write(f'event: {e}\ndata: {json.dumps(d)}\n\n'.encode());self.wfile.flush()
        else:self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(message).encode())
server=Server(('127.0.0.1',0),API);threading.Thread(target=server.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory(dir=ROOT/'.tmp',prefix='live-') as tmp:
    d=pathlib.Path(tmp);config=d/'config';config.mkdir();project=d/'project';(project/'.claude').mkdir(parents=True)
    rec=ROOT/'scripts/fixtures/record-hook.py';record=d/'native.jsonl'
    settings=[]
    for source,p in [('user',config/'settings.json'),('project',project/'.claude/settings.json'),('local',project/'.claude/settings.local.json')]:
        hooks={n:[{'hooks':[{'type':'command','command':f"python3 '{rec}' '{source}' '{record}'"}]}] for n in ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Notification','PermissionRequest','Stop']}
        p.write_text(json.dumps({'hooks':hooks}));settings.append(p)
    (config/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'theme':'dark','customApiKeyResponses':{'approved':['fixture-not-a-secret'],'rejected':[]},'projects':{str(project):{'hasTrustDialogAccepted':True}}}))
    repeated = '--repeat-settings' in sys.argv
    explicit = '--explicit-settings' in sys.argv or repeated
    extra_args = []
    if explicit:
        extra = d/'extra.json'
        extra.write_text(json.dumps({'hooks':{n:[{'hooks':[{'type':'command','command':f"python3 '{rec}' 'extra' '{record}'"}]}] for n in ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Notification','PermissionRequest','Stop']},'theme':'dark'}))
        settings.append(extra);extra_args=['--settings',str(extra)]
        if repeated:
            first=d/'first.json';first.write_text(extra.read_text().replace("'extra'","'first'"))
            settings.append(first);extra_args=['--settings',str(first)]+extra_args
    before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in settings]
    original=pathlib.Path.home()/'.claude/settings.json';actual_before=hashlib.sha256(original.read_bytes()).hexdigest() if original.exists() else None
    env={**{k:v for k,v in os.environ.items() if k in ('PATH','TERM','LANG','USER','SHELL','TMPDIR')},'HOME':str(d),'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','CLAUDE_CONFIG_DIR':str(config),'ANTHROPIC_API_KEY':'fixture-not-a-secret','ANTHROPIC_BASE_URL':f'http://127.0.0.1:{server.server_port}'}
    env.pop('CLAUDECODE',None)
    # All runtime files and credentials are isolated fixture data in this worktree.
    name='live-'+str(os.getpid());path=d/'.gild/sessions'/f'{name}.sock'
    m,s=pty.openpty();fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
    proc=subprocess.Popen(CLI+['spawn','--name',name,'claude','--permission-mode','manual','--model','sonnet','--no-chrome']+extra_args,cwd=project,env=env,stdin=s,stdout=s,stderr=s,start_new_session=True)
    raw=b'';events=[];stream=None;accepted=False;prompted=False;approved=False;sent=False;statuses=set();waiting_since=None;started=time.monotonic()
    def info():
        with socket.socket(socket.AF_UNIX) as c:
            c.connect(str(path));c.sendall(b'{"type":"info"}\n');return json.loads(c.recv(65536))
    try:
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            if stream is None and path.exists():
                stream=socket.socket(socket.AF_UNIX);stream.connect(str(path));stream.sendall(b'{"type":"subscribe"}\n');stream.setblocking(False)
            ready=select.select([m]+([stream] if stream else []),[],[],.1)[0]
            if m in ready:
                raw+=os.read(m,65536)
                text=raw.decode(errors='replace')
                if not accepted and ('trust this folder' in text.lower() or 'trust this directory' in text.lower() or 'Yes, I trust' in text):os.write(m,b'\r');accepted=True;raw=b''
                if not prompted and any(e['type']=='busy' for e in events) and time.monotonic()-started>4:
                    os.write(m,b'Use Bash to print live-fixture, then say done.');time.sleep(.15);os.write(m,b'\r');prompted=True
            if stream and stream in ready:
                data=stream.recv(65536)
                for line in data.splitlines():
                    try:
                        event=json.loads(line)
                        if 'type' in event:events.append(event)
                    except:pass
            if events and not statuses:
                statuses.add(info()['state'])
            if any(e['type']=='tool_start' for e in events) and 'tool_start' not in statuses:
                statuses.add(info()['state'])
            if any(e['type']=='tool_start' for e in events) and not sent:
                queued=subprocess.run(CLI+['send',name,'Reply exactly QUEUED'],env=env,capture_output=True,timeout=5)
                assert queued.returncode==0 and not queued.stdout and not queued.stderr,(queued.returncode,queued.stderr.decode())
                sent=True
            if any(e['type']=='waiting' for e in events) and not approved and waiting_since is None:
                waiting_since=time.monotonic()
            if waiting_since is not None and time.monotonic()-waiting_since>7 and not approved:
                observed=subprocess.run(CLI+['status',name],env=env,capture_output=True,timeout=5)
                assert observed.returncode==0,observed.stderr
                assert json.loads(observed.stdout)['state']=='waiting'
                statuses.add('waiting')
                time.sleep(.7);os.write(m,b'\r');approved=True
            if approved and any(e['type']=='idle' for e in events) and record.exists():
                rows=[json.loads(l) for l in record.read_text().splitlines()]
                received=any(r['payload'].get('prompt')=='Reply exactly QUEUED' for r in rows)
                stop_count=sum(r['payload']['hook_event_name']=='Stop' for r in rows)
                sources={json.loads(l)['source'] for l in record.read_text().splitlines() if json.loads(l)['payload']['hook_event_name']=='Stop'}
                if received and stop_count >= (8 if explicit else 6) and sources==({'user','project','local','extra'} if explicit else {'user','project','local'}):
                    observed=subprocess.run(CLI+['status',name],env=env,capture_output=True,timeout=5)
                    assert observed.returncode==0 and json.loads(observed.stdout)['state']=='idle',observed.stderr
                    statuses.add('idle');break
        (ROOT/'.tmp/live-terminal.txt').write_bytes(raw)
        (ROOT/'.tmp/live-events.jsonl').write_text('\n'.join(json.dumps(e) for e in events)+'\n')
        if record.exists():
            # Persist actual payload shapes with only fixture-local data; normalize paths/session IDs.
            rows=[]
            for line in record.read_text().splitlines():
                row=json.loads(line);p=row['payload'];p['session_id']='recorded-session';p['transcript_path']='/fixture/transcript.jsonl';p['cwd']='/fixture/project';rows.append(row)
            (ROOT/'scripts/evidence/claude-hooks.jsonl').write_text('\n'.join(json.dumps(r) for r in rows)+'\n')
        if repeated: assert not any(r['source']=='first' for r in rows), 'Earlier CLI settings were unexpectedly retained'
        assert received, 'Queued prompt was not submitted by the native TUI'
        assert any(e['type']=='busy' for e in events),[e['type'] for e in events]
        assert any(e['type']=='waiting' for e in events),[e['type'] for e in events]
        assert any(e['type']=='tool_start' for e in events),[e['type'] for e in events]
        assert any(e['type']=='tool_end' for e in events),[e['type'] for e in events]
        assert any(e['type']=='idle' for e in events),[e['type'] for e in events]
        assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in settings]==before
        assert (hashlib.sha256(original.read_bytes()).hexdigest() if original.exists() else None)==actual_before
        print(json.dumps({'passed':True,'version':subprocess.check_output(['claude','--version'],text=True).strip(),'sequence':[e['type'] for e in events],'settings_hashes':before,'observed_statuses':sorted(statuses),'queued_prompt_submitted':received,'real_user_settings_unchanged':True,'explicit_settings':explicit,'repeated_settings':repeated}))
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            until=time.monotonic()+8
            while proc.poll() is None and time.monotonic()<until:
                if select.select([m],[],[],.1)[0]:os.read(m,65536)
            if proc.poll() is None:proc.kill()
            proc.wait(timeout=2)
        assert not path.exists()
        assert not path.with_suffix('').exists()
        if stream:stream.close()
        os.close(m);os.close(s)
server.shutdown()
