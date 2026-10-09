import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

for (const scenario of [
  'native-env',
  'native-interrupt',
  'no-node',
  'no-addon',
  'pty-failure',
  'windows',
]) {
  test(`spawn regression: ${scenario}`, async () => {
    await mkdir('.tmp', { recursive: true })
    const worker = resolve('.tmp/regression-worker.mjs')
    const build = Bun.spawnSync([
      process.execPath,
      'build',
      'src/spawn-worker.ts',
      '--target=node',
      '--format=esm',
      '--outfile',
      worker,
    ])
    expect(build.exitCode).toBe(0)
    const proc = Bun.spawn(
      ['python3', 'scripts/fixtures/spawn-regressions.py', scenario],
      {
        env: {
          ...process.env,
          TEST_GILD_COMMAND:
            process.env.TEST_GILD_COMMAND ??
            JSON.stringify([process.execPath, 'run', resolve('src/gild.ts')]),
          TEST_NODE: Bun.which('node')!,
          TEST_WORKER: worker,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(JSON.parse(out)).toEqual({ case: scenario, passed: true })
  }, 15000)
}
