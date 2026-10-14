import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { finishVmSync, guestEnvironment } from './spawn-vm'
import { loadHostConfig } from './isolation'
import { localRequest, socketPath } from './spawn-sessions'

for (const [mode, outcome] of [
  ['attached', 'failure'],
  ['detached', 'failure'],
  ['detached', 'partial'],
  ['detached', 'success'],
] as const) {
  test(`VM worker final result: ${mode} ${outcome} sync precedes exit and recovery delivery`, async () => {
    await mkdir('.tmp', { recursive: true })
    const home = await mkdtemp(resolve('.tmp/final-worker-'))
    // A configured vm (kernel and rootfs): the vz/Firecracker path, not Multipass.
    await writeFile(
      join(home, 'isolation.json'),
      JSON.stringify({
        vm: { kernel: '/fixture/kernel', rootfs: '/fixture/rootfs' },
      }),
    )
    const worker = join(home, 'worker.mjs')
    const built = await Bun.build({
      entrypoints: [resolve('src/spawn-worker.ts')],
      target: 'bun',
      outdir: home,
      naming: 'worker.mjs',
      banner:
        mode === 'attached'
          ? "Object.defineProperty(process.stdin,'isTTY',{value:true}); Object.defineProperty(process.stdout,'isTTY',{value:true}); process.stdin.setRawMode=()=>{};"
          : undefined,
      plugins: [
        {
          name: 'safe-vm-lifecycle-fixture',
          setup(build) {
            build.onResolve({ filter: /^\.\/spawn-vm$/ }, (args) =>
              args.importer.endsWith('spawn-worker.ts')
                ? { path: resolve('scripts/fixtures/vm-recovery-child.ts') }
                : undefined,
            )
          },
        },
      ],
    })
    expect(built.success, JSON.stringify(built.logs)).toBe(true)
    const command: string[] = JSON.parse(
      process.env.TEST_GILD_COMMAND ??
        JSON.stringify([process.execPath, 'run', resolve('src/gild.ts')]),
    )
    const id = 'final'
    const path = socketPath(id, join(home, '.gild/sessions'))
    const recovery = {
      directory: join(home, 'retained'),
      note: join(home, 'retained/recovery.json'),
    }
    const workerOptions = {
      agent: 'sh',
      args: [outcome],
      id,
      idleMs: 1000,
      ptyModule: '',
      hookCommand: command,
      vm: { configDir: home },
      ...(mode === 'detached' ? { detach: { cols: 80, rows: 24 } } : {}),
    }
    const env = { ...process.env, HOME: home }
    const proc = Bun.spawn(
      [process.execPath, worker, JSON.stringify(workerOptions)],
      {
        cwd: home,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const stderr = new Response(proc.stderr).text()
    const stdout = new Response(proc.stdout).text()
    let viewer: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
    let stop: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
    let viewerOutput: Promise<string> | undefined
    let events: ReturnType<typeof createConnection> | undefined
    try {
      const until = Date.now() + 5000
      for (;;) {
        try {
          await localRequest(path, { type: 'info' })
          break
        } catch {
          if (Date.now() >= until) throw Error('worker fixture did not start')
          await new Promise((done) => setTimeout(done, 20))
        }
      }
      if (mode === 'detached') {
        viewer = Bun.spawn([...command, 'attach', '--watch', id], {
          env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        viewerOutput = new Response(viewer.stdout).text()
        for (;;) {
          const info = await localRequest(path, { type: 'info' })
          if ('viewers' in info && info.viewers === 1) break
          if (Date.now() >= until) throw Error('viewer fixture did not attach')
          await new Promise((done) => setTimeout(done, 20))
        }
      }
      events = createConnection(path)
      await new Promise<void>((done, reject) => {
        events!.once('connect', done)
        events!.once('error', reject)
      })
      let lines = ''
      const finalEvent = new Promise<{ event: any; noteExists: boolean }>(
        (done, reject) => {
          events!.on('error', reject)
          events!.on('data', (chunk) => {
            lines += chunk.toString()
            for (const line of lines.trim().split('\n')) {
              try {
                const event = JSON.parse(line)
                if (event.type === 'exited')
                  done({ event, noteExists: existsSync(recovery.note) })
              } catch {}
            }
          })
          events!.on('close', () =>
            reject(Error('subscriber closed without final event')),
          )
        },
      )
      // If an earlier assertion fails, cleanup may close this subscriber first.
      // The awaited promise below still rejects on a premature close.
      void finalEvent.catch(() => {})
      events.write('{"type":"subscribe"}\n')
      stop = Bun.spawn([...command, 'stop', id], {
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const syncingUntil = Date.now() + 5000
      while (!existsSync(join(recovery.directory, 'sync-started'))) {
        if (Date.now() > syncingUntil)
          throw Error('fixture final sync did not start')
        await new Promise((done) => setTimeout(done, 10))
      }
      await expect(
        localRequest(path, { type: 'send', message: 'late input' }),
      ).rejects.toThrow('Session is finishing')
      await expect(localRequest(path, { type: 'sync' })).rejects.toThrow(
        'Session is finishing',
      )
      await writeFile(join(recovery.directory, 'release-sync'), '')
      const reply = JSON.parse(await new Response(stop.stdout).text())
      expect(await stop.exited).toBe(0)
      expect(await new Response(stop.stderr).text()).toBe('')
      const observed = await finalEvent
      expect(reply.code).toBe(outcome === 'success' ? 0 : 1)
      expect(observed.event.code).toBe(reply.code)
      expect(observed.noteExists).toBe(outcome !== 'success')
      expect(reply.recovery).toEqual(
        outcome === 'success' ? undefined : recovery,
      )
      expect(observed.event.recovery).toEqual(reply.recovery)
      expect(await proc.exited).toBe(reply.code)
      const errorText = await stderr
      await stdout
      if (outcome !== 'success') expect(errorText).toContain(recovery.directory)
      if (viewer) {
        expect(await viewer.exited).toBe(0)
        const text = await viewerOutput!
        if (outcome !== 'success') expect(text).toContain(recovery.directory)
        expect(await new Response(viewer.stderr).text()).toBe('')
      }
    } finally {
      events?.destroy()
      if (existsSync(recovery.directory))
        await writeFile(join(recovery.directory, 'release-sync'), '')
      if (proc.exitCode === null) {
        proc.kill()
        await proc.exited
      }
      if (viewer?.exitCode === null) {
        viewer.kill()
        await viewer.exited
      }
      if (stop?.exitCode === null) {
        stop.kill()
        await stop.exited
      }
      await rm(home, { recursive: true, force: true })
    }
  }, 20000)
}

test('failed final sync retains the VM workspace and reports failure', async () => {
  await mkdir('.tmp', { recursive: true })
  const dir = await mkdtemp(resolve('.tmp/vm-recovery-'))
  const closes: unknown[] = [],
    logs: string[] = []
  try {
    await writeFile(join(dir, 'workspace-fixture'), 'recoverable source\n')
    await expect(
      finishVmSync(
        async () => {
          throw new Error('guest unavailable')
        },
        {
          close: async (options) => {
            closes.push(options)
            if (!options?.preserveWorkspace) await rm(dir, { recursive: true })
          },
        },
        dir,
        (line) => logs.push(line),
      ),
    ).rejects.toThrow('guest unavailable')
    expect(closes).toEqual([{ preserveWorkspace: true }])
    expect(await Bun.file(join(dir, 'workspace-fixture')).text()).toBe(
      'recoverable source\n',
    )
    expect(await Bun.file(join(dir, 'recovery.json')).json()).toMatchObject({
      state: 'sync-incomplete',
      error: 'guest unavailable',
    })
    expect(logs[0]).toContain(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('partial final sync retains work; complete final sync cleans up', async () => {
  await mkdir('.tmp', { recursive: true })
  for (const partial of [true, false]) {
    const dir = await mkdtemp(resolve('.tmp/vm-final-'))
    const result = {
      written: ['src/a.ts'],
      deleted: [],
      conflicts: [],
      rejected: partial ? [{ path: '.git/HEAD', reason: 'protected' }] : [],
    }
    let preserve: boolean | undefined
    try {
      const completed = await finishVmSync(
        async () => result,
        {
          close: async (options) => {
            preserve = options?.preserveWorkspace
            if (!preserve) await rm(dir, { recursive: true })
          },
        },
        dir,
      )
      expect(completed).toMatchObject(result)
      expect(completed.recovery).toEqual(
        partial
          ? {
              directory: dir,
              note: join(dir, 'recovery.json'),
            }
          : undefined,
      )
      expect(preserve).toBe(partial)
      expect(await Bun.file(join(dir, 'recovery.json')).exists()).toBe(partial)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

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
