// One exec contract for every isolation backend (see guest-agent/src/main.rs).
// A backend only has to open a byte channel to the guest agent; the runner and
// spawn code talk to `Isolation` and never branch on the backend.
import type { Level } from './policy'
import shared from './guest-protocol.json'

/** The guest-agent wire protocol this CLI speaks; guest-agent/src/main.rs reads the same file. */
export const GUEST_PROTOCOL: number = shared.protocol
/** Where the guest image is rebuilt from; printed with every mismatch. */
export const REBUILD_HINT =
  'Rebuild the guest image from a gildforge/cli checkout at this gild version: `bun run vm:image` (docs/VM.md)'

export interface Channel {
  write(data: Uint8Array): void
  onData(cb: (chunk: Buffer) => void): void
  onClose(cb: (error?: Error) => void): void
  close(): void
}

export interface ExecOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
  /** One call per output line (stdout and stderr), already de-framed. */
  onLine: (line: string) => Promise<void>
}

export interface Isolation {
  readonly level: Level
  readonly backend: string
  /** What `gild status` and job logs print. */
  readonly label: string
  /** Host path of the job work directory -> where the guest sees it. */
  guestPath(hostPath: string): string
  put(hostPath: string, content: string, mode?: number): Promise<void>
  /** Run a step; resolves with its exit code (124 timeout, 130 cancelled). */
  exec(argv: string[], options: ExecOptions): Promise<number>
  /** Interactive program on a guest pty (spawn --vm). */
  pty?(request: PtyRequest): Promise<PtyHandle>
  /** Read the guest file tree (working-directory sync); backends without a copy omit it. */
  files?: GuestFiles
  /** Messages the guest initiates toward the host on a vsock port (hooks). */
  onGuestMessage?(port: number, handler: (message: any) => void): void
  close(): Promise<void>
}

/** One entry under a sync root, the same shape the guest agent's `list` op returns. */
export interface Entry {
  /** Path relative to the root, `/`-separated. */
  p: string
  /** `f` regular file, `d` directory, `l` symlink. */
  k: 'f' | 'd' | 'l'
  /** Permission bits (0 for symlinks). */
  m: number
  s?: number
  /** sha256 hex of the content (files). */
  h?: string
  /** Link target (symlinks). */
  t?: string
}

export interface GuestFiles {
  list(root: string): Promise<Entry[]>
  read(path: string): Promise<Buffer>
}

export interface PtyRequest {
  argv: string[]
  env: Record<string, string>
  cwd: string
  cols: number
  rows: number
}

export interface PtyHandle {
  write(data: Uint8Array | string): void
  resize(cols: number, rows: number): void
  onData(cb: (data: Buffer) => void): void
  onExit(cb: (code: number) => void): void
  /** Drop the connection: the guest hangs up the session. */
  close(): void
}

export type Opener = () => Promise<Channel>

const MAX_LINE = 32768

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

type Reply =
  | { t: 'out' | 'err'; d: string }
  | { t: 'entries'; e: Entry[] }
  | { t: 'exit'; code: number; timed_out: boolean }
  | { t: 'ok'; protocol?: number; agent?: string }
  | { t: 'error'; message: string }

/** Send one request and stream replies until `done` returns a value. */
function converse<T>(
  open: Opener,
  request: unknown,
  signal: AbortSignal | undefined,
  onReply: (r: Reply) => T | undefined | Promise<T | undefined>,
): Promise<T> {
  return new Promise<T>(async (resolve, reject) => {
    let ch: Channel
    try {
      ch = await open()
    } catch (e) {
      return reject(e)
    }
    let buf = Buffer.alloc(0),
      finished = false,
      chain = Promise.resolve()
    const end = (fn: () => void) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      fn()
      ch.close()
    }
    const abort = () => ch.close() // guest kills the step when the connection drops
    signal?.addEventListener('abort', abort, { once: true })
    ch.onData((chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0)
        const reply = JSON.parse(buf.subarray(4, 4 + n).toString()) as Reply
        buf = buf.subarray(4 + n)
        chain = chain.then(async () => {
          if (finished) return
          try {
            const out = await onReply(reply)
            if (out !== undefined) end(() => resolve(out))
          } catch (e) {
            end(() => reject(e))
          }
        })
      }
    })
    ch.onClose((error) => {
      chain = chain.then(() =>
        end(() => reject(error ?? new Error('guest connection closed early'))),
      )
    })
    ch.write(frame(request))
  })
}

export interface GuestHello {
  /** 1 for agents that predate the handshake (their ping reply has no number). */
  protocol: number
  agent?: string
}

export async function guestPing(open: Opener): Promise<GuestHello> {
  return converse<GuestHello>(open, { op: 'ping' }, undefined, (r) =>
    r.t === 'ok'
      ? {
          protocol: typeof r.protocol === 'number' ? r.protocol : 1,
          agent: r.agent,
        }
      : undefined,
  )
}

export class GuestProtocolError extends Error {}

/** Refuse a guest agent that speaks another protocol, at connect time and
 *  with the fix, instead of failing mid-session on an op it lacks. */
