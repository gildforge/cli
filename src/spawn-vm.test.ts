import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { guestEnvironment } from './spawn-vm'
import { loadHostConfig } from './isolation'

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

test('spawn --vm --detach starts the VM worker (no TTY needed) and reports why a VM could not start', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const home = await mkdtemp(resolve('.tmp/vm-detach-'))
  try {
    const config = join(home, 'config')
    await mkdir(config)
    // The owner's own (missing) image: nothing is fetched, the worker reports why.
    await writeFile(
      join(config, 'isolation.json'),
      JSON.stringify({
        vm: { kernel: '/nope/vmlinux', rootfs: '/nope/rootfs' },
      }),
    )
    const command: string[] = JSON.parse(
      process.env.TEST_GILD_COMMAND ??
        JSON.stringify([process.execPath, 'run', resolve('src/gild.ts')]),
    )
    const proc = Bun.spawn(
      [
        ...command,
        'spawn',
        '--vm',
        '--detach',
        '--config-dir',
        config,
        '--name',
        'vmdetach',
        'sh',
      ],
      {
        cwd: home,
        env: { ...process.env, HOME: home },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    // The detached worker got as far as booting a VM, and its reason came back.
    expect(err).toMatch(
      /--vm failed: --vm needs a working (Firecracker|vz) setup/,
    )
    expect({ code, out }).toEqual({ code: 1, out: '' })
    // Nothing ran on the host instead, and no session was left behind.
    const sessions = await readdir(join(home, '.gild/sessions')).catch(() => [])
    expect(sessions.filter((f) => f.startsWith('vmdetach'))).toEqual([])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

// Needs a Firecracker host and a guest image with python3 (see FINDINGS.md).
const config = process.env.TEST_VM_CONFIG_DIR
async function harness(script: string) {
  const proc = Bun.spawn(['python3', resolve(script)], {
    env: {
      ...process.env,
      TEST_GILD_COMMAND: JSON.stringify(['bun', 'run', resolve('src/gild.ts')]),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect({ code, err }).toEqual({ code: 0, err: '' })
  expect(JSON.parse(out).passed).toBe(true)
}

test.skipIf(!config)(
  'spawn --vm: guest changes reach the host on `gild sync` and at exit; a both-sides edit keeps the host copy',
  () => harness('scripts/fixtures/vm-sync-harness.py'),
  120_000,
)

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

test.skipIf(!config)(
  'spawn --vm --detach: an orchestrator child in a microVM; send, sync, watch and stop, changes back at stop',
  () => harness('scripts/fixtures/vm-detach-harness.py'),
  120_000,
)

// A rootfs whose guest agent predates the handshake (e.g. the 0.6.0 spike image).
const oldRootfs = process.env.TEST_VM_OLD_ROOTFS
test.skipIf(!config || !oldRootfs)(
  'spawn --vm against an outdated guest image fails at connect time with the rebuild command',
  async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const home = await mkdtemp(resolve('.tmp/vm-old-'))
    try {
      // The working kernel and settings, with only the rootfs swapped for the old one.
      const { vm } = await loadHostConfig(config!)
      await Bun.write(
        join(home, 'isolation.json'),
        JSON.stringify({ vm: { ...vm, rootfs: oldRootfs } }),
      )
      const proc = Bun.spawn(
        [
          'bun',
          'run',
          resolve('src/gild.ts'),
          'spawn',
          '--vm',
          '--detach',
          '--config-dir',
          home,
          '--name',
          'vmold',
          'sh',
        ],
        {
          cwd: home,
          env: { ...process.env, HOME: home },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, err] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ])
      expect(code).toBe(1)
      expect(err).toContain(`The guest image ${oldRootfs} is outdated`)
      expect(err).toContain('speaks protocol 1, this gild needs 2')
      expect(err).toContain('bun run vm:image')
    } finally {
      // Should the session have started anyway (no handshake), stop its VM.
      await Bun.spawn(['bun', 'run', resolve('src/gild.ts'), 'stop', 'vmold'], {
        env: { ...process.env, HOME: home },
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited
      await rm(home, { recursive: true, force: true })
    }
  },
  60_000,
)
