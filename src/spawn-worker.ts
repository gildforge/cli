import { createRequire } from 'node:module'
import { chmodSync, unlinkSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { IPty } from 'node-pty'
import { InjectionQueue } from './spawn-queue'
import {
  MAX_MESSAGE_BYTES,
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
}
const options: Options = JSON.parse(process.argv[1])
let child: IPty | undefined
let queue: InjectionQueue | undefined
let path: string | undefined
let ownsSocket = false
let closing = false
const sockets = new Set<Socket>()
const wasRaw = process.stdin.isRaw ?? false
const server = createServer()

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
  if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
  queue?.close()
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
      process.stdout.write('', () => process.exit(code))
    },
    terminate ? 150 : 10,
  )
}
function failed(error: unknown) {
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

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('spawn requires an interactive terminal')
  const directory = await privateSessionsDirectory()
  path = socketPath(options.id, directory)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
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
        if (!child || !queue) throw new Error('Session is starting')
        if (request.type === 'info') {
          const info: LocalSession = {
            id: options.id,
            agent: options.agent,
            cwd: process.cwd(),
            pid: process.pid,
            childPid: child.pid,
            started,
          }
          socket.end(JSON.stringify(info) + '\n')
        } else if (
          request.type === 'send' &&
          typeof request.message === 'string'
        ) {
          queue.enqueue(request.message)
          socket.end('{"queued":true}\n')
        } else throw new Error('Invalid session request')
      } catch (error) {
        socket.end(JSON.stringify({ error: (error as Error).message }) + '\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      ownsSocket = true
      resolve()
    })
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE')
      throw new Error(
        `Session ${options.id} already exists; use another --name or run gild sessions to remove stale sockets`,
      )
    throw error
  })
  await chmod(path, 0o600)
  server.on('error', failed)
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
  const pty: typeof import('node-pty') = require(nodePty)
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CODEX_SESSION_ID|CODEX_THREAD_ID)$/.test(
        name,
      ) ||
      name.startsWith('CLAUDE_CODE_')
    )
      continue
    env[name] = value
  }
  process.stdin.setRawMode(true)
  child = pty.spawn(options.agent, options.args, {
    name: 'xterm-256color',
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: process.cwd(),
    env,
    encoding: null,
  })
  queue = new InjectionQueue((data) => child!.write(data), options.idleMs)
  process.stdin.on('data', (data: Buffer) => {
    queue!.userInput()
    child!.write(data)
  })
  process.stdin.on('end', () => finish(0))
  process.stdin.resume()
  process.on('SIGWINCH', () =>
    child!.resize(process.stdout.columns || 80, process.stdout.rows || 24),
  )
  child.onData((data) => {
    if (!process.stdout.write(data)) child!.pause()
  })
  process.stdout.on('drain', () => {
    if (!closing) child!.resume()
  })
  process.stdout.on('error', failed)
  child.onExit(({ exitCode, signal }) =>
    finish(signal ? 128 + signal : exitCode, false),
  )
}
const started = new Date().toISOString()
main().catch(failed)
