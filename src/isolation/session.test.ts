import { expect, test } from 'bun:test'
import {
  GUEST_PROTOCOL,
  GuestProtocolError,
  REBUILD_HINT,
  checkGuestProtocol,
  guestPing,
  guestPty,
  type Channel,
  type Opener,
} from './session'

test('guest PTY retains early literal bytes and exit, and serves multiple data observers', async () => {
  let data!: (bytes: Buffer) => void
  const reply = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value)),
      head = Buffer.alloc(4)
    head.writeUInt32BE(bytes.length)
    data(Buffer.concat([head, bytes]))
  }
  const early = Buffer.from([0, 255, 65, 10])
  const channel: Channel = {
    onData: (cb) => {
      data = cb
    },
    onClose() {},
    close() {},
    write() {
      reply({ t: 'out', d: early.toString('base64') })
    },
  }
  const pty = await guestPty(async () => channel, {
    argv: ['/bin/sh'],
    env: {},
    cwd: '/workspace',
    cols: 80,
    rows: 24,
  })
  const primary: Buffer[] = [],
    secondary: Buffer[] = [],
    exits: number[] = []
  pty.onData((bytes) => primary.push(bytes))
  pty.onData((bytes) => secondary.push(bytes))
  reply({ t: 'out', d: Buffer.from('live bytes').toString('base64') })
  reply({ t: 'exit', code: 7 })
  pty.onExit((code) => exits.push(code))
  expect(Buffer.concat(primary)).toEqual(
    Buffer.concat([early, Buffer.from('live bytes')]),
  )
  expect(Buffer.concat(secondary).toString()).toBe('live bytes')
  expect(exits).toEqual([7])
  reply({ t: 'exit', code: 0 })
  expect(exits).toEqual([7])
})

test('guest PTY bounds startup output and reports failure instead of silent truncation', async () => {
  let data!: (bytes: Buffer) => void
  let closed = false
  const body = Buffer.from(
    JSON.stringify({
      t: 'out',
      d: Buffer.alloc(256 * 1024 + 1).toString('base64'),
    }),
  )
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  const pty = await guestPty(
    async () => ({
      onData: (cb) => {
        data = cb
      },
      onClose() {},
      close() {
        closed = true
      },
      write() {
        data(Buffer.concat([head, body]))
      },
    }),
    { argv: ['/bin/sh'], env: {}, cwd: '/workspace', cols: 80, rows: 24 },
  )
  let output = ''
  let code: number | undefined
  pty.onData((bytes) => (output += bytes.toString()))
  pty.onExit((value) => (code = value))
  expect(closed).toBe(true)
  expect(code).toBe(1)
  expect(output).toContain('startup output exceeds')
})

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
