import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { createConnection } from 'node:net'
import { Command, InvalidArgumentError } from 'commander'
import type { StartMessage } from './spawn-detach'
import { privateSessionsDirectory, socketPath } from './spawn-sessions'

/** Caller side of detached sessions: `gild spawn --detach`, `gild attach`,
 * `gild stop`. The worker side is spawn-detach.ts. */
export const DETACH_KEY = 0x1d // Ctrl-], as in telnet
const CTRL_C = 0x03

export function dimension(value: string) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 1000)
    throw new InvalidArgumentError('must be an integer from 1 to 1000')
  return number
}

/** The worker runs in its own session (setsid) with none of the caller's
 * stdio, so a caller without a terminal (an agent's Bash tool) gets EOF as
 * soon as `gild spawn --detach` exits; only the IPC channel is shared. */
export function detachedSpawn(cwd: string): SpawnOptions {
  return { cwd, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
}
/** Resolves with the session id once the socket listens and the agent has
 * started, then lets go of the worker. */
export async function detachedReady(worker: ChildProcess): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await new Promise<StartMessage>((resolve, reject) => {
      timer = setTimeout(() => {
        worker.kill('SIGTERM')
        reject(new Error('The detached session did not start within 30 s'))
      }, 30000)
      worker.on('message', (message: StartMessage) => {
        if (message?.type === 'ready' || message?.type === 'failed')
          resolve(message)
      })
      worker.once('error', reject)
      worker.once('exit', (code) =>
        reject(
          new Error(`The detached session exited while starting (${code})`),
        ),
      )
    })
    if (result.type === 'failed') throw new Error(result.error)
    return result.id
  } finally {
    clearTimeout(timer)
    worker.removeAllListeners()
    if (worker.connected) worker.disconnect()
    worker.unref()
  }
}

function connect(id: string, directory: string) {
  const socket = createConnection(socketPath(id, directory))
  return socket
}
function sessionError(id: string, error: NodeJS.ErrnoException) {
  return error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
    ? new Error(`No live session ${id}`)
    : error
}

/** Replays the session's recent output, then streams it live. Interactive
 * viewers type into the agent through the session's injection queue. */
export async function attachSession(id: string, watch: boolean) {
  const directory = await privateSessionsDirectory()
  const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY
  if (!watch && !terminal)
    throw new Error(
      'gild attach needs a terminal; use gild attach --watch to stream output read-only',
    )
  const size = () => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  })
  const socket = connect(id, directory)
  const frame = (value: object) => {
    if (socket.writable) socket.write(JSON.stringify(value) + '\n')
  }
  const wasRaw = process.stdin.isRaw ?? false
  let raw = false
  let byKey = false
  const keys = watch ? [DETACH_KEY, CTRL_C] : [DETACH_KEY]
  const input = (data: Buffer) => {
    let at = -1
    for (const key of keys) {
      const index = data.indexOf(key)
      if (index >= 0 && (at < 0 || index < at)) at = index
    }
    const typed = at < 0 ? data : data.subarray(0, at)
    if (!watch && typed.length)
      frame({ t: 'i', d: Buffer.from(typed).toString('base64') })
    if (at >= 0) {
      byKey = true
      socket.end()
    }
  }
  const resized = () => frame({ t: 'r', ...size() })
  const drain = () => socket.resume()
  const cleanup = () => {
    process.stdin.off('data', input)
    process.off('SIGWINCH', resized)
    process.stdout.off('drain', drain)
    if (raw) process.stdin.setRawMode(wasRaw)
    process.stdin.pause()
  }
  await new Promise<void>((resolve, reject) => {
    let header: Buffer | undefined = Buffer.alloc(0)
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({
          type: 'attach',
          mode: watch ? 'watch' : 'interactive',
          ...(watch ? {} : size()),
        }) + '\n',
      ),
    )
    socket.on('error', (error) => {
      cleanup()
      reject(sessionError(id, error))
    })
    const show = (data: Buffer) => {
      if (data.length && !process.stdout.write(data)) socket.pause()
    }
    socket.on('data', (data: Buffer) => {
      if (!header) return show(data)
      header = Buffer.concat([header, data])
      const end = header.indexOf(10)
      if (end < 0) return
      const reply = JSON.parse(header.subarray(0, end).toString())
      const rest = header.subarray(end + 1)
      header = undefined
      if (reply.error) {
        socket.destroy()
        cleanup()
        return reject(new Error(reply.error))
      }
      if (terminal) {
        process.stdin.setRawMode(true)
        raw = true
      }
      if (terminal || !watch) {
        process.stdin.on('data', input)
        process.stdin.resume()
      }
      if (!watch) process.on('SIGWINCH', resized)
      process.stdout.on('drain', drain)
      show(rest)
    })
    socket.on('close', () => {
      cleanup()
      if (byKey && terminal)
        process.stderr.write(
          `\r\n[detached from ${id}; it is still running]\r\n`,
        )
      resolve()
    })
  })
}

/** Takes a session offline and prints its final `exited` event. */
export async function stopSession(id: string, graceMs: number) {
  const directory = await privateSessionsDirectory()
  const socket = connect(id, directory)
  const text = await new Promise<string>((resolve, reject) => {
    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Session ${id} did not stop`))
    }, graceMs + 10000)
    socket.setEncoding('utf8')
    socket.on('connect', () =>
      socket.write(JSON.stringify({ type: 'stop', graceMs }) + '\n'),
    )
    socket.on('data', (chunk: string) => (data += chunk))
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(sessionError(id, error))
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(data)
    })
  })
  for (const line of text.split('\n')) {
    if (!line) continue
    const event = JSON.parse(line)
    if (event.error) throw new Error(event.error)
    if (event.type === 'exited') return line
  }
  throw new Error(`Session ${id} closed without reporting its exit`)
}

export function detachCommands(program: Command) {
  program
    .command('attach <id>')
    .description('watch and type into a detached agent session')
    .option('--watch', 'stream output read-only (several may watch at once)')
    .addHelpText(
      'after',
      '\nPress Ctrl-] to detach; the agent keeps running (gild stop <id> ends it).\n' +
        'Ctrl-C goes to the agent. With --watch, Ctrl-C also detaches.',
    )
    .action((id: string, opts: { watch?: boolean }) =>
      attachSession(id, !!opts.watch),
    )
  program
    .command('stop <id>')
    .description(
      'hang up a local agent session, SIGKILL it after the grace period, print its exit',
    )
    .option(
      '--grace-ms <ms>',
      'how long the agent has to exit after the hangup',
      (value: string) => {
        const number = Number(value)
        if (!Number.isSafeInteger(number) || number < 0 || number > 60000)
          throw new InvalidArgumentError('must be an integer from 0 to 60000')
        return number
      },
      3000,
    )
    .action(async (id: string, opts: { graceMs: number }) => {
      console.log(await stopSession(id, opts.graceMs))
    })
}
