"""gild spawn --vm with the fixture agent, driven through a real outer PTY.

Needs a Firecracker host (isolation.json with `vm`) and a guest image with
python3. Never starts a real claude or codex.
  TEST_GILD_COMMAND='["bun","run","src/gild.ts"]' TEST_VM_CONFIG_DIR=<dir> python3 vm-spawn-harness.py
"""
import os, sys, pty, subprocess, pathlib, tempfile, json, socket, select, time, signal, fcntl, struct, termios, shutil

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = json.loads(os.environ['TEST_GILD_COMMAND'])
CONFIG = os.environ['TEST_VM_CONFIG_DIR']

with tempfile.TemporaryDirectory(dir=ROOT / '.tmp', prefix='vm-') as d:
    home = pathlib.Path(d)
    bindir = home / 'bin'; bindir.mkdir()
    (bindir / 'claude').symlink_to(ROOT / 'scripts/fixtures/events-agent.py')
    project = home / 'project'; project.mkdir()
    (project / 'marker.txt').write_text('host project file\n')
    env = {**os.environ, 'HOME': d, 'PATH': str(bindir) + os.pathsep + os.environ['PATH'],
           'KEEP_HOSTSECRET': 'must-not-reach-the-guest'}
    m, s = pty.openpty()
    fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    t0 = time.monotonic()
    proc = subprocess.Popen(CLI + ['spawn', '--vm', '--config-dir', CONFIG, '--name', 'vmevents', '--idle-ms', '150', 'claude'],
                            stdin=s, stdout=s, stderr=s, env=env, cwd=project, start_new_session=True)
    sock = home / '.gild/sessions/vmevents.sock'
    buf = b''

    def read(t=.1):
        global buf
        until = time.monotonic() + t
        while time.monotonic() < until:
            if select.select([m], [], [], max(0, until - time.monotonic()))[0]:
                try: buf += os.read(m, 65536)
                except OSError: break
            else: break

    def request(body):
        with socket.socket(socket.AF_UNIX) as c:
            c.connect(str(sock)); c.sendall(json.dumps(body).encode() + b'\n'); return c.recv(65536)

    def status(): return json.loads(request({'type': 'info'}))

    def wait(check, timeout=20):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            read(.05)
            if check(): return
        raise AssertionError(buf)

    def lines():
        return [json.loads(l)['line'] for l in buf.splitlines() if l.startswith(b'{') and b'"line"' in l]

    try:
        wait(lambda: b'"ready": true' in buf)
        ready_after = time.monotonic() - t0
        ready = next(json.loads(l) for l in buf.splitlines() if l.startswith(b'{') and b'"ready"' in l)
        # The agent really runs in the guest: its cwd is the copied project, the host env did not follow it.
        assert ready['cwd'] == '/workspace', ready
        assert ready['env'] == {}, ready
        assert 'must-not-reach-the-guest' not in buf.decode(errors='replace')
        assert (project / 'marker.txt').exists()
        # SessionStart runs inside the guest and arrives over vsock: unknown -> idle.
        wait(lambda: status()['state'] == 'idle')
        info = status()
        assert info['childPid'] == -1, info

        # gild send reaches the agent through the host queue and the pty bridge; the agent's own
        # hook command (inside the guest) comes back over vsock and moves the session state.
        stream = socket.socket(socket.AF_UNIX); stream.connect(str(sock)); stream.sendall(b'{"type":"subscribe"}\n')
        sent = subprocess.run(CLI + ['send', 'vmevents', 'hello from the host'], env=env, capture_output=True, timeout=10)
        assert sent.returncode == 0, sent.stderr
        wait(lambda: lines() == ['hello from the host'])
        wait(lambda: status()['state'] == 'busy')

        # gild events <id> shows the hook-derived events.
        ev = subprocess.Popen(CLI + ['events', 'vmevents'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(1.0)
        ev.terminate(); out, err = ev.communicate(timeout=5)
        stream.settimeout(2)
        events = [json.loads(e)['type'] for e in stream.recv(65536).decode().splitlines()]
        assert events, (events, out, err)

        # Typing in the outer terminal reaches the agent, and a resize reaches the guest pty.
        os.write(m, b'typed by a person\r')
        wait(lambda: 'typed by a person' in lines())

        # Turn ends (Stop), then the queue may deliver again.
        stop = subprocess.run(CLI + ['hook', '--session', 'vmevents'], input=json.dumps({'hook_event_name': 'Stop'}).encode(), env=env, capture_output=True, timeout=5)
        assert stop.returncode == 0, stop.stderr
        wait(lambda: status()['state'] == 'idle')
        # Clean shutdown: the agent quits, gild exits 0, the session socket is gone.
        subprocess.run(CLI + ['send', 'vmevents', 'quit'], env=env, capture_output=True, timeout=10)
        assert proc.wait(timeout=20) == 0, buf
        assert not sock.exists()
        # Resize: a second session whose agent reports its pty size.
        (bindir / 'size-agent').symlink_to(ROOT / 'scripts/fixtures/size-agent.py')
        m2, s2 = pty.openpty()
        fcntl.ioctl(s2, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        p2 = subprocess.Popen(CLI + ['spawn', '--vm', '--config-dir', CONFIG, '--name', 'vmsize', 'size-agent'],
                              stdin=s2, stdout=s2, stderr=s2, env=env, cwd=project, start_new_session=True)
        buf2 = b''
        def wait2(text, timeout=20):
            global buf2
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                if select.select([m2], [], [], .05)[0]:
                    try: buf2 += os.read(m2, 65536)
                    except OSError: break
                if text in buf2: return
            raise AssertionError(buf2)
        try:
            wait2(b'"size": [24, 80]')
            fcntl.ioctl(s2, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
            p2.send_signal(signal.SIGWINCH)
            wait2(b'"size": [40, 120]')
            os.write(m2, b'q')
            assert p2.wait(timeout=20) == 0
        finally:
            if p2.poll() is None: p2.terminate(); p2.wait(timeout=8)
            os.close(m2); os.close(s2)
        print(json.dumps({'passed': True, 'ready_s': round(ready_after, 2), 'events': events}))
    finally:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired: proc.kill()
        os.close(m); os.close(s)
