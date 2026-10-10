import { runNative, debugFallback, supportsPty } from './spawn-native'
import { promptGild } from './gild-invocation'
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
import { guestEnvironment, startVmChild, type VmChild } from './spawn-vm'
import { describeSync, type SyncResult } from './isolation/sync'
import {
  DetachedHost,
  endSocket,
  exitLine,
  reportDetached,
} from './spawn-detach'
import {
  MAX_MESSAGE_BYTES,
  removeDeadSocket,
  privateSessionsDirectory,
  socketPath,
  type LocalSession,
  type SyncSummary,
} from './spawn-sessions'

type Options = {
  agent: string
  args: string[]
  id: string
  idleMs: number
  ptyModule: string
  hookCommand: string[]
  printId?: boolean
  reporting?: boolean
  bridging?: boolean
  identity?: string
  profile?: { name: string; channels?: string[]; on?: string[] }
  envAllowlist?: string[]
  nudges?: string[]
  detach?: { cols: number; rows: number }
  /** `gild spawn --vm`: run the agent in a microVM; configDir holds isolation.json. */
  vm?: { configDir: string }
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
let child: IPty | VmChild | undefined
let queue: InjectionQueue | undefined
let path: string | undefined
let ownsSocket = false
let closing = false
let host: DetachedHost | undefined
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
  if (
    (event.raw as { hook_event_name?: string } | undefined)?.hook_event_name ===
    'UserPromptSubmit'
  )
    queue?.confirmed()
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
  if ('dispose' in child) return child.kill() // the guest hangs up its own group
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
  host?.cleanup()
  server.close()
  if (ownsSocket && path) {
    try {
      unlinkSync(path)
    } catch {}
  }
}
/** The final event: subscribers (and a `gild stop` caller) learn the exit
 * code, and are closed in order before the socket goes. */
let exitFlushed: Promise<unknown> = Promise.resolve()
function announceExit(code: number) {
  const events = [...subscribers]
  const viewers = host?.endViewers() ?? []
  subscribers.clear()
  const line = exitLine(options.id, code)
  exitFlushed = Promise.race([
    Promise.all([
      ...events.map((socket) => endSocket(socket, line)),
      ...viewers.map((socket) => endSocket(socket)),
    ]),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ])
  for (const socket of [...events, ...viewers]) sockets.delete(socket)
}
function finish(code: number, terminate = true) {
  if (closing) return
  closing = true
  announceExit(code)
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
      // --vm: the guest's last changes come back before the VM is stopped.
      const vm =
        child && 'dispose' in child
          ? child.dispose().then((r) => {
              if (!r) return
              console.error(
                `gild: working directory synced from the VM: ${describeSync(r)}`,
              )
              for (const c of r.conflicts)
                console.error(
                  `gild: kept the host copy of ${c.path} (${c.reason})${c.saved ? `; guest copy: ${c.saved}` : ''}`,
                )
            })
          : undefined
      void Promise.all([reporter?.close(), vm]).finally(() => {
        // A signal exit cannot wait forever for a terminal reader that stopped.
        if (terminate) setTimeout(() => process.exit(code), 250)
        void Promise.all([output.flush(), exitFlushed]).then(() =>
          process.exit(code),
        )
      })
    },
    terminate ? 150 : 10,
  )
}
function failed(error: unknown) {
  if (closing) return
  reportDetached(options.detach, {
    type: 'failed',
    error: String((error as Error)?.message ?? error),
  })
  console.error(
    `gild spawn: ${error instanceof Error ? error.message : String(error)}`,
  )
  finish(1)
}
process.on('SIGTERM', () => finish(143))
process.on('SIGHUP', () => finish(129))
// Raw-mode Ctrl-C goes down stdin. An externally delivered SIGINT hangs up gild.
process.on('SIGINT', () => finish(130))
// A detached worker outlives the `gild spawn --detach` that started it.
if (!options.detach) process.on('disconnect', () => finish(1))
process.on('uncaughtException', failed)
process.on('unhandledRejection', failed)
process.on('exit', () => {
  restore()
  try {
    killGroup('SIGKILL')
  } catch {}
})

