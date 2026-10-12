import { Command } from 'commander'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { hostname, homedir, platform, release } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { gildInvocation } from './gild-invocation'
import { privateSessionsDirectory, removeDeadSocket } from './spawn-sessions'
import { stopSession } from './spawn-attach'

const LIMIT = 64 * 1024
const taskInput = z
  .object({
    agent: z.string().min(1).max(1024),
    args: z.array(z.string().max(8192)).max(128),
    cwd: z.string().max(4096).refine(isAbsolute),
    mode: z.enum(['HOST', 'VM']),
  })
  .strict()
const task = taskInput.extend({
  id: z.string().uuid(),
  session: z.string().optional(),
  worker: z
    .object({ pid: z.number().int().positive(), started: z.string() })
    .optional(),
  status: z.enum([
    'PENDING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'INTERRUPTED',
  ]),
  submitted: z.string(),
  updated: z.string(),
  code: z.number().int().optional(),
  output: z.string().max(32768),
  outputTruncated: z.boolean(),
  error: z.string().max(4096).optional(),
})
type Task = z.infer<typeof task>
const registry = z
  .object({
    schema: z.literal(1),
    machineId: z.string().uuid(),
    displayName: z.string().min(1).max(128),
    tasks: z.array(task).max(1000),
  })
  .strict()
const request = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('status'), id: z.string().uuid().optional() })
    .strict(),
  z
    .object({
      type: z.literal('submit'),
      id: z.string().uuid(),
      input: taskInput,
    })
    .strict(),
  z.object({ type: z.literal('cancel'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
])
type Request = z.infer<typeof request>
const mainDirectory = () => join(homedir(), '.gild', 'main')
const endpoint = () => join(mainDirectory(), 'main.sock')
const terminal = (t: Task) => !['PENDING', 'RUNNING'].includes(t.status)

async function privateDirectory() {
  await privateSessionsDirectory()
  const root = mainDirectory()
  await mkdir(root, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
  const info = await lstat(root)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!()
  )
    throw Error('Unsafe main directory')
  await chmod(root, 0o700)
  if (Buffer.byteLength(endpoint()) > 103)
    throw Error('Main socket path is too long')
  return root
}

/** Owner-local only. A network address or Tailscale membership grants nothing. */
export async function mainRequest(value: Request): Promise<unknown> {
  await privateDirectory()
  const info = await lstat(endpoint())
  if (!info.isSocket() || info.uid !== process.getuid!() || info.mode & 0o077)
    throw Error('Unsafe main socket')
  const data = JSON.stringify(request.parse(value)) + '\n'
  if (Buffer.byteLength(data) > LIMIT)
    throw Error('Main request exceeds 64 KiB')
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint())
    let response = ''
    let settled = false
    const fail = (e: Error) => {
      if (!settled) {
        settled = true
        socket.destroy()
        reject(e)
      }
    }
    socket.setEncoding('utf8')
    socket.setTimeout(35000, () => fail(Error('Main did not respond')))
    socket.on('error', fail)
    socket.on('connect', () => socket.write(data))
    socket.on('data', (chunk) => {
      response += chunk
      if (Buffer.byteLength(response) > LIMIT)
        return fail(Error('Main response exceeds 64 KiB'))
      if (!response.includes('\n')) return
      try {
        const result = JSON.parse(response.slice(0, response.indexOf('\n')))
        if (result.ok !== true)
          return fail(Error(result.error ?? 'Invalid main response'))
        settled = true
        socket.destroy()
        resolve(result.value)
      } catch {
        fail(Error('Invalid main response'))
      }
    })
    socket.on('end', () => fail(Error('Main closed without response')))
  })
}

async function loadRegistry(root: string) {
  let file
  try {
    file = await open(
      join(root, 'state.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return registry.parse({
      schema: 1,
      machineId: randomUUID(),
      displayName: hostname().slice(0, 128),
      tasks: [],
    })
  }
  try {
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.uid !== process.getuid!() ||
      info.mode & 0o077 ||
      info.size > 40 * 1024 * 1024
    )
      throw Error('Unsafe main registry')
    return registry.parse(JSON.parse(await file.readFile('utf8')))
  } finally {
    await file.close()
  }
}

