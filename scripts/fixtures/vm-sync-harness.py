"""gild spawn --vm working-directory sync: on demand (`gild sync`) and at exit.

Needs a Firecracker host (isolation.json with `vm`) and a guest image with
python3. Fixture agent only.
  TEST_GILD_COMMAND='["bun","run","src/gild.ts"]' TEST_VM_CONFIG_DIR=<dir> python3 vm-sync-harness.py
"""
import os, pty, subprocess, pathlib, tempfile, json, select, time, fcntl, struct, termios

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = json.loads(os.environ['TEST_GILD_COMMAND'])
CONFIG = os.environ['TEST_VM_CONFIG_DIR']


def drain_wait(proc, master, timeout):
    """Wait for exit while reading the pty: on macOS a session leader's exit
    blocks until its terminal output is drained, so a bare wait() deadlocks."""
    out = b''
    until = time.monotonic() + timeout
    while proc.poll() is None:
        if time.monotonic() > until: raise subprocess.TimeoutExpired(proc.args, timeout)
        if select.select([master], [], [], .05)[0]:
            try: out += os.read(master, 65536)
            except OSError: time.sleep(.05)
    return proc.returncode, out

with tempfile.TemporaryDirectory(dir=ROOT / '.tmp', prefix='vmsync-') as d:
    home = pathlib.Path(d)
    bindir = home / 'bin'; bindir.mkdir()
    (bindir / 'sync-agent').symlink_to(ROOT / 'scripts/fixtures/sync-agent.py')
    project = home / 'project'; project.mkdir()
    for name, text in {'marker.txt': 'host\n', 'gone.txt': 'bye\n', 'run.sh': '#!/bin/sh\necho hi\n', 'both.txt': 'original\n'}.items():
        (project / name).write_text(text)
    (project / 'run.sh').chmod(0o644)
    env = {**os.environ, 'HOME': d, 'PATH': str(bindir) + os.pathsep + os.environ['PATH']}
    m, s = pty.openpty()
    fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    proc = subprocess.Popen(CLI + ['spawn', '--vm', '--config-dir', CONFIG, '--name', 'vmsync', '--idle-ms', '100', 'sync-agent'],
                            stdin=s, stdout=s, stderr=s, env=env, cwd=project, start_new_session=True)
    buf = b''

    def wait(text, timeout=30):
        global buf
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if select.select([m], [], [], .05)[0]:
                try: buf += os.read(m, 65536)
                except OSError: break
            if text in buf: return
        raise AssertionError(buf)

    def gild(*args):
        p = subprocess.run(CLI + list(args), env=env, capture_output=True, timeout=60)
        assert p.returncode == 0, (args, p.stdout, p.stderr)
        return p.stdout.decode()

    try:
        wait(b'"ready": true')
        # The host edits a file the guest will also edit: a conflict, the host copy wins.
        (project / 'both.txt').write_text('host version\n')
        gild('send', 'vmsync', 'round1')
        wait(b'"done": "round1"')
        # The guest works on a copy: nothing reached the host yet.
        assert not (project / 'new.txt').exists()
        assert (project / 'marker.txt').read_text() == 'host\n'

        t0 = time.monotonic()
        out = gild('sync', 'vmsync')
        sync_s = time.monotonic() - t0
        assert 'conflicts' in out and 'both.txt' in out, out
        assert (project / 'new.txt').read_text() == 'created in the guest\n'
        assert (project / 'marker.txt').read_text() == 'edited in the guest\n'
        assert not (project / 'gone.txt').exists()
        assert (project / 'sub/dir/deep.txt').read_text() == 'nested\n'
        assert (project / 'run.sh').stat().st_mode & 0o777 == 0o755
        assert os.readlink(project / 'link') == 'marker.txt'
        assert (project / 'both.txt').read_text() == 'host version\n'
        saved = pathlib.Path(out.split('guest copy: ')[1].split()[0])
        assert saved.read_text() == 'guest version\n' and not str(saved).startswith(str(project))
        # A second sync with no new guest changes carries nothing.
        again = gild('sync', 'vmsync')
        assert again.startswith('vmsync: 0 written, 0 deleted, 0 conflicts'), again

        # Changes after the on-demand sync arrive when the agent exits.
        gild('send', 'vmsync', 'round2')
        wait(b'"done": "round2"')
        assert not (project / 'later.txt').exists()
        gild('send', 'vmsync', 'quit')
        code, tail = drain_wait(proc, m, 30); buf += tail
        assert code == 0, buf
        if b'synced from the VM' not in buf: wait(b'synced from the VM', 5)
        assert (project / 'later.txt').read_text() == 'written after the on-demand sync\n'
        print(json.dumps({'passed': True, 'sync_s': round(sync_s, 3)}))
    finally:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired: proc.kill()
        os.close(m); os.close(s)
