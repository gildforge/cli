import { runNative, debugFallback, supportsPty } from './spawn-native'
import { createRequire } from 'node:module'
import { chmodSync, unlinkSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { IPty } from 'node-pty'
import { adapterFor } from './spawn-adapters'
import { applyEvent, type AgentEvent, type SessionState } from './spawn-events'
import { realAgent, agentEnvironment } from './spawn-binary'
import { StateReporter, type ReportTarget } from './spawn-report'
import { TerminalOutput } from './spawn-output'
import { InjectionQueue } from './spawn-queue'
import {
  MAX_MESSAGE_BYTES,
  removeDeadSocket,
  privateSessionsDirectory,
  socketPath,
  type LocalSession,
} from './spawn-sessions'

type Options = {
  agent: string
  args: string[]
  id: string
  idleMs: number
  resolveFrom: string[]
  hookCommand: string[]
  printId?: boolean
  reporting?: boolean
}
const options: Options = JSON.parse(process.argv[1])
// Scoped credentials travel over IPC, never argv, env, settings or event payloads.
const reportConfig = options.reporting
  ? new Promise<ReportTarget>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error('Agent reporting credentials were not delivered')),
        3000,
      )
      process.once(
        'message',
        (message: { type?: string; report?: ReportTarget }) => {
          clearTimeout(timer)
          if (message.type !== 'report' || !message.report?.token)
            reject(new Error('Invalid agent reporting configuration'))
          else resolve(message.report)
        },
      )
    })
  : undefined
let child: IPty | undefined
let queue: InjectionQueue | undefined
let path: string | undefined
let ownsSocket = false
let closing = false
let adapterReceive: ((raw: unknown) => void) | undefined
let adapterCleanup: (() => void) | undefined
const adapter = adapterFor(options.agent, options.args)
const state: SessionState = {
  state: 'unknown',
  lastActivity: new Date().toISOString(),
}
const subscribers = new Set<Socket>()
let reporter: StateReporter | undefined
function publish(event: AgentEvent) {
  applyEvent(state, event)
  queue?.changed()
  const line = JSON.stringify(event) + '\n'
  for (const socket of subscribers) {
    if (socket.writableLength + Buffer.byteLength(line) > 1024 * 1024)
      socket.destroy()
    else socket.write(line)
  }
  reporter?.event(event)
}
function submitted() {
  publish({
    session: options.id,
    agent: adapter!.name,
    type: 'busy',
    ts: new Date().toISOString(),
    raw: { source: 'pty_submit' },
  })
}
const sockets = new Set<Socket>()
const wasRaw = process.stdin.isRaw ?? false
let rawOwned = false
const server = createServer()
const output = new TerminalOutput(
  process.stdout.fd,
  () => child?.pause(),
  () => {
    if (!closing) child?.resume()
  },
  failed,
)

