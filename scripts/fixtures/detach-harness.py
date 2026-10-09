"""Drive `gild spawn --detach`, `gild attach` and `gild stop` the way an
orchestrator agent does: no terminal for spawn/send/status/stop, a real (pty)
terminal only for an interactive attach. Headless; fixture agents only."""
import errno, fcntl, json, os, pathlib, pty, select, socket, struct, subprocess, sys, tempfile, termios, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = json.loads(os.environ['TEST_GILD_COMMAND'])
CASE = sys.argv[1]
AGENT = ROOT / 'scripts/fixtures/detach-agent.py'

home = tempfile.TemporaryDirectory(dir=ROOT / '.tmp', prefix='d-')
HOME = pathlib.Path(home.name)
BIN = HOME / 'bin'; BIN.mkdir()
for name in ['claude', 'plain']: (BIN / name).symlink_to(AGENT)
# Claude settings the fixture must never touch (the adapter adds a plugin dir).
(HOME / '.claude').mkdir(); (HOME / '.claude/settings.json').write_text('{"hooks":{}}')
ENV = {**os.environ, 'HOME': home.name, 'PATH': str(BIN) + os.pathsep + os.environ['PATH']}
SESSIONS = HOME / '.gild/sessions'
started = []  # worker pids this harness started, killed by PID on failure

def cli(*args, stdin=b'', timeout=10):
    return subprocess.run(CLI + list(args), input=stdin, capture_output=True, env=ENV, cwd=ROOT, timeout=timeout)

def spawn(name, agent='claude', *extra, args=()):
    """`gild spawn --detach` from a Bash-tool-like caller: stdin /dev/null,
    stdout and stderr pipes. communicate() needs EOF on both pipes."""
    t = time.monotonic()
    proc = subprocess.Popen(CLI + ['spawn', '--detach', '--name', name, *extra, agent, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV, cwd=ROOT)
    try: out, err = proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill(); raise AssertionError('spawn --detach held the caller pipes open')
    elapsed = time.monotonic() - t
    assert proc.returncode == 0 and err == b'', (proc.returncode, err)
    assert out == (name + '\n').encode(), out
    started.append(status(name)['pid'])
    return elapsed

def status(name):
    r = cli('status', name); assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)

def wait(check, timeout=8, what='condition'):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value: return value
        time.sleep(.05)
    raise AssertionError(f'timed out waiting for {what}')

def log(name):
    path = SESSIONS / name / 'output.log'
    return path.read_bytes() if path.exists() else b''

def lines(data):
    out = []
    for line in data.replace(b'\r', b'').split(b'\n'):
        try: out.append(json.loads(line))
        except ValueError: pass
    return out

def subscribe(name):
    s = socket.socket(socket.AF_UNIX); s.connect(str(SESSIONS / f'{name}.sock'))
    s.sendall(b'{"type":"subscribe"}\n'); s.setblocking(False)
    return s

class Stream:
    """Accumulates bytes from an fd (pty master or pipe) without blocking."""
    def __init__(self, fd): self.fd = fd; self.data = b''; self.eof = False
    def read(self, duration=.05):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if not select.select([self.fd], [], [], max(0, deadline - time.monotonic()))[0]: break
            try: chunk = os.read(self.fd, 65536) if isinstance(self.fd, int) else self.fd.recv(65536)
            except OSError as e:
                if e.errno == errno.EIO: self.eof = True; break
                if e.errno == errno.EAGAIN: break
                raise
            if not chunk: self.eof = True; break
            self.data += chunk
        return self.data
    def wait(self, needle, timeout=8):
        wait(lambda: needle in self.read(), timeout, f'{needle!r} in {self.data[-400:]!r}')

def attach(name, *extra, cols=100, rows=30, keep=False):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    proc = subprocess.Popen(CLI + ['attach', *extra, name], stdin=slave, stdout=slave, stderr=slave, env=ENV, cwd=ROOT, start_new_session=True)
    # macOS drops unread pty output once the last slave fd closes: keep one
    # open when the output of a short-lived attach is asserted.
    if keep: return proc, master, Stream(master), slave
    os.close(slave)
    return proc, master, Stream(master)

