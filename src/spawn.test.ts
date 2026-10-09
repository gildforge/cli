import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

const cases = [
  'bytes',
  'resize',
  'exit',
  'send',
  'paste',
  'idle',
  'sanitize',
  'env',
  'stale-start',
  'kill',
  'hangup',
  'parent-death',
  'ctrl-c',
  'sessions',
  'terminal',
  'startup-failure',
  'fifo',
]
for (const scenario of cases) {
  test(`spawn PTY: ${scenario}`, async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const command =
      process.env.TEST_GILD_COMMAND ??
      JSON.stringify([process.execPath, 'run', resolve('src/gild.ts')])
    const proc = Bun.spawn(
      ['python3', resolve('scripts/fixtures/spawn-harness.py'), scenario],
      {
        env: { ...process.env, TEST_GILD_COMMAND: command },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const timer = setTimeout(() => proc.kill(), 20000)
    try {
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect({ code, err }).toEqual({ code: 0, err: '' })
      expect(JSON.parse(out)).toEqual({ case: scenario, passed: true })
    } finally {
      clearTimeout(timer)
    }
  }, 25000)
}
