import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'

test('persistent owner main dispatches real HOST work, retains results, cancels and denies foreign tasks without website', async () => {
  const staging = resolve('../..', '.tmp')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const home = await mkdtemp(join(staging, 'main-'))
  const project = join(home, 'work')
  await mkdir(project, { mode: 0o700 })
  const env = {
    HOME: home,
    PATH: process.env.PATH!,
    TERM: 'xterm-256color',
    LANG: 'C',
    TMPDIR: home,
  }
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, 'run', resolve('src/gild.ts'), ...args],
      { cwd: project, env, stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, output, error }
  }
  const command = async (...args: string[]) => {
    const result = await run(...args)
    if (result.code) throw Error(result.error || result.output)
    return JSON.parse(result.output)
  }
  const until = async (id: string, done: (value: any) => boolean) => {
    const expires = Date.now() + 15000
    while (Date.now() < expires) {
      const value = await command('task', 'status', id)
      if (done(value)) return value
      await Bun.sleep(80)
    }
    throw Error('Real task did not reach expected state')
  }
  let running = false
  let foreign: string | undefined
  try {
    const first = await command('main', 'start')
    running = true
    expect(first.machineId).toMatch(/^[a-f0-9-]{36}$/)
    expect((await stat(join(home, '.gild/main/main.sock'))).mode & 0o777).toBe(
      0o600,
    )
    expect((await run('main', 'start')).code).not.toBe(0)
    const taskId = randomUUID()
    const submitted = await command(
      'task',
      'submit',
      '--id',
      taskId,
      '/bin/sh',
      '-c',
      'printf "real main receipt\\n"; printf "owned effect\\n" > result.txt',
    )
    expect(submitted.status).toBe('PENDING')
    const finished = await until(
      submitted.id,
      (t) => t.status === 'SUCCEEDED' || t.status === 'FAILED',
    )
    const retry = await command(
      'task',
      'submit',
      '--id',
      taskId,
      '/bin/sh',
      '-c',
      'printf "real main receipt\\n"; printf "owned effect\\n" > result.txt',
    )
    expect(retry.id).toBe(taskId)
    expect(retry.status).toBe('SUCCEEDED')
    expect(
      (await run('task', 'submit', '--id', taskId, '/bin/sh', '-c', 'exit 0'))
        .code,
    ).not.toBe(0)
    expect(finished.status).toBe('SUCCEEDED')
    expect(finished.code).toBe(0)
    expect(finished.output).toContain('real main receipt')
    expect(await readFile(join(project, 'result.txt'), 'utf8')).toBe(
      'owned effect\n',
    )
    const unicode = await command(
      'task',
      'submit',
      'python3',
      '-c',
      'import os,time;os.write(1,bytes([226]));time.sleep(.1);os.write(1,bytes([130,172]))',
    )
    expect(
      (await until(unicode.id, (t) => t.status === 'SUCCEEDED')).output,
    ).toContain('€')
    const failed = await command('task', 'submit', '/bin/sh', '-c', 'exit 7')
    expect((await until(failed.id, (t) => t.status === 'FAILED')).code).toBe(7)
    const slow = await command('task', 'submit', '/bin/sh', '-c', 'sleep 60')
    await until(slow.id, (t) => t.status === 'RUNNING')
    expect((await command('task', 'cancel', slow.id)).status).toBe('CANCELLED')
    expect(
      (await until(slow.id, (t) => typeof t.code === 'number')).code,
    ).not.toBe(0)
    foreign = (
      await run(
        'spawn',
        '--detach',
        '--name',
        'foreign-proof',
        '/bin/sh',
        '-c',
        'sleep 60',
      )
    ).output.trim()
    expect(foreign).toBe('foreign-proof')
    const denied = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(
        join(home, '.gild/sessions/foreign-proof.sock'),
      )
      let text = ''
      socket.setEncoding('utf8')
      socket.setTimeout(3000, () => {
        socket.destroy()
        reject(Error('identity guard timeout'))
      })
      socket.on('error', reject)
      socket.on('connect', () =>
        socket.write(
          JSON.stringify({
            type: 'stop',
            graceMs: 100,
            expected: finished.worker,
          }) + '\n',
        ),
      )
      socket.on('data', (data) => (text += data))
      socket.on('end', () => resolve(text))
    })
    expect(denied).toContain('foreign worker was not stopped')
    expect((await run('task', 'cancel', randomUUID())).error).toContain(
      'foreign sessions cannot be controlled',
    )
    expect((await run('status', foreign)).code).toBe(0)
    await command('main', 'stop')
    running = false
    // Main shutdown must not retire an unrelated, locally owned session.
    expect((await run('status', foreign)).code).toBe(0)
    const second = await command('main', 'start')
    running = true
    expect(
      (
        await command(
          'task',
          'submit',
          '--id',
          taskId,
          '/bin/sh',
          '-c',
          'printf "real main receipt\\n"; printf "owned effect\\n" > result.txt',
        )
      ).submitted,
    ).toBe(submitted.submitted)
    expect(second.machineId).toBe(first.machineId)
    expect((await command('task', 'status', submitted.id)).output).toContain(
      'real main receipt',
    )
    const pinned = await command(
      'task',
      'submit',
      'agent',
      'missing-approved-profile',
    )
    expect(
      (await until(pinned.id, (t) => t.status === 'FAILED')).code,
    ).not.toBe(0)
    const interruptedId = randomUUID()
    const interruptedArgs = [
      '/bin/sh',
      '-c',
      'printf "one dispatch\\n" >> crash-count.txt; sleep 60',
    ]
    await command('task', 'submit', '--id', interruptedId, ...interruptedArgs)
    await until(interruptedId, (t) => t.status === 'RUNNING')
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await stat(join(project, 'crash-count.txt')).catch(() => null)) break
      await Bun.sleep(20)
    }
    expect(await readFile(join(project, 'crash-count.txt'), 'utf8')).toBe(
      'one dispatch\n',
    )
    // Exact PID from the main this test started, never an arbitrary service PID.
    process.kill(second.pid, 'SIGKILL')
    running = false
    await Bun.sleep(500)
    const recovered = await command('main', 'start')
    running = true
    expect(recovered.machineId).toBe(first.machineId)
    const retained = await command(
      'task',
      'submit',
      '--id',
      interruptedId,
      ...interruptedArgs,
    )
    expect(retained.status).toBe('INTERRUPTED')
    expect(await readFile(join(project, 'crash-count.txt'), 'utf8')).toBe(
      'one dispatch\n',
    )
  } finally {
    if (foreign) await run('stop', foreign, '--grace-ms', '100')
    if (running) await run('main', 'stop')
    await rm(home, { recursive: true, force: true })
  }
}, 60000)

test('main refuses a symlinked owner registry before dispatch', async () => {
  const staging = resolve('../..', '.tmp')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const home = await mkdtemp(join(staging, 'main-deny-'))
  try {
    await mkdir(join(home, '.gild/main'), { recursive: true, mode: 0o700 })
    await symlink(
      join(home, 'foreign-state'),
      join(home, '.gild/main/state.json'),
    )
    const child = Bun.spawn(
      [process.execPath, 'run', resolve('src/gild.ts'), '__main-worker'],
      {
        env: { HOME: home, PATH: process.env.PATH! },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(await child.exited).not.toBe(0)
    expect(
      await stat(join(home, '.gild/main/main.sock')).catch(() => null),
    ).toBe(null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
