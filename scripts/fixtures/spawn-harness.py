"""Drive gild through a real outer PTY, without opening terminal windows."""
import errno, fcntl, json, os, pathlib, pty, select, signal, socket, struct, subprocess, sys, tempfile, termios, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = json.loads(os.environ['TEST_GILD_COMMAND'])
CASE = sys.argv[1]

class Session:
    def __init__(self, mode='lines', idle=150, name='test', extra=None, stale=False):
        self.home = tempfile.TemporaryDirectory(dir=ROOT / '.tmp', prefix='s-')
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        attrs = termios.tcgetattr(self.slave)
        attrs[1] &= ~termios.OPOST
        termios.tcsetattr(self.slave, termios.TCSANOW, attrs)
        self.original = termios.tcgetattr(self.slave)
        self.env = {**os.environ, 'HOME': self.home.name, 'CLAUDE_CODE_SESSION_ID': 'fixture-session', 'CLAUDE_CODE_MESSAGING_TOKEN': 'fixture-session-marker', 'CLAUDECODE': 'outer', 'CLAUDE_PID': '123', 'CLAUDE_EFFORT': 'high', 'CLAUDE_CODE_CHILD_SESSION': 'outer', 'CLAUDE_CODE_OAUTH_TOKEN': 'fixture-config', 'CLAUDE_CODE_USE_BEDROCK': '1', 'CODEX_SESSION_ID': 'outer', 'CODEX_THREAD_ID': 'outer', 'KEEP_TEST': 'kept', 'CLAUDE_OTHER': 'kept', 'CODEX_OTHER': 'kept'}
        command = CLI + ['spawn', '--name', name, '--idle-ms', str(idle), str(ROOT / 'scripts/fixtures/spawn-agent.py'), mode]
        if stale:
            path = pathlib.Path(self.home.name)/'.gild/sessions'/ (name+'.sock')
            path.parent.mkdir(parents=True)
            old = socket.socket(socket.AF_UNIX); old.bind(str(path)); old.close()
        self.proc = subprocess.Popen(command, stdin=self.slave, stdout=self.slave, stderr=self.slave, cwd=ROOT, env=self.env, start_new_session=True)
        self.buffer = b''
        self.events = []
        self.path = pathlib.Path(self.home.name) / '.gild/sessions' / (name + '.sock')
        try: self.ready = self.wait_event('ready')
        except BaseException: self.close(); raise
    def read(self, duration=0.05):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], max(0, deadline - time.monotonic()))[0]:
                try: data = os.read(self.master, 65536)
                except OSError as e:
                    if e.errno == errno.EIO: break
                    raise
                if not data: break
                self.buffer += data
            else: break
        self.parse()
    def parse(self):
        # Agent messages are JSON lines; preserve the full byte stream for byte assertions.
        for line in self.buffer.splitlines():
            try: event = json.loads(line)
            except (ValueError, UnicodeDecodeError): continue
            if event not in self.events: self.events.append(event)
    def wait_event(self, key, value=None, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read()
            for event in self.events:
                if key in event and (value is None or event[key] == value): return event
            if self.proc.poll() is not None: break
        raise AssertionError(f'{key}={value!r} missing; gild status={self.proc.poll()}, stream={self.buffer!r}')
    def cli(self, *args, stdin=None):
        return subprocess.run(CLI + list(args), cwd=ROOT, env=self.env, input=stdin, capture_output=True, timeout=10)
    def send(self, text, stdin=False):
        result = self.cli('send', 'test', '-' if stdin else text, stdin=text.encode() if stdin else None)
        assert result.returncode == 0, result.stderr
    def wait_exit(self, timeout=8):
        deadline = time.monotonic() + timeout
        while self.proc.poll() is None and time.monotonic() < deadline: self.read()
        return self.proc.wait(timeout=1)
    def stop(self, sig=signal.SIGTERM, expected=143):
        self.proc.send_signal(sig)
        assert self.wait_exit() == expected
        assert termios.tcgetattr(self.slave) == self.original, 'terminal not restored'
        assert not self.path.exists(), 'socket survived'
    def close(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try: self.wait_exit()
            except subprocess.TimeoutExpired: self.proc.kill(); self.proc.wait()
        # Mutant checks deliberately disable cleanup. Reap only our fixture PIDs.
        for event in self.events:
            for key in ('job', 'pid'):
                pid = event.get(key)
                if pid:
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
        os.close(self.master); os.close(self.slave)
        self.home.cleanup()

def gone(pid):
    try: os.kill(pid, 0); return False
    except ProcessLookupError: return True

s = None
try:
    if CASE == 'bytes':
        s = Session('bytes')
        payload = bytes([0, 1, 3, 9, 10, 13, 27, 127, 128, 255]) + '🦊'.encode()
        os.write(s.master, payload)
        assert s.wait_exit() == 37
        s.read(0.1)
        assert s.buffer.endswith(payload), s.buffer
        assert termios.tcgetattr(s.slave) == s.original
        assert not s.path.exists()
    elif CASE == 'backpressure':
        s = Session('flood')
        # Deliberately stop reading the outer PTY while terminal output fills it.
        time.sleep(.2)
        result=s.cli('status','test')
        assert result.returncode==0,result.stderr
        assert json.loads(result.stdout)['state']=='unknown'
        s.send('socket remains responsive')
        s.stop()
    elif CASE == 'resize':
        s = Session()
        s.wait_event('size', [80, 24])
        fcntl.ioctl(s.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 31, 93, 0, 0))
        s.proc.send_signal(signal.SIGWINCH)
        s.wait_event('size', [93, 31])
    elif CASE == 'exit':
        s = Session()
        os.write(s.master, b'quit\r')
        assert s.wait_exit() == 23
        assert termios.tcgetattr(s.slave) == s.original
        assert not s.path.exists()
    elif CASE in ('send', 'paste', 'idle', 'sanitize'):
        s = Session(idle=2500 if CASE == 'idle' else 150)
        if CASE == 'send':
            s.send('hello')
            s.wait_event('line', 'hello')
        elif CASE == 'paste':
            s.send('first\nsecond\n', stdin=True)
            s.wait_event('line', '\x1b[200~first\nsecond\n\x1b[201~')
            assert len([e for e in s.events if 'line' in e]) == 1
        elif CASE == 'sanitize':
            s.send('safe\x1b[201~\x03\x7f\x85\t\nnext')
            s.wait_event('line', '\x1b[200~safe[201~\t\nnext\x1b[201~')
        else:
            os.write(s.master, b'user')
            s.send('hello')
            s.read(0.25)
            assert not any('line' in e for e in s.events), s.events
            os.write(s.master, b'\r')
            s.wait_event('line', 'user')
            s.read(0.25)
            assert not any(e.get('line') == 'hello' for e in s.events), s.events
            s.wait_event('line', 'hello')
    elif CASE == 'stale-start':
        s = Session(stale=True)
        s.send('reclaimed'); s.wait_event('line', 'reclaimed')
    elif CASE == 'env':
        s = Session()
        markers = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID']
        assert not any(k in s.ready['env'] for k in markers), s.ready
        assert all(s.ready['env'][k] == 'kept' for k in ['KEEP_TEST', 'CLAUDE_OTHER', 'CODEX_OTHER']), s.ready
        assert s.ready['env']['CLAUDE_EFFORT'] == 'high'
        assert s.ready['env']['CLAUDE_CODE_OAUTH_TOKEN'] == 'fixture-config'
        assert s.ready['env']['CLAUDE_CODE_USE_BEDROCK'] == '1'
        assert s.ready['term'] == 'xterm-256color'
    elif CASE in ('kill', 'hangup', 'parent-death'):
        s = Session('jobs')
        job = s.wait_event('job')['job']
        child = s.ready['pid']
        s.stop(sig=signal.SIGHUP if CASE == 'hangup' else signal.SIGKILL if CASE == 'parent-death' else signal.SIGTERM, expected=129 if CASE == 'hangup' else -9 if CASE == 'parent-death' else 143) if CASE != 'parent-death' else s.proc.kill()
        if CASE == 'parent-death': s.proc.wait(timeout=8)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not (gone(child) and gone(job)): time.sleep(0.05)
        assert gone(child) and gone(job), f'PTY process group survived: child={child}, job={job}'
        assert termios.tcgetattr(s.slave) == s.original, 'terminal not restored'
        assert not s.path.exists()
    elif CASE == 'startup-failure':
        s = Session()
        cm, cs = pty.openpty()
        saved = termios.tcgetattr(cs)
        failure = subprocess.Popen(CLI + ['spawn', '--name', 'bad', '/gild-fixture-no-such-agent'], stdin=cs, stdout=cs, stderr=cs, cwd=ROOT, env=s.env, start_new_session=True)
        deadline = time.monotonic() + 8
        try:
            while failure.poll() is None and time.monotonic() < deadline:
                if select.select([cm], [], [], 0.1)[0]: os.read(cm, 65536)
            assert failure.wait(timeout=1) != 0
            assert termios.tcgetattr(cs) == saved
            assert not (s.path.parent / 'bad.sock').exists()
        finally:
            if failure.poll() is None: failure.kill(); failure.wait()
            os.close(cm); os.close(cs)
    elif CASE == 'fifo':
        s = Session(idle=1200)
        s.send('first'); s.send('second')
        s.wait_event('line', 'second')
        assert [e['line'] for e in s.events if 'line' in e] == ['first', 'second']
    elif CASE == 'terminal':
        s = Session()
        s.proc.send_signal(signal.SIGTERM)
        deadline = time.monotonic() + 3
        while s.path.exists() and time.monotonic() < deadline: time.sleep(0.002)
        assert not s.path.exists()
        assert s.proc.poll() is None, 'check must precede the runtime exit reset'
        assert termios.tcgetattr(s.slave) == s.original, 'terminal not restored during cleanup'
        assert s.wait_exit() == 143
    elif CASE == 'ctrl-c':
        s = Session('ctrl-c')
        os.write(s.master, b'\x03')
        assert s.wait_exit() == 130
        assert termios.tcgetattr(s.slave) == s.original
    elif CASE == 'sessions':
        s = Session()
        assert s.path.stat().st_mode & 0o777 == 0o600
        assert s.path.parent.stat().st_mode & 0o777 == 0o700
        result = s.cli('sessions', '--json')
        assert result.returncode == 0, result.stderr
        info = json.loads(result.stdout)
        assert info[0]['state'] == 'unknown'
        assert len(info) == 1 and info[0]['id'] == 'test' and info[0]['cwd'] == str(ROOT) and info[0]['childPid'] == s.ready['pid'] and info[0]['pid'] > 0 and info[0]['started']
        cm, cs = pty.openpty()
        saved = termios.tcgetattr(cs)
        collision = subprocess.Popen(CLI + ['spawn', '--name', 'test', str(ROOT / 'scripts/fixtures/spawn-agent.py')], stdin=cs, stdout=cs, stderr=cs, cwd=ROOT, env=s.env, start_new_session=True)
        collision_stream = b''
        deadline = time.monotonic() + 8
        try:
            while collision.poll() is None and time.monotonic() < deadline:
                if select.select([cm], [], [], 0.1)[0]: collision_stream += os.read(cm, 65536)
            assert collision.wait(timeout=1) == 1
            assert b'already exists' in collision_stream, collision_stream
            assert termios.tcgetattr(cs) == saved
        finally:
            if collision.poll() is None: collision.kill(); collision.wait()
            os.close(cm); os.close(cs)
        s.send('still alive'); s.wait_event('line', 'still alive')
        stale_path = s.path.parent / 'stale.sock'
        stale = socket.socket(socket.AF_UNIX); stale.bind(str(stale_path)); stale.close()
        result = s.cli('sessions', '--json')
        assert result.returncode == 0 and not stale_path.exists()
    else: raise AssertionError('Unknown case ' + CASE)
    print(json.dumps({'case': CASE, 'passed': True}))
finally:
    if s: s.close()
