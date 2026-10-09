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
