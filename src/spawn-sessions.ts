import type { SessionState } from './spawn-events'
import { chmod, lstat, mkdir, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'

export type ChannelStatus = {
  repo: string
  state: 'connecting' | 'listening' | 'error'
  error?: string
}
export type LocalSession = SessionState & {
  id: string
  agent: string
  profile?: string
  identity?: string
  channels?: ChannelStatus[]
  held?: { queued: number; reason: string }
  /** Detached sessions (`gild spawn --detach`) only. */
  detached?: true
  viewers?: number
  interactive?: boolean
  cols?: number
  rows?: number
  log?: string
  cwd: string
  pid: number
  childPid: number
  started: string
}
export const MAX_MESSAGE_BYTES = 64 * 1024
export const sessionsDirectory = () => join(homedir(), '.gild', 'sessions')

export function socketPath(id: string, directory = sessionsDirectory()) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(id))
    throw new Error(
      'Session name must be 1–32 letters, digits, underscores or hyphens',
    )
  const path = join(directory, id + '.sock')
  if (Buffer.byteLength(path) > 103)
    throw new Error('Session socket path is too long for a Unix socket')
  return path
}
export function requireUnix() {
  if (process.platform === 'win32')
    throw new Error('Local agent sessions are not supported on Windows in v1')
}
export async function privateSessionsDirectory() {
  requireUnix()
  const directory = sessionsDirectory()
  for (const path of [join(homedir(), '.gild'), directory]) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const info = await lstat(path)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid!()
    )
      throw new Error(`Unsafe session directory: ${path}`)
    await chmod(path, 0o700)
  }
  return directory
}
export interface SyncSummary {
  written: number
  deleted: number
  rejected: number
  conflicts: { path: string; reason: string; saved?: string }[]
}
export function localRequest(
  path: string,
  request: { type: 'sync' },
  timeoutMs?: number,
): Promise<SyncSummary>
export function localRequest(
  path: string,
  request: { type: 'info' } | { type: 'send'; message: string },
  timeoutMs?: number,
): Promise<LocalSession | { queued: true }>
export function localRequest(
  path: string,
  request:
    { type: 'info' } | { type: 'send'; message: string } | { type: 'sync' },
  timeoutMs = 3000,
): Promise<LocalSession | { queued: true } | SyncSummary> {
  const data = JSON.stringify(request) + '\n'
  if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES)
    return Promise.reject(new Error('Message exceeds 64 KiB'))
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let response = ''
    const fail = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () =>
      fail(new Error('Session did not respond')),
    )
    socket.on('error', fail)
    socket.on('connect', () => socket.write(data))
    socket.on('data', (chunk: string) => {
      response += chunk
      if (Buffer.byteLength(response) > MAX_MESSAGE_BYTES)
        return fail(new Error('Invalid session response'))
      if (!response.includes('\n')) return
      try {
        const result = JSON.parse(response.slice(0, response.indexOf('\n')))
        socket.destroy()
        if (result.error) reject(new Error(result.error))
        else resolve(result)
      } catch {
        fail(new Error('Invalid session response'))
      }
    })
    socket.on('end', () => fail(new Error('Session closed without a response')))
  })
}
export async function liveSessions(): Promise<LocalSession[]> {
  const directory = await privateSessionsDirectory()
  const sessions: LocalSession[] = []
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith('.sock')) continue
    const path = join(directory, entry)
    const socket = await lstat(path).catch(() => null)
    if (!socket?.isSocket()) continue
    try {
      const result = await localRequest(path, { type: 'info' })
      if ('id' in result) sessions.push(result)
    } catch (error) {
      if (!(await removeDeadSocket(path, error, socket))) throw error
    }
  }
  return sessions.sort((a, b) => a.started.localeCompare(b.started))
}

/** Probe first; unlink only a refused socket whose inode still belongs to that probe. */
export async function removeDeadSocket(
  path: string,
  error?: unknown,
  socket?: Awaited<ReturnType<typeof lstat>>,
) {
  socket ??= await lstat(path).catch(() => undefined)
  if (!socket?.isSocket()) return false
  if (!error) {
    try {
      await localRequest(path, { type: 'info' })
      return false
    } catch (probeError) {
      error = probeError
    }
  }
  const code = (error as NodeJS.ErrnoException).code
  if (code !== 'ECONNREFUSED' && code !== 'ENOENT') return false
  const current = await lstat(path).catch(() => undefined)
  if (!current) return true
  if (current.ino !== socket.ino || current.dev !== socket.dev) return false
  await unlink(path)
  return true
}