export function checkGuestProtocol(hello: GuestHello, image: string) {
  if (hello.protocol === GUEST_PROTOCOL) return
  const agent = `gild-guest-agent ${hello.agent ?? '(no version, before 0.2.0)'}`
  throw new GuestProtocolError(
    hello.protocol < GUEST_PROTOCOL
      ? `The guest image ${image} is outdated: its ${agent} speaks protocol ${hello.protocol}, this gild needs ${GUEST_PROTOCOL}. ${REBUILD_HINT}.`
      : `The guest image ${image} is newer than this gild: its ${agent} speaks protocol ${hello.protocol}, this gild speaks ${GUEST_PROTOCOL}. Update gild, or ${REBUILD_HINT.charAt(0).toLowerCase() + REBUILD_HINT.slice(1)}.`,
  )
}

export async function guestPut(
  open: Opener,
  path: string,
  content: string,
  mode = 0o600,
) {
  await converse<true>(
    open,
    { op: 'put', path, mode, content: Buffer.from(content).toString('base64') },
    undefined,
    (r) => {
      if (r.t === 'error') throw new Error(r.message)
      return r.t === 'ok' ? true : undefined
    },
  )
}

export function guestFiles(open: Opener): GuestFiles {
  return {
    async list(root) {
      const all: Entry[] = []
      await converse<true>(open, { op: 'list', root }, undefined, (r) => {
        if (r.t === 'error') throw new Error(r.message)
        if (r.t === 'entries') all.push(...r.e)
        return r.t === 'ok' ? true : undefined
      })
      return all
    },
    async read(path) {
      const parts: Buffer[] = []
      await converse<true>(open, { op: 'get', path }, undefined, (r) => {
        if (r.t === 'error') throw new Error(r.message)
        if (r.t === 'out') parts.push(Buffer.from(r.d, 'base64'))
        return r.t === 'ok' ? true : undefined
      })
      return Buffer.concat(parts)
    },
  }
}

export async function guestExec(
  open: Opener,
  argv: string[],
  o: ExecOptions,
): Promise<number> {
  if (o.signal.aborted) return 130
  const pending = { out: '', err: '' },
    decoders = { out: new TextDecoder(), err: new TextDecoder() }
  let failure: Error | undefined
  const feed = async (which: 'out' | 'err', data: Buffer) => {
    pending[which] += decoders[which].decode(data, { stream: true })
    let at: number
    while ((at = pending[which].indexOf('\n')) >= 0) {
      if (at > MAX_LINE) return tooLong(which)
      await o.onLine(pending[which].slice(0, at).replace(/\r$/, ''))
      pending[which] = pending[which].slice(at + 1)
    }
    if (pending[which].length > MAX_LINE) tooLong(which)
  }
  // Same rule as host steps: never emit the tail of an oversized line, it could
  // be half of a secret split across chunks.
  const tooLong = (which: 'out' | 'err') => {
    failure = new Error('output line exceeds 32 KiB')
    pending[which] = ''
    ctl.abort()
  }
  const ctl = new AbortController(),
    relay = () => ctl.abort()
  o.signal.addEventListener('abort', relay, { once: true })
  try {
    const code = await converse<number>(
      open,
      { op: 'exec', argv, env: o.env, cwd: o.cwd, timeout_ms: o.timeoutMs },
      ctl.signal,
      async (r) => {
        if (failure) return undefined
        if (r.t === 'out' || r.t === 'err') {
          await feed(r.t, Buffer.from(r.d, 'base64'))
          return undefined
        }
        if (r.t === 'error') throw new Error(r.message)
        if (r.t === 'exit') {
          for (const w of ['out', 'err'] as const) {
            pending[w] += decoders[w].decode()
            if (pending[w]) await o.onLine(pending[w])
          }
          if (r.timed_out)
            await o.onLine(
              `[gild: step timeout after ${o.timeoutMs / 60000} minutes]`,
            )
          return r.code
        }
        return undefined
      },
    ).catch((e) => {
      if (failure) throw failure
      if (o.signal.aborted) return 130
      throw e
    })
    if (failure) throw failure
    return code
  } finally {
    o.signal.removeEventListener('abort', relay)
  }
}

export async function guestPty(
  open: Opener,
  request: PtyRequest,
): Promise<PtyHandle> {
  const ch = await open()
  let buf = Buffer.alloc(0),
    exited = false,
    dataCb: (d: Buffer) => void = () => {},
    exitCb: (code: number) => void = () => {}
  const done = (code: number) => {
    if (exited) return
    exited = true
    exitCb(code)
  }
  ch.onData((chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0)
      const r = JSON.parse(buf.subarray(4, 4 + n).toString()) as Reply
      buf = buf.subarray(4 + n)
      if (r.t === 'out') dataCb(Buffer.from(r.d, 'base64'))
      else if (r.t === 'exit') done(r.code)
      else if (r.t === 'error') {
        dataCb(Buffer.from(`gild: ${r.message}\r\n`))
        done(127)
      }
    }
  })
  ch.onClose(() => done(129))
  ch.write(frame({ op: 'pty', ...request }))
  return {
    write: (d) =>
      ch.write(frame({ t: 'in', d: Buffer.from(d).toString('base64') })),
    resize: (cols, rows) => ch.write(frame({ t: 'resize', cols, rows })),
    onData: (cb) => (dataCb = cb),
    onExit: (cb) => (exitCb = cb),
    close: () => ch.close(),
  }
}

/** Read one length-prefixed JSON message from a connection the guest opened. */
export function readOneMessage(stream: {
  on(event: 'data', cb: (c: Buffer) => void): unknown
}): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    stream.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0))
        try {
          resolve(
            JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString()),
          )
        } catch (e) {
          reject(e)
        }
    })
  })
}
