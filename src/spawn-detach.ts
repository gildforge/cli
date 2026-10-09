import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Socket } from 'node:net'

/** Worker side of `gild spawn --detach`: output kept while nobody watches,
 * and the viewers of `gild attach`. The terminal-facing client is spawn-attach.ts. */
export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 40
export const RING_BYTES = 256 * 1024
export const LOG_BYTES = 8 * 1024 * 1024
const MAX_VIEWER_BACKLOG = 1024 * 1024

/** The most recent PTY output, bounded; replayed to whoever attaches. */
export class OutputRing {
  private chunks: Buffer[] = []
  private size = 0
  constructor(private readonly limit = RING_BYTES) {}
  push(data: Buffer) {
    this.chunks.push(data)
    this.size += data.length
    while (this.size > this.limit) {
      const over = this.size - this.limit
      const first = this.chunks[0]
      if (first.length <= over) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(over)
        this.size -= over
      }
    }
  }
  snapshot() {
    return Buffer.concat(this.chunks)
  }
}

/** Append-only 0600 log; at the cap the file becomes `.1` (replacing the
 * previous one) and a new file starts, so disk use stays bounded. */
export class OutputLog {
  private fd: number | undefined
  private size = 0
  constructor(
    readonly path: string,
    private readonly cap = LOG_BYTES,
  ) {
    this.open()
  }
  private open() {
    this.fd = openSync(this.path, 'a', 0o600)
    fchmodSync(this.fd, 0o600)
    this.size = 0
  }
  write(data: Buffer) {
    if (this.fd === undefined) return
    try {
      if (data.length > this.cap) data = data.subarray(data.length - this.cap)
      if (this.size + data.length > this.cap) {
        closeSync(this.fd)
        renameSync(this.path, this.path + '.1')
        this.open()
      }
      for (let at = 0; at < data.length;)
        at += writeSync(this.fd!, data, at, data.length - at)
      this.size += data.length
    } catch {
      // A full disk must not take the agent down with it.
      this.close()
    }
  }
  close() {
    if (this.fd === undefined) return
    try {
      closeSync(this.fd)
    } catch {}
    this.fd = undefined
  }
}

type Viewer = { interactive: boolean; pending: string }
export type DetachedOptions = {
  cols: number
  rows: number
  ringBytes?: number
  logBytes?: number
  resize: (cols: number, rows: number) => void
  input: (data: Buffer) => void
}
const dimension = (value: unknown, fallback: number) =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1000
    ? (value as number)
    : fallback

export class DetachedHost {
  private readonly ring: OutputRing
  private readonly viewers = new Map<Socket, Viewer>()
  private log: OutputLog | undefined
  private directory: string | undefined
  constructor(private readonly options: DetachedOptions) {
    this.ring = new OutputRing(options.ringBytes)
  }
  /** Created after the agent adapter, which owns `mkdir` of this directory. */
  openLog(directory: string) {
    this.directory = directory
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    this.log = new OutputLog(
      join(directory, 'output.log'),
      this.options.logBytes,
    )
  }
  get info() {
    return {
      detached: true as const,
      viewers: this.viewers.size,
      interactive: [...this.viewers.values()].some((v) => v.interactive),
      cols: this.options.cols,
      rows: this.options.rows,
      ...(this.log ? { log: this.log.path } : {}),
    }
  }
  push(data: Buffer) {
    this.ring.push(data)
    this.log?.write(data)
    for (const socket of this.viewers.keys()) {
      if (socket.writableLength + data.length > MAX_VIEWER_BACKLOG)
        socket.destroy()
      else socket.write(data)
    }
  }
  has(socket: Socket) {
    return this.viewers.has(socket)
  }
  /** Replay and registration happen in one tick, so no byte is lost or doubled. */
  attach(socket: Socket, request: Record<string, unknown>) {
    const interactive = request.mode !== 'watch'
    if (request.mode !== 'watch' && request.mode !== 'interactive')
      throw new Error('Invalid attach mode')
    if (interactive && this.info.interactive)
      throw new Error(
        'Another viewer is attached interactively; use gild attach --watch',
      )
    socket.setTimeout(0)
    socket.write(
      JSON.stringify({
        attached: true,
        mode: request.mode,
        cols: this.options.cols,
        rows: this.options.rows,
      }) + '\n',
    )
    socket.write(this.ring.snapshot())
    this.viewers.set(socket, { interactive, pending: '' })
    socket.once('close', () => this.drop(socket))
    if (interactive)
      this.options.resize(
        dimension(request.cols, this.options.cols),
        dimension(request.rows, this.options.rows),
      )
  }
  /** Viewer frames are JSON lines: {t:'i',d:<base64 keystrokes>} or {t:'r',cols,rows}. */
  feed(socket: Socket, chunk: string) {
    const viewer = this.viewers.get(socket)
    if (!viewer) return
    viewer.pending += chunk
    if (viewer.pending.length > MAX_VIEWER_BACKLOG) return socket.destroy()
    for (let end; (end = viewer.pending.indexOf('\n')) >= 0;) {
      const line = viewer.pending.slice(0, end)
      viewer.pending = viewer.pending.slice(end + 1)
      let frame: { t?: string; d?: string; cols?: number; rows?: number }
      try {
        frame = JSON.parse(line)
      } catch {
        return socket.destroy()
      }
      if (!viewer.interactive) continue
      if (frame.t === 'i' && typeof frame.d === 'string')
        this.options.input(Buffer.from(frame.d, 'base64'))
      else if (frame.t === 'r')
        this.options.resize(
          dimension(frame.cols, this.options.cols),
          dimension(frame.rows, this.options.rows),
        )
    }
  }
  private drop(socket: Socket) {
    const viewer = this.viewers.get(socket)
    if (!viewer) return
    this.viewers.delete(socket)
    // Detaching returns the agent to the fixed size nobody is watching at.
    if (viewer.interactive)
      this.options.resize(this.options.cols, this.options.rows)
  }
  /** Hands the viewers over to be ended in order (see endSocket), not reset. */
  endViewers(): Socket[] {
    const sockets = [...this.viewers.keys()]
    this.viewers.clear()
    return sockets
  }
  /** Removes the log with the rest of the session's private files. */
  cleanup() {
    this.log?.close()
    if (this.directory) rmSync(this.directory, { recursive: true, force: true })
  }
}

/** The last line on the events stream of a session that has ended. */
export function exitLine(session: string, code: number) {
  return (
    JSON.stringify({
      session,
      type: 'exited',
      code,
      ts: new Date().toISOString(),
    }) + '\n'
  )
}
/** Ends a socket and resolves once its last bytes are written (or it died). */
export function endSocket(socket: Socket, last?: string) {
  return new Promise<void>((resolve) => {
    if (socket.destroyed || socket.writableFinished) return resolve()
    socket.once('finish', () => resolve())
    socket.once('close', () => resolve())
    socket.once('error', () => resolve())
    if (!socket.writableEnded) {
      if (last) socket.end(last)
      else socket.end()
    }
  })
}
export type StartMessage =
  { type: 'ready'; id: string } | { type: 'failed'; error: string }
/** The worker tells `gild spawn --detach` over IPC that it is ready, or why not. */
export function reportDetached(
  detach: unknown,
  message: StartMessage,
): Promise<void> {
  if (!detach || !process.send || !process.connected) return Promise.resolve()
  // Resolves once the message is handed to the IPC channel, so exiting right after cannot drop it.
  return new Promise((resolve) => {
    try {
      process.send!(message, undefined, undefined, () => resolve())
    } catch {
      resolve()
    }
  })
}