export async function runLocalMain() {
  const root = await privateDirectory()
  const state = await loadRegistry(root)
  const children = new Map<string, ChildProcess>()
  let stopping = false
  let writes = Promise.resolve()
  const persist = () => {
    const bytes = JSON.stringify(state) + '\n'
    const next = writes.then(async () => {
      const temporary = join(root, `state-${randomUUID()}.tmp`)
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(root, 'state.json'))
    })
    writes = next
    return next
  }
  const update = (t: Task) => {
    t.updated = new Date().toISOString()
    return persist()
  }
  // A restart never executes saved work again or kills an unverified old PID.
  for (const t of state.tasks)
    if (!terminal(t)) {
      t.status = 'INTERRUPTED'
      t.error = 'Main restarted; previous worker result is unconfirmed'
      t.updated = new Date().toISOString()
    }
  const cancel = async (t: Task) => {
    if (terminal(t)) return t
    t.status = 'CANCELLED'
    const child = children.get(t.id)
    if (child) {
      if (t.session) {
        try {
          await stopSession(t.session, 1000, t.worker)
        } catch (error) {
          child.kill('SIGHUP')
          t.error = (error as Error).message.slice(0, 4096)
        }
      } else child.kill('SIGHUP')
    }
    await update(t)
    return t
  }
  const launch = (t: Task) => {
    const session = `main-${t.id.slice(0, 24)}`
    const argv = [
      ...gildInvocation(),
      'spawn',
      '--detach',
      '--supervised',
      ...(t.mode === 'VM' ? ['--vm'] : []),
      ...(t.agent === 'agent' ? [] : ['--name', session]),
      t.agent,
      ...t.args,
    ]
    const child = spawn(argv[0], argv.slice(1), {
      cwd: t.cwd,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    children.set(t.id, child)
    const decoder = new StringDecoder('utf8')
    let diagnostic = ''
    child.stderr?.on('data', (b: Buffer) => {
      diagnostic = (diagnostic + b.toString()).slice(-4096)
    })
    child.on('message', (message: unknown) => {
      const m = message as {
        pid?: number
        started?: string
        type?: string
        id?: string
        data?: string
        error?: string
      }
      if (
        m.type === 'ready' &&
        typeof m.id === 'string' &&
        Number.isInteger(m.pid) &&
        typeof m.started === 'string'
      ) {
        t.session = m.id
        t.worker = { pid: m.pid!, started: m.started! }
        if (t.status === 'CANCELLED')
          void stopSession(m.id, 1000, t.worker).catch(() =>
            child.kill('SIGHUP'),
          )
        else t.status = 'RUNNING'
      } else if (m.type === 'output' && typeof m.data === 'string') {
        const output = t.output + decoder.write(Buffer.from(m.data, 'base64'))
        t.output = output.slice(0, 8192)
        t.outputTruncated ||= output.length > 8192
      } else if (m.type === 'failed') t.error = String(m.error).slice(0, 4096)
      void update(t).catch(fatal)
    })
    child.once('error', (e) => {
      t.status = 'FAILED'
      t.error = e.message.slice(0, 4096)
      children.delete(t.id)
      void update(t).catch(fatal)
    })
    child.once('exit', (code, signal) => {
      children.delete(t.id)
      const finalOutput = t.output + decoder.end()
      t.output = finalOutput.slice(0, 8192)
      t.outputTruncated ||= finalOutput.length > 8192
      t.code = code ?? (signal === 'SIGHUP' ? 129 : 1)
      if (t.status !== 'CANCELLED')
        t.status = t.code === 0 ? 'SUCCEEDED' : 'FAILED'
      if (t.code && !t.error && diagnostic) t.error = diagnostic
      void update(t).catch(fatal)
    })
  }
  let ownsSocket = false
  let socketIdentity: Awaited<ReturnType<typeof lstat>> | undefined
  const stop = async () => {
    if (stopping) return
    stopping = true
    const cancelled = await Promise.allSettled(
      state.tasks.filter((t) => !terminal(t)).map(cancel),
    )
    await writes.catch(() => {
      process.exitCode = 1
    })
    if (cancelled.some((r) => r.status === 'rejected')) {
      process.exitCode = 1
      for (const child of children.values()) child.kill('SIGHUP')
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (ownsSocket) {
      const current = await lstat(endpoint()).catch(() => undefined)
      if (
        current &&
        current.ino === socketIdentity?.ino &&
        current.dev === socketIdentity?.dev
      )
        await unlink(endpoint())
      ownsSocket = false
    }
  }
  const fatal = (e: unknown) => {
    console.error(
      'gild main:',
      e instanceof Error ? e.message : 'state persistence failed',
    )
    process.exitCode = 1
    void stop().catch(() => {
      for (const child of children.values()) child.kill('SIGHUP')
    })
  }
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.setTimeout(5000, () => socket.destroy())
    let data = ''
    let handled = false
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      if (handled) return
      data += chunk
      if (Buffer.byteLength(data) > LIMIT) {
        handled = true
        socket.end('{"error":"Main request exceeds 64 KiB"}\n')
        return
      }
      if (!data.includes('\n')) return
      handled = true
      socket.setTimeout(35000, () => socket.destroy())
      void (async () => {
        const r = request.parse(JSON.parse(data.slice(0, data.indexOf('\n'))))
        if (r.type === 'stop') {
          socket.end('{"ok":true,"value":{"stopping":true}}\n')
          await stop()
          return
        }
        if (stopping) throw Error('Main is stopping')
        let result: unknown
        if (r.type === 'submit') {
          const existing = state.tasks.find((t) => t.id === r.id)
          if (existing) {
            const original = {
              agent: existing.agent,
              args: existing.args,
              cwd: existing.cwd,
              mode: existing.mode,
            }
            if (JSON.stringify(original) !== JSON.stringify(r.input))
              throw Error(
                'Task reference already belongs to a different request',
              )
            socket.end(JSON.stringify({ ok: true, value: existing }) + '\n')
            return
          }
          if (Buffer.byteLength(JSON.stringify(r.input)) > 8192)
            throw Error('Task input exceeds 8 KiB')
          if (state.tasks.length >= 1000)
            throw Error('Main task history is full')
          if (state.tasks.filter((t) => !terminal(t)).length >= 8)
            throw Error('Main has eight active tasks')
          if (r.input.mode === 'VM' && platform() !== 'linux')
            throw Error('MVP VM tasks require Linux Firecracker')
          const cwd = await lstat(r.input.cwd)
          if (!cwd.isDirectory() || cwd.isSymbolicLink())
            throw Error('Task directory must be an existing real directory')
          const now = new Date().toISOString()
          const t: Task = {
            ...r.input,
            id: r.id,
            status: 'PENDING',
            submitted: now,
            updated: now,
            output: '',
            outputTruncated: false,
          }
          state.tasks.push(t)
          await persist()
          result = { ...t }
          launch(t)
        } else if (r.type === 'status' && !r.id) {
          result = {
            pid: process.pid,
            machineId: state.machineId,
            displayName: state.displayName,
            hostOS: { platform: platform(), release: release() },
            taskCount: state.tasks.length,
            tasks: state.tasks
              .slice(-100)
              .map(({ id, status, updated, mode, session, code }) => ({
                id,
                status,
                updated,
                mode,
                session,
                code,
              })),
          }
        } else {
          const t = state.tasks.find((t) => t.id === r.id)
          if (!t)
            throw Error('Unknown task; foreign sessions cannot be controlled')
          result = r.type === 'cancel' ? await cancel(t) : t
        }
        const response = JSON.stringify({ ok: true, value: result }) + '\n'
        if (Buffer.byteLength(response) > LIMIT)
          throw Error(
            'Main response exceeds 64 KiB; request an individual task',
          )
        socket.end(response)
      })().catch((e) =>
        socket.end(JSON.stringify({ error: (e as Error).message }) + '\n'),
      )
    })
  })
  // Only a refused, unchanged owner socket is stale; live/foreign replacements win.
  const previous = await lstat(endpoint()).catch(() => undefined)
  if (previous) {
    if (
      !previous.isSocket() ||
      previous.uid !== process.getuid!() ||
      previous.mode & 0o077
    )
      throw Error('Unsafe main socket')
    await removeDeadSocket(endpoint(), undefined, previous)
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint(), () => resolve())
  })
  ownsSocket = true
  await chmod(endpoint(), 0o600)
  socketIdentity = await lstat(endpoint())
  await persist()
  process.on('SIGTERM', () => void stop().catch(fatal))
  process.on('SIGHUP', () => void stop().catch(fatal))
  if (process.connected)
    process.send?.({ ready: true, machineId: state.machineId })
  if (process.connected) process.disconnect?.()
}