async function fallback(error: unknown) {
  if (options.vm) {
    // Never quietly run an agent that was asked to be isolated on the host.
    const message = `--vm failed: ${(error as Error)?.message ?? error}`
    restore()
    // After restore: `gild spawn --detach` returns on this message, with the session already gone.
    await reportDetached(options.detach, { type: 'failed', error: message })
    console.error(`gild: ${message}`)
    process.exit(1)
  }
  debugFallback(error)
  // No terminal to fall back to: a detached session either has a PTY or fails.
  if (options.detach) return failed(error)
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
  if (
    !options.detach &&
    (!process.stdin.isTTY || !process.stdout.isTTY || !supportsPty())
  )
    return fallback('PTY unavailable')
  let pty: typeof import('node-pty')
  try {
    const nodePty = options.ptyModule
    if (!nodePty)
      throw new Error(
        'spawn needs the PTY module shipped in the gildforge platform package.',
      )
    const require = createRequire(nodePty)
    // Keep the macOS helper executable, including installs with restrictive modes.
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
      if (replied) return host?.feed(socket, chunk)
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
        if (request.type === 'sync') {
          if (!child || !('dispose' in child))
            throw new Error('sync applies to gild spawn --vm sessions only')
          socket.setTimeout(0)
          void child.sync().then(
            (r) => socket.end(JSON.stringify(summary(r)) + '\n'),
            (e: Error) =>
              socket.end(JSON.stringify({ error: e.message }) + '\n'),
          )
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
            childPid: 'dispose' in child ? -1 : child.pid,
            started,
            ...state,
            held: queue?.held,
            nudges: watchdog?.status(),
            ...host?.info,
          }
          socket.end(JSON.stringify(info) + '\n')
        } else if (
          request.type === 'send' &&
          typeof request.message === 'string'
        ) {
          if (!queue) throw new Error('Session is starting')
          queue.enqueue(request.message)
          socket.end('{"queued":true}\n')
        } else if (request.type === 'attach') {
          if (!host || !child)
            throw new Error(
              host
                ? 'Session is starting'
                : 'Only detached sessions can be attached',
            )
          host.attach(socket, request)
          host.feed(socket, data.slice(data.indexOf('\n') + 1))
        } else if (request.type === 'stop') {
          if (!child) throw new Error('Session is starting')
          subscribers.add(socket)
          socket.setTimeout(0)
          stop(request.graceMs)
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
  const baseEnv = { ...env }
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
    if (options.detach) {
      host = new DetachedHost({
        ...options.detach,
        resize: (cols, rows) => child?.resize(cols, rows),
        input: (data) => queue?.userInput(data),
      })
      host.openLog(join(directory, options.id))
    }
    child = options.vm
      ? await startVmChild({
          configDir: options.vm.configDir,
          sessionId: options.id,
          cwd: process.cwd(),
          binary,
          args: prepared?.args ?? options.args,
          env: guestEnvironment(env, baseEnv, options.envAllowlist),
          cols: options.detach?.cols ?? (process.stdout.columns || 80),
          rows: options.detach?.rows ?? (process.stdout.rows || 24),
        })
      : pty.spawn(binary, prepared?.args ?? options.args, {
          name: 'xterm-256color',
          cols: options.detach?.cols ?? process.stdout.columns,
          rows: options.detach?.rows ?? process.stdout.rows,
          cwd: process.cwd(),
          env,
          encoding: null,
        })
    // Output from the first byte on, so attach can replay the start.
    if (host) child.onData((data) => host!.push(data as unknown as Buffer))
  } catch (error) {
    return fallback(error)
  }
  if (reportConfig) reporter = new StateReporter(await reportConfig!, 'unknown')
  if (!options.detach) {
    process.stdin.setRawMode(true)
    rawOwned = true
  }
  if (options.printId && !options.detach) console.error(options.id)
  queue = new InjectionQueue(
    (data) => child!.write(data),
    options.idleMs,
    () => !adapter || state.state === 'idle',
    !!adapter,
    submitted,
    // Claude reports UserPromptSubmit through hooks; Codex only reports turn end.
    adapter?.name !== 'claude',
    adapter?.name === 'claude',
    () =>
      // Never left 'busy' on a guess nothing confirmed: report and fall back.
      publish({
        session: options.id,
        agent: adapter!.name,
        type: 'idle',
        ts: new Date().toISOString(),
        raw: { source: 'unconfirmed_submit' },
      }),
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
      gild: promptGild(options.hookCommand),
      session: options.id,
      repos: options.profile.channels ?? [],
      triggers: options.profile.on ?? [],
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
  if (host) {
    child.onExit(({ exitCode, signal }) =>
      finish(signal ? 128 + signal : exitCode, false),
    )
    reportDetached(options.detach, { type: 'ready', id: options.id })
    return
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
  child.onExit(({ exitCode, signal }) => {
    finish(signal ? 128 + signal : exitCode, false)
  })
}
function summary(r: SyncResult): SyncSummary {
  return {
    written: r.written.length,
    deleted: r.deleted.length,
    rejected: r.rejected.length,
    conflicts: r.conflicts.slice(0, 100),
  }
}
/** `gild stop`: the agent gets the same hangup a closed terminal gives it,
 * then SIGKILL after the grace period; its exit then ends the session. */
let stopping: ReturnType<typeof setTimeout> | undefined
function stop(graceMs: unknown) {
  if (stopping) return
  const grace =
    Number.isSafeInteger(graceMs) && (graceMs as number) >= 0
      ? Math.min(graceMs as number, 60000)
      : 3000
  killGroup('SIGHUP')
  stopping = setTimeout(() => {
    killGroup('SIGKILL')
    // Should the PTY never report the exit, end the session anyway.
    setTimeout(() => finish(137), 2000)
  }, grace)
}
const started = new Date().toISOString()
main().catch(failed)
