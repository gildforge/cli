import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { OutputLog, OutputRing } from './spawn-detach'

test('the output ring keeps only the most recent bytes, in order', () => {
  const ring = new OutputRing(10)
  ring.push(Buffer.from('abcdef'))
  ring.push(Buffer.from('ghijkl'))
  expect(ring.snapshot().toString()).toBe('cdefghijkl')
  ring.push(Buffer.from('0123456789XYZ'))
  expect(ring.snapshot().toString()).toBe('3456789XYZ')
})

test('the output log is private, capped and rotated once', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(resolve('.tmp/log-'))
  try {
    const path = join(root, 'output.log')
    const log = new OutputLog(path, 100)
    log.write(Buffer.alloc(60, 'a'))
    log.write(Buffer.alloc(60, 'b'))
    expect((await readFile(path + '.1')).toString()).toBe('a'.repeat(60))
    expect((await readFile(path)).toString()).toBe('b'.repeat(60))
    log.write(Buffer.alloc(60, 'c'))
    expect((await readFile(path + '.1')).toString()).toBe('b'.repeat(60))
    expect((await readFile(path)).toString()).toBe('c'.repeat(60))
    // One write larger than the cap keeps its tail.
    log.write(Buffer.from('x'.repeat(150) + 'y'.repeat(50)))
    expect((await readFile(path)).toString()).toBe(
      'x'.repeat(50) + 'y'.repeat(50),
    )
    for (const file of [path, path + '.1'])
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    log.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const scenario of ['no-tty', 'send', 'attach', 'stop']) {
  test(`detached session: ${scenario}`, async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const command =
      process.env.TEST_GILD_COMMAND ??
      JSON.stringify([process.execPath, 'run', resolve('src/gild.ts')])
    const proc = Bun.spawn(
      ['python3', resolve('scripts/fixtures/detach-harness.py'), scenario],
      {
        env: { ...process.env, TEST_GILD_COMMAND: command },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const timer = setTimeout(() => proc.kill(), 50000)
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
  }, 55000)
}
