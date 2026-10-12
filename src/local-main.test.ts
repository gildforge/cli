import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
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

test('concurrent same-reference requests reserve one real worker task and reject conflicting inputs', async () => {
  const staging = resolve('../..', '.tmp')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const home = await mkdtemp(join(staging, 'mc-'))
  const cwd = join(home, 'work')
  await mkdir(cwd, { mode: 0o700 })
  const env = {
    HOME: home,
    PATH: process.env.PATH!,
    LANG: 'C',
    TERM: 'xterm-256color',
  }
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, 'run', resolve('src/gild.ts'), ...args],
      { env, cwd, stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, text, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code) throw Error(error)
    return JSON.parse(text)
  }
  const wrapper = join(home, 'delayed-stat-main.ts')
  await writeFile(
    wrapper,
    `import {mock} from 'bun:test';import * as fs from 'node:fs/promises';const realStat=fs.lstat;mock.module('node:fs/promises',()=>({...fs,lstat:async(path:any,...args:any[])=>{if(path===${JSON.stringify(cwd)})await Bun.sleep(100);return realStat(path,...args)}}));const {runLocalMain}=await import(${JSON.stringify(resolve('src/local-main.ts'))});await runLocalMain()`,
  )
  const service = Bun.spawn([process.execPath, 'run', wrapper], {
    env,
    cwd,
    stdout: 'ignore',
    stderr: 'pipe',
  })
  let running = false
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await cli('main', 'status')
        running = true
        break
      } catch {
        await Bun.sleep(20)
      }
    }
    if (!running) throw Error('Controlled main did not start')
    const id = randomUUID(),
      input = {
        agent: '/bin/sh',
        args: ['-c', 'printf "one worker effect\\n" >> effects.txt'],
        cwd,
        mode: 'HOST',
      }
    // Open every real socket before writing, to deliver requests in one I/O turn.
    const peers = Array.from({ length: 8 }, () => {
      const socket = createConnection(join(home, '.gild/main/main.sock'))
      socket.setEncoding('utf8')
      const ready = new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      const response = new Promise<any>((resolve, reject) => {
        let text = ''
        socket.setTimeout(10000, () => {
          socket.destroy()
          reject(Error('concurrent receipt timeout'))
        })
        socket.on('error', reject)
        socket.on('data', (data) => {
          text += data
          if (text.includes('\n')) {
            socket.destroy()
            resolve(JSON.parse(text.slice(0, text.indexOf('\n'))))
          }
        })
      })
      return { socket, ready, response }
    })
    await Promise.all(peers.map((p) => p.ready))
    for (const p of peers)
      p.socket.write(JSON.stringify({ type: 'submit', id, input }) + '\n')
    const receipts = await Promise.all(peers.map((p) => p.response))
    expect(receipts.every((r) => r.ok && r.value.id === id)).toBe(true)
    let result: any
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await cli('task', 'status', id)
      if (result.status === 'SUCCEEDED' || result.status === 'FAILED') break
      await Bun.sleep(50)
    }
    const rows = (await cli('main', 'status')).tasks.filter(
      (t: any) => t.id === id,
    )
    await Bun.sleep(300)
    const effects = await readFile(join(cwd, 'effects.txt'), 'utf8').catch(
      () => '',
    )
    console.log(
      'Concurrent real effect/row evidence:',
      JSON.stringify({
        rowCount: rows.length,
        effectCount: effects.split('one worker effect').length - 1,
        status: result.status,
        error: result.error,
      }),
    )
    expect(rows.length).toBe(1)
    expect(result.status).toBe('SUCCEEDED')
    expect(await readFile(join(cwd, 'effects.txt'), 'utf8')).toBe(
      'one worker effect\n',
    )
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        resolve('src/gild.ts'),
        'task',
        'submit',
        '--id',
        id,
        '/bin/sh',
        '-c',
        'printf "changed effect" >> effects.txt',
      ],
      { env, cwd, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain(
      'different request',
    )
    expect(await readFile(join(cwd, 'effects.txt'), 'utf8')).toBe(
      'one worker effect\n',
    )
  } finally {
    if (running) await cli('main', 'stop')
    else service.kill('SIGTERM')
    await service.exited
    await rm(home, { recursive: true, force: true })
  }
}, 30000)

test('main stop fences a submission awaiting directory validation before it can dispatch', async () => {
  const staging = resolve('../..', '.tmp')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const home = await mkdtemp(join(staging, 'sr-')),
    cwd = join(home, 'work')
  await mkdir(cwd, { mode: 0o700 })
  const env = {
    HOME: home,
    PATH: process.env.PATH!,
    TERM: 'xterm-256color',
    LANG: 'C',
  }
  const wrapper = join(home, 'delayed-stat-main.ts')
  await writeFile(
    wrapper,
    `import {mock} from 'bun:test';import * as fs from 'node:fs/promises';const realStat=fs.lstat;mock.module('node:fs/promises',()=>({...fs,lstat:async(path:any,...args:any[])=>{if(path===${JSON.stringify(cwd)})await Bun.sleep(100);return realStat(path,...args)}}));const {runLocalMain}=await import(${JSON.stringify(resolve('src/local-main.ts'))});await runLocalMain()`,
  )
  const service = Bun.spawn([process.execPath, 'run', wrapper], {
    env,
    cwd,
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const rpc = async (value: unknown) => {
    const socket = createConnection(join(home, '.gild/main/main.sock'))
    socket.setEncoding('utf8')
    return new Promise<any>((resolve, reject) => {
      let text = ''
      socket.setTimeout(5000, () => {
        socket.destroy()
        reject(Error('stop fence timed out'))
      })
      socket.on('error', reject)
      socket.on('connect', () => socket.write(JSON.stringify(value) + '\n'))
      socket.on('data', (data) => {
        text += data
        if (text.includes('\n')) {
          socket.destroy()
          resolve(JSON.parse(text.slice(0, text.indexOf('\n'))))
        }
      })
    })
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await rpc({ type: 'status' })
        break
      } catch {
        await Bun.sleep(20)
      }
    }
    const id = randomUUID()
    const submission = rpc({
      type: 'submit',
      id,
      input: {
        agent: '/bin/sh',
        args: ['-c', 'printf "unexpected late effect" > late.txt'],
        cwd,
        mode: 'HOST',
      },
    })
    await Bun.sleep(20)
    expect((await rpc({ type: 'stop' })).value.stopping).toBe(true)
    const response = await submission
    await service.exited
    const state = JSON.parse(
      await readFile(join(home, '.gild/main/state.json'), 'utf8'),
    )
    const lateEffect = await stat(join(cwd, 'late.txt')).catch(() => null)
    console.log(
      'Stop/reservation real evidence:',
      JSON.stringify({
        response,
        rows: state.tasks.length,
        lateEffect: !!lateEffect,
      }),
    )
    expect(response.error).toBe('Main is stopping')
    expect(state.tasks).toEqual([])
    expect(lateEffect).toBe(null)
  } finally {
    service.kill('SIGTERM')
    await service.exited
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