def gone(pid):
    try: os.kill(pid, 0); return False
    except ProcessLookupError: return True

def check(condition, message):
    if not condition: raise AssertionError(message)

try:
    if CASE == 'no-tty':
        elapsed = spawn('quick')
        check(elapsed < 2, f'spawn --detach took {elapsed:.2f}s')
        info = wait(lambda: (s := status('quick'))['state'] == 'idle' and s, what='idle')
        check(info['detached'] is True and info['viewers'] == 0, info)
        check((info['cols'], info['rows']) == (120, 40), info)
        check(os.getsid(info['pid']) == info['pid'], 'worker is not a session leader')
        wait(lambda: b'"size": [120, 40]' in log('quick'), what='size in log')
        path = SESSIONS / 'quick/output.log'
        check(path.stat().st_mode & 0o777 == 0o600, oct(path.stat().st_mode))
        check(b'"ready": true' in log('quick'), log('quick'))
        listed = json.loads(cli('sessions', '--json').stdout)
        check([s['id'] for s in listed] == ['quick'], listed)
        # A no-adapter agent at a chosen size.
        spawn('sized', 'plain', '--cols', '90', '--rows', '20')
        wait(lambda: b'"size": [90, 20]' in log('sized'), what='custom size')
        check(status('sized')['detached'] is True, 'sized')
    elif CASE == 'send':
        spawn('worker')
        wait(lambda: status('worker')['state'] == 'idle', what='idle')
        events = Stream(subscribe('worker'))
        r = cli('send', 'worker', 'hello from the orchestrator')
        check(r.returncode == 0 and r.stdout == b'queued for worker\n', r)
        def states():
            seen = []
            for e in lines(events.read()):
                if e.get('raw', {}).get('source') != 'snapshot' and (not seen or seen[-1] != e['type']): seen.append(e['type'])
            return seen
        wait(lambda: states() == ['busy', 'idle'], what=f'busy then idle in {events.data!r}')
        wait(lambda: b'"line": "hello from the orchestrator"' in log('worker'), what='delivered line')
    elif CASE == 'attach':
        spawn('pair')
        wait(lambda: status('pair')['state'] == 'idle', what='idle')
        check(cli('send', 'pair', 'before anyone looked').returncode == 0, 'send')
        wait(lambda: b'"line": "before anyone looked"' in log('pair'), what='unwatched output')
        viewer, master, screen, slave = attach('pair', keep=True)
        # Ring replay: output from before the attach, from the very first byte.
        screen.wait(b'"ready": true'); screen.wait(b'"line": "before anyone looked"')
        # The agent now runs at the viewer's size (live output after the replay).
        screen.wait(b'"size": [100, 30]')
        info = status('pair'); check(info['viewers'] == 1 and info['interactive'] is True, info)
        # A read-only watcher may join; a second interactive viewer may not.
        watcher = subprocess.Popen(CLI + ['attach', '--watch', 'pair'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV, cwd=ROOT)
        os.set_blocking(watcher.stdout.fileno(), False)
        watched = Stream(watcher.stdout.fileno())
        watched.wait(b'"line": "before anyone looked"')
        second, second_master, second_screen, second_slave = attach('pair', keep=True)
        check(second.wait(timeout=8) == 1, 'second interactive viewer was admitted')
        second_screen.wait(b'Another viewer is attached interactively')
        os.close(second_master); os.close(second_slave)
        check(status('pair')['viewers'] == 2, status('pair'))
        # Keystrokes reach the agent through the session's input path.
        os.write(master, b'typed by a human\r')
        screen.wait(b'"line": "typed by a human"')
        watched.wait(b'"line": "typed by a human"')
        wait(lambda: status('pair')['state'] == 'idle', what='idle after typing')
        # A draft typed through attach still holds an injected message.
        os.write(master, b'half a thought')
        time.sleep(.3)
        check(cli('send', 'pair', 'queued behind the draft').returncode == 0, 'send')
        time.sleep(.6)
        held = status('pair').get('held') or {}
        check('unsent draft' in held.get('reason', ''), held)
        check(b'queued behind the draft' not in log('pair'), 'injected over a draft')
        os.write(master, b'\x15')  # Ctrl-U clears the draft
        screen.wait(b'"line": "queued behind the draft"')
        # Ctrl-] detaches; the agent keeps running at the fixed size again.
        os.write(master, b'\x1d')
        check(viewer.wait(timeout=5) == 0, 'attach did not exit 0 on Ctrl-]')
        screen.wait(b'detached from pair')
        os.close(slave)
        info = wait(lambda: (s := status('pair'))['viewers'] == 1 and s, what='viewer gone')
        check(info['interactive'] is False and not gone(info['childPid']), info)
        wait(lambda: lines(log('pair').split(b'"line": "queued behind the draft"')[-1]).count({'size': [120, 40]}) >= 1, what='fixed size restored')
        check(cli('send', 'pair', 'still alive').returncode == 0, 'send after detach')
        wait(lambda: b'"line": "still alive"' in log('pair'), what='alive after detach')
        watcher.terminate(); watcher.wait(timeout=5)
        os.close(master)
        # Interactive attach needs a terminal; an agent without one is told so.
        r = cli('attach', 'pair')
        check(r.returncode == 1 and b'--watch' in r.stderr, r)
    elif CASE == 'stop':
        spawn('leaving')
        wait(lambda: status('leaving')['state'] == 'idle', what='idle')
        info = status('leaving')
        events = Stream(subscribe('leaving'))
        r = cli('stop', 'leaving')
        check(r.returncode == 0, r)
        final = json.loads(r.stdout)
        check(final['type'] == 'exited' and final['code'] == 129 and final['session'] == 'leaving', final)
        # The exit is the last event on the stream, and then the stream ends.
        wait(lambda: (events.read(), events.eof)[1], what='events EOF')
        check(lines(events.data)[-1]['type'] == 'exited' and lines(events.data)[-1]['code'] == 129, events.data)
        check(not (SESSIONS / 'leaving.sock').exists(), 'socket left behind')
        check(not (SESSIONS / 'leaving').exists(), 'settings directory left behind')
        wait(lambda: gone(info['pid']) and gone(info['childPid']), what='processes gone')
        check(json.loads(cli('sessions', '--json').stdout) == [], 'still listed')
        # No adapter, and an agent that ignores the hangup: SIGKILL after the grace.
        spawn('stubborn', 'plain', args=['stubborn'])
        wait(lambda: b'"ready": true' in log('stubborn'), what='stubborn ready')
        t = time.monotonic()
        r = cli('stop', '--grace-ms', '300', 'stubborn')
        check(r.returncode == 0 and json.loads(r.stdout)['code'] == 137, r)
        check(time.monotonic() - t < 2, f'stop escalated late ({time.monotonic() - t:.2f}s)')
        check(not (SESSIONS / 'stubborn').exists() and not (SESSIONS / 'stubborn.sock').exists(), 'stubborn left files')
        r = cli('stop', 'stubborn')
        check(r.returncode == 1 and b'No live session stubborn' in r.stderr, r)
    else:
        raise SystemExit(f'unknown case {CASE}')
    print(json.dumps({'case': CASE, 'passed': True}))
finally:
    # Also any session whose spawn failed before its pid was recorded.
    for path in SESSIONS.glob('*.sock') if SESSIONS.exists() else []:
        try:
            with socket.socket(socket.AF_UNIX) as c:
                c.settimeout(2); c.connect(str(path)); c.sendall(b'{"type":"info"}\n')
                started.append(json.loads(c.recv(65536))['pid'])
        except (OSError, ValueError, KeyError): pass
    for pid in started:
        try: os.kill(pid, 15)
        except ProcessLookupError: pass
    time.sleep(.3)
    home.cleanup()
