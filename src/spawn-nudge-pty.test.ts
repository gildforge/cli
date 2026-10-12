import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

const command = () =>
  process.env.TEST_GILD_COMMAND
    ? (JSON.parse(process.env.TEST_GILD_COMMAND) as string[])
    : [process.execPath, 'run', resolve('src/gild.ts')]
test('watchdog nudges through a PTY session: idle, draft, waiting, ci, mention-unanswered, status, events', async () => {
  const proc = Bun.spawn(
    ['python3', resolve('scripts/fixtures/nudge-harness.py')],
    {
      env: { ...process.env, TEST_GILD_COMMAND: JSON.stringify(command()) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const timer = setTimeout(() => proc.kill('SIGTERM'), 80000)
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(JSON.parse(out).passed).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}, 90000)

test('watchdog fixture preserves primary failure, reports shutdown timeout and retires its exact owned PID', async () => {
  const code = `
import sys,subprocess,time,json
sys.path.insert(0,${JSON.stringify(resolve('scripts/fixtures'))})
from nudge_cleanup import stop_owned
p=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("ready",flush=True);time.sleep(60)'],stdout=subprocess.PIPE,text=True)
assert p.stdout.readline().strip()=='ready'
primary=None
try:
    try:raise AssertionError('original effect assertion')
    except BaseException as error:primary=error;raise
    finally:stop_owned(p,lambda t:time.sleep(t),primary)
except AssertionError as error:
    assert error is primary and str(error)=='original effect assertion'
    assert any('TimeoutExpired' in note for note in error.__notes__),error.__notes__
    assert p.poll() is not None
    print(json.dumps({'primaryPreserved':True,'timeoutReported':True,'ownedPidStopped':True}))
finally:
    if p.poll() is None:p.kill();p.wait(timeout=2)
`
  const child = Bun.spawn(['python3', '-c', code], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const [exit, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exit, error }).toEqual({ exit: 0, error: '' })
  expect(JSON.parse(output)).toEqual({
    primaryPreserved: true,
    timeoutReported: true,
    ownedPidStopped: true,
  })
}, 15000)
