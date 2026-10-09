import { expect, test } from 'bun:test'
import {
  GUEST_PROTOCOL,
  GuestProtocolError,
  checkGuestProtocol,
  guestPing,
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
  expect(message).toContain('bun run vm:image')
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
