"""gild spawn --vm --detach: an orchestrator-style VM child with no terminal.

spawn returns the id; send, sync, attach --watch and stop work on it; the
guest's last changes reach the host when it is stopped. Needs a Firecracker
host (isolation.json with `vm`) and a guest image with python3.
  TEST_GILD_COMMAND='["bun","run","src/gild.ts"]' TEST_VM_CONFIG_DIR=<dir> python3 vm-detach-harness.py
"""
import os, subprocess, pathlib, tempfile, json, time, socket

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = json.loads(os.environ['TEST_GILD_COMMAND'])
CONFIG = os.environ['TEST_VM_CONFIG_DIR']

with tempfile.TemporaryDirectory(dir=ROOT / '.tmp', prefix='vmdetach-') as d:
    home = pathlib.Path(d)
    bindir = home / 'bin'; bindir.mkdir()
    (bindir / 'sync-agent').symlink_to(ROOT / 'scripts/fixtures/sync-agent.py')
    project = home / 'project'; project.mkdir()
    for name, text in {'marker.txt': 'host\n', 'gone.txt': 'bye\n', 'run.sh': '#!/bin/sh\necho hi\n', 'both.txt': 'original\n'}.items():
        (project / name).write_text(text)
    env = {**os.environ, 'HOME': d, 'PATH': str(bindir) + os.pathsep + os.environ['PATH']}
    sock = home / '.gild/sessions/vmd.sock'

    def gild(*args, ok=True, cwd=None):
        p = subprocess.run(CLI + list(args), env=env, capture_output=True, timeout=60, cwd=cwd or project,
                           stdin=subprocess.DEVNULL)
        assert not ok or p.returncode == 0, (args, p.returncode, p.stdout, p.stderr)
        return p

    def output_log():
        logs = list((home / '.gild/sessions').glob('**/output.log'))
        return logs[0].read_bytes() if logs else b''

    def wait(check, what, timeout=30):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if check(): return
            time.sleep(.1)
        raise AssertionError((what, output_log()))

    t0 = time.monotonic()
    # No terminal at all: stdin is /dev/null and stdout a pipe, as for an orchestrator.
    started = gild('spawn', '--vm', '--detach', '--config-dir', CONFIG, '--name', 'vmd', '--idle-ms', '100', 'sync-agent')
    started_s = time.monotonic() - t0
    try:
        assert started.stdout.decode().strip() == 'vmd', started
        wait(lambda: b'"ready": true' in output_log(), 'agent ready in the guest')
        ready = next(json.loads(l) for l in output_log().splitlines() if l.startswith(b'{') and b'"ready"' in l)
        assert ready['cwd'] == '/workspace', ready  # it runs in the guest, not on the host
        with socket.socket(socket.AF_UNIX) as c:
            c.connect(str(sock)); c.sendall(b'{"type":"info"}\n')
            info = json.loads(c.recv(65536))
        assert info['childPid'] == -1 and info['detached'] is True, info

        (project / 'both.txt').write_text('host version\n')
        gild('send', 'vmd', 'round1')
        wait(lambda: b'"done": "round1"' in output_log(), 'round1 done')
        assert not (project / 'new.txt').exists()
        out = gild('sync', 'vmd').stdout.decode()
        assert 'both.txt' in out, out
        assert (project / 'new.txt').read_text() == 'created in the guest\n'
        assert (project / 'marker.txt').read_text() == 'edited in the guest\n'
        assert not (project / 'gone.txt').exists()
        assert (project / 'both.txt').read_text() == 'host version\n'

        # A watcher sees the replayed output without a terminal.
        watch = subprocess.Popen(CLI + ['attach', '--watch', 'vmd'], env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=project)
        time.sleep(1.5); watch.terminate(); wout, _ = watch.communicate(timeout=5)
        assert b'"done": "round1"' in wout, wout

        # Work after the on-demand sync comes back when the session is stopped.
        gild('send', 'vmd', 'round2')
        wait(lambda: b'"done": "round2"' in output_log(), 'round2 done')
        assert not (project / 'later.txt').exists()
        gild('stop', 'vmd')
        wait(lambda: not sock.exists(), 'session gone after stop')
        wait(lambda: (project / 'later.txt').exists(), 'final sync at stop', 15)
        assert (project / 'later.txt').read_text() == 'written after the on-demand sync\n'
        print(json.dumps({'passed': True, 'spawn_returned_s': round(started_s, 2)}))
    finally:
        if sock.exists():
            subprocess.run(CLI + ['stop', 'vmd'], env=env, capture_output=True, timeout=30)