export function mainCommands(program: Command) {
  const main = program
    .command('main')
    .description('owner-local persistent coordinator (website optional)')
  main.command('start').action(async () => {
    await privateDirectory()
    const command = [...gildInvocation(), '__main-worker']
    const child = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(Error('Main did not start within 10 seconds'))
      }, 10000)
      child.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(
          Error(
            `Main startup failed (${code}); inspect the owner-local endpoint/registry`,
          ),
        )
      })
      child.once('message', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    child.removeAllListeners()
    if (child.connected) child.disconnect()
    child.unref()
    console.log(JSON.stringify(await mainRequest({ type: 'status' })))
  })
  for (const type of ['status', 'stop'] as const)
    main
      .command(type)
      .action(async () =>
        console.log(JSON.stringify(await mainRequest({ type }))),
      )
  const tasks = program
    .command('task')
    .description('submit and inspect owner-local main tasks')
  tasks
    .command('submit <agent> [args...]')
    .passThroughOptions()
    .option('--vm', 'Linux Firecracker task')
    .option('--id <uuid>', 'stable task reference for retrying a lost reply')
    .action(
      async (
        agent: string,
        args: string[],
        opts: { vm?: boolean; id?: string },
      ) =>
        console.log(
          JSON.stringify(
            await mainRequest({
              type: 'submit',
              id: opts.id ?? randomUUID(),
              input: {
                agent,
                args,
                cwd: process.cwd(),
                mode: opts.vm ? 'VM' : 'HOST',
              },
            }),
          ),
        ),
    )
  for (const type of ['status', 'cancel'] as const)
    tasks
      .command(`${type} <id>`)
      .action(async (id: string) =>
        console.log(JSON.stringify(await mainRequest({ type, id }))),
      )
}
