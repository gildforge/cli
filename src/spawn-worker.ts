import { runNative, debugFallback, supportsPty } from './spawn-native'
import { createRequire } from 'node:module'
import { chmodSync, unlinkSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { IPty } from 'node-pty'
import { adapterFor } from './spawn-adapters'
import { shellQuote } from './spawn-adapters/types'
import { applyEvent, type AgentEvent, type SessionState } from './spawn-events'
import { realAgent, agentEnvironment } from './spawn-binary'
import { StateReporter, type ReportTarget } from './spawn-report'
import {
  MentionBridge,
  type BridgeEvent,
  type BridgeTarget,
} from './spawn-bridge'
import { GildClient } from './api/client'
import { TerminalOutput } from './spawn-output'
import { InjectionQueue } from './spawn-queue'
import { startWatchdog } from './spawn-nudge-worker'
import type { NudgeEvent } from './spawn-nudge'
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
  bridging?: boolean
  identity?: string
  profile?: { name: string; channels?: string[] }
  envAllowlist?: string[]
  nudges?: string[]
}
const options: Options = JSON.parse(process.argv[2])
// Scoped credentials travel over IPC, never argv, env, settings or event payloads.
function credential<T>(type: string, key: string, wanted?: boolean) {
  if (!wanted) return undefined
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Agent ${type} credentials were not delivered`)),
      3000,
    )
    const receive = (message: Record<string, unknown>) => {
      if (message.type !== type) return
      clearTimeout(timer)
      process.off('message', receive)
      const value = message[key] as { token?: string } | undefined
      if (!value?.token)
        reject(new Error(`Invalid agent ${type} configuration`))
      else resolve(value as T)
    }
    process.on('message', receive)
  })
}
const reportConfig = credential<ReportTarget>(
  'report',
  'report',
  options.reporting,
)
const bridgeConfig = credential<BridgeTarget>(
  'bridge',
  'bridge',
  options.bridging,
)
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
let bridge: MentionBridge | undefined
let watchdog: ReturnType<typeof startWatchdog>
const bridgeAbort = new AbortController()
function publish(event: AgentEvent) {
  applyEvent(state, event)
  watchdog?.state(state.state)
  queue?.changed()
  broadcast(event)
  reporter?.event(event)
}
/** Local subscribers only; mention records say nothing about the agent's state. */
function broadcast(event: AgentEvent | BridgeEvent | NudgeEvent) {
  const line = JSON.stringify(event) + '\n'
  for (const socket of subscribers) {
    if (socket.writableLength + Buffer.byteLength(line) > 1024 * 1024)
      socket.destroy()
    else socket.write(line)
  }
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
  bridgeAbort.abort()
  watchdog?.close()
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
    agentEnvironment(binary, options.envAllowlist),
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
            ...(options.identity ? { identity: options.identity } : {}),
            ...(options.profile
              ? {
                  profile: options.profile.name,
                  channels:
                    bridge?.channels ??
                    options.profile.channels?.map((repo) => ({
                      repo,
                      state: 'connecting' as const,
                    })),
                }
              : {}),
            cwd: process.cwd(),
            pid: process.pid,
            childPid: child.pid,
            started,
            ...state,
            held: queue?.held,
            nudges: watchdog?.status(),
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
          // Channel problems that happened before subscribing stay visible.
          for (const channel of bridge?.channels ?? [])
            if (channel.state === 'error')
              socket.write(
                JSON.stringify({
                  type: 'channel',
                  session: options.id,
                  repo: channel.repo,
                  state: channel.state,
                  error: channel.error,
                  ts: new Date().toISOString(),
                  snapshot: true,
                }) + '\n',
              )
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
  for (let suffix = 1, attempt = 0; ;) {
    path = socketPath(options.id, directory)
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
      if (attempt === 0 && (await removeDeadSocket(path))) {
        attempt++
        continue
      }
      if (options.profile && suffix < 999999) {
        options.id = `${options.profile.name}-${++suffix}`
        attempt = 0
        continue
      }
      throw new Error(
        `Session ${options.id} already exists; use another --name`,
      )
    }
  }
  await chmod(path, 0o600)
  server.on('error', failed)
  const binary = realAgent(options.agent)
  const env = agentEnvironment(binary, options.envAllowlist)
  try {
    const prepared = await adapter?.prepare(
      {
        id: options.id,
        directory,
        command: options.hookCommand,
        emit: publish,
        environment: env,
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
  const target = bridgeConfig ? await bridgeConfig : undefined
  watchdog = startWatchdog({
    specs: options.nudges ?? [],
    session: options.id,
    agent: options.identity,
    channels: options.profile?.channels ?? [],
    target,
    enqueue: (text) => queue!.enqueue(text),
    emit: broadcast,
  })
  if (watchdog) watchdog.state(state.state)
  if (target && options.profile) {
    bridge = new MentionBridge({
      client: new GildClient(target.server + '/api/v1', target.token),
      agent: target.agent,
      label: options.profile.name,
      gild: options.hookCommand.map(shellQuote).join(' '),
      session: options.id,
      repos: options.profile.channels ?? [],
      file: join(directory, `${options.id}.mentions.json`),
      enqueue: (text, typed) => queue!.enqueue(text, typed),
      watch: watchdog?.repos,
      observe: (repo, events) => watchdog?.events(repo, events),
      emit: (event) => {
        broadcast(event)
        watchdog?.bridge(event)
      },
    })
    void bridge.start(bridgeAbort.signal)
  }
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
