import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { guestEnvironment } from './spawn-vm'

test('guest env: a fixed baseline, plus only adapter additions and allowlisted names; never the host env', () => {
  const baseline = {
    PATH: '/host/bin',
    HOME: '/Users/me',
    HOST_SECRET: 's3',
    KEEP_ME: 'k',
    TERM: 'xterm',
  }
  const adapted = { ...baseline, CLAUDE_CONFIG_DIR: '/x', KEEP_ME: 'k' }
  const env = guestEnvironment(adapted, baseline, ['KEEP_ME'])
  expect(env.PATH).toBe(
    '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  )
  expect(env.HOME).toBe('/root')
  expect(env.CLAUDE_CONFIG_DIR).toBe('/x') // added by the adapter
  expect(env.KEEP_ME).toBe('k') // allowlisted
  expect(env.HOST_SECRET).toBeUndefined()
  expect(guestEnvironment(adapted, baseline).KEEP_ME).toBeUndefined()
})

// Needs a Firecracker host and a guest image with python3 (see FINDINGS.md).
const config = process.env.TEST_VM_CONFIG_DIR
test.skipIf(!config)(
  'spawn --vm: fixture agent in a microVM with send, events, input, hooks and resize',
  async () => {
    const proc = Bun.spawn(
      ['python3', resolve('scripts/fixtures/vm-spawn-harness.py')],
      {
        env: {
          ...process.env,
          TEST_GILD_COMMAND: JSON.stringify([
            'bun',
            'run',
            resolve('src/gild.ts'),
          ]),
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
    expect(JSON.parse(out).passed).toBe(true)
  },
  120_000,
)
