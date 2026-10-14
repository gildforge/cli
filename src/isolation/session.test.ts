import { expect, test } from 'bun:test'
import {
  GUEST_PROTOCOL,
  GuestProtocolError,
  REBUILD_HINT,
  checkGuestProtocol,
  guestPing,
  guestPty,
  type Opener,
} from './session'

/** A guest agent that answers one ping with `reply`, framed as on vsock. */
function agentReplying(reply: unknown): Opener {
  return async () => {
    let data: (c: Buffer) => void = () => {}
    return {
      write() {
        const body = Buffer.from(JSON.stringify(reply))
        const head = Buffer.alloc(4)
        head.writeUInt32BE(body.length)
        queueMicrotask(() => data(Buffer.concat([head, body])))
      },
      onData: (cb) => (data = cb),
      onClose() {},
      close() {},
    }
  }
}

test('an agent from before the handshake is refused with the rebuild command', async () => {
  // gild-guest-agent 0.1.0 (the 0.6.0 rootfs) answers a ping with a bare ok.
  const hello = await guestPing(agentReplying({ t: 'ok' }))
  expect(hello).toEqual({ protocol: 1, agent: undefined })
  let error: unknown
  try {
    checkGuestProtocol(hello, '/images/rootfs.ext4')
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(GuestProtocolError)
  const message = (error as Error).message
  expect(message).toContain('/images/rootfs.ext4 is outdated')
  expect(message).toContain(`protocol 1, this gild needs ${GUEST_PROTOCOL}`)
  expect(message).toContain(REBUILD_HINT)
})

test('a newer agent is refused too, and a matching one passes', async () => {
  const newer = await guestPing(
    agentReplying({ t: 'ok', protocol: GUEST_PROTOCOL + 1, agent: '9.0.0' }),
  )
  expect(() => checkGuestProtocol(newer, '/r.ext4')).toThrow(
    /newer than this gild: its gild-guest-agent 9\.0\.0.*Update gild/,
  )
  const same = await guestPing(
    agentReplying({ t: 'ok', protocol: GUEST_PROTOCOL, agent: '0.2.0' }),
  )
  expect(same).toEqual({ protocol: GUEST_PROTOCOL, agent: '0.2.0' })
  expect(() => checkGuestProtocol(same, '/r.ext4')).not.toThrow()
})

test('sync-back needs protocol 2 or later (list and get)', () => {
  expect(GUEST_PROTOCOL).toBeGreaterThanOrEqual(2)
})

/** A guest agent whose pty prints `early` as soon as it starts; `say` and
 * `exit` drive it afterwards. */
function ptyAgent(early: string[]) {
  let data: (c: Buffer) => void = () => {}
  const framed = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value))
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length)
    return Buffer.concat([head, body])
  }
  const say = (c: string) =>
    data(framed({ t: 'out', d: Buffer.from(c).toString('base64') }))
  const opener: Opener = async () => ({
    // Replies arrive synchronously, before guestPty's caller can listen.
    write: () => early.forEach(say),
    onData: (cb) => (data = cb),
    onClose() {},
    close() {},
  })
  return { opener, say, exit: (code: number) => data(framed({ t: 'exit', code })) }
}
const request = {
  argv: ['bash'],
  env: {},
  cwd: '/workspace',
  cols: 80,
  rows: 24,
}

test('every guest pty listener gets the output, and the first one gets what came before it', async () => {
  const agent = ptyAgent(['EARLY '])
  const pty = await guestPty(agent.opener, request)
  // A detached session listens twice: the output log, then the quiet detector.
  const log: string[] = [],
    quiet: string[] = []
  pty.onData((d) => log.push(d.toString()))
  pty.onData((d) => quiet.push(d.toString()))
  agent.say('Linux (none) 5.10')
  expect(log.join('')).toBe('EARLY Linux (none) 5.10')
  expect(quiet.join('')).toBe('Linux (none) 5.10')
})

test('a guest pty exit before anyone listens is replayed to onExit', async () => {
  const agent = ptyAgent([])
  const pty = await guestPty(agent.opener, request)
  agent.exit(3)
  const codes: number[] = []
  pty.onExit((c) => codes.push(c))
  expect(codes).toEqual([3])
})