function killGroup(signal: NodeJS.Signals) {
  if (!child) return
  // node-pty's forkpty/setsid child owns this group, never gild's terminal group.
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
function restore() {
  process.stdin.pause()
  if (rawOwned) {
    process.stdin.setRawMode(wasRaw)
    rawOwned = false
  }
  queue?.close()
  adapterCleanup?.()
  adapterCleanup = undefined
  for (const socket of sockets) socket.destroy()
  server.close()
  if (ownsSocket && path) {
    try {
      unlinkSync(path)
    } catch {}
  }
}
function finish(code: number, terminate = true) {
  if (closing) return
  closing = true
  restore()
  // Also terminate descendants on a normal agent exit; they may hold the PTY.
  try {
    killGroup('SIGHUP')
  } catch {}
  setTimeout(
    () => {
      try {
        killGroup('SIGKILL')
      } catch {}
      void (reporter?.close() ?? Promise.resolve()).finally(() => {
        // A signal exit cannot wait forever for a terminal reader that stopped.
        if (terminate) setTimeout(() => process.exit(code), 250)
        void output.flush().then(() => process.exit(code))
      })
    },
    terminate ? 150 : 10,
  )
}
function failed(error: unknown) {
  if (closing) return
  console.error(
    `gild spawn: ${error instanceof Error ? error.message : String(error)}`,
  )
  finish(1)
}
process.on('SIGTERM', () => finish(143))
process.on('SIGHUP', () => finish(129))
// Raw-mode Ctrl-C goes down stdin. An externally delivered SIGINT hangs up gild.
process.on('SIGINT', () => finish(130))
process.on('disconnect', () => finish(1))
process.on('uncaughtException', failed)
process.on('unhandledRejection', failed)
process.on('exit', () => {
  restore()
  try {
    killGroup('SIGKILL')
  } catch {}
})

async function fallback(error: unknown) {
  debugFallback(error)
  restore()
  ownsSocket = false
  closing = true
  // Native stdio belongs to the child; PTY lifecycle handlers must not exit first.
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGHUP')
  const binary = realAgent(options.agent)
  const code = await runNative(
    binary,
    options.args,
    process.cwd(),
    agentEnvironment(binary),
  )
  process.exit(code)
}
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !supportsPty())
    return fallback('PTY unavailable')
  let pty: typeof import('node-pty')
  try {
    let nodePty: string | undefined
    for (const from of options.resolveFrom) {
      try {
        nodePty = createRequire(from).resolve('node-pty')
        break
      } catch {}
    }
    if (!nodePty)
      throw new Error(
        'spawn needs the optional node-pty dependency. Install gildforge with npm (without --omit=optional); standalone downloads do not include node-pty.',
      )
    const require = createRequire(nodePty)
    // npm 1.1.0's macOS prebuild helper arrives without its executable bit.
    const ptyRoot = dirname(nodePty)
    if (process.platform === 'darwin') {
      const helper = join(
        ptyRoot,
        '..',
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      )
      try {
        chmodSync(helper, 0o755)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    pty = require(nodePty)
  } catch (error) {
    return fallback(error)
  }
  const directory = await privateSessionsDirectory()
  path = socketPath(options.id, directory)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      subscribers.delete(socket)
    })
    socket.on('error', () => socket.destroy())
    socket.setTimeout(3000, () => socket.destroy())
    socket.setEncoding('utf8')
    let data = ''
    let replied = false
    socket.on('data', (chunk: string) => {
      if (replied) return
      data += chunk
      if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) {
        replied = true
        socket.end('{"error":"Message exceeds 64 KiB"}\n')
        return
      }
      if (!data.includes('\n')) return
      replied = true
      try {
        const request = JSON.parse(data.slice(0, data.indexOf('\n')))
        if (request.type === 'hook') {
          if (adapter && request.agent === adapter.name) {
            const event = adapter.translate(options.id, request.raw)
            if (event) {
              publish(event)
              adapterReceive?.(request.raw)
            }
          }
          socket.end()
          return
        }
        if (request.type === 'info') {
          if (!child) throw new Error('Session is starting')
          const info: LocalSession = {
            id: options.id,
            agent: options.agent,
            cwd: process.cwd(),
            pid: process.pid,
            childPid: child.pid,
            started,
            ...state,
          }
          socket.end(JSON.stringify(info) + '\n')
        } else if (
          request.type === 'send' &&
          typeof request.message === 'string'
        ) {
          if (!queue) throw new Error('Session is starting')
          queue.enqueue(request.message)
          socket.end('{"queued":true}\n')
        } else if (request.type === 'subscribe') {
          subscribers.add(socket)
          socket.setTimeout(0)
          // An initial snapshot makes subscribing before the next hook useful.
          if (state.state !== 'unknown')
            socket.write(
              JSON.stringify({
                session: options.id,
                agent: adapter?.name ?? options.agent,
                type: state.state,
                tool: state.tool,
                ts: state.lastActivity,
                raw: { source: 'snapshot' },
              }) + '\n',
            )
        } else throw new Error('Invalid session request')
      } catch (error) {
        socket.end(JSON.stringify({ error: (error as Error).message }) + '\n')
      }
    })
  })
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const error = (e: Error) => reject(e)
        server.once('error', error)
        server.listen(path, () => {
          server.off('error', error)
          ownsSocket = true
          resolve()
        })
      })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      if (attempt === 0 && (await removeDeadSocket(path))) continue
      throw new Error(
        `Session ${options.id} already exists; use another --name`,
      )
    }
  }
  await chmod(path, 0o600)
  server.on('error', failed)
  const binary = realAgent(options.agent)
  const env = agentEnvironment(binary)
  try {
    const prepared = await adapter?.prepare(
      {
        id: options.id,
        directory,
        command: options.hookCommand,
        emit: publish,
        onCleanup: (cleanup) => {
          adapterCleanup = cleanup
          if (closing) {
            cleanup()
            throw new Error('Session closed during adapter setup')
          }
        },
      },
      options.args,
    )
    adapterCleanup = prepared?.cleanup
    adapterReceive = prepared?.receive
    if (closing) {
      prepared?.cleanup()
      return
    }
    child = pty.spawn(binary, prepared?.args ?? options.args, {
      name: 'xterm-256color',
      cols: process.stdout.columns,
      rows: process.stdout.rows,
      cwd: process.cwd(),
      env,
      encoding: null,
    })
  } catch (error) {
    return fallback(error)
  }
  if (reportConfig) reporter = new StateReporter(await reportConfig!, 'unknown')
  process.stdin.setRawMode(true)
  rawOwned = true
  if (options.printId) console.error(options.id)
  queue = new InjectionQueue(
    (data) => child!.write(data),
    options.idleMs,
    () => !adapter || state.state === 'idle',
    !!adapter,
    submitted,
  )
  process.stdin.on('data', (data: Buffer) => {
    queue!.userInput(data)
  })
  process.stdin.on('end', () => finish(0))
  process.stdin.resume()
  process.on('SIGWINCH', () =>
    child!.resize(process.stdout.columns || 80, process.stdout.rows || 24),
  )
  child.onData((data) => output.push(data))
  process.stdout.on('error', failed)
  child.onExit(({ exitCode, signal }) =>
    finish(signal ? 128 + signal : exitCode, false),
  )
}
const started = new Date().toISOString()
main().catch(failed)
