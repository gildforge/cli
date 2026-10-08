import { test, expect } from 'bun:test'
import { tailEvents } from './events-tail'
import { ApiRequestError, GildClient } from './api/client'
import { fixture, cli, startCLI } from './test-cli'
const event = (cursor: string, payload: Record<string, unknown> = {}) => ({
  id: cursor,
  cursor,
  event: 'agent_request',
  repository: 'alice/demo',
  created_at: 'now',
  payload,
})

test('events tail paginates cursors, backs off empty and transient pages, and exits on abort', async () => {
  const received: (string | null)[] = [],
    delays: number[] = [],
    output: string[] = []
  const controller = new AbortController()
  const replies = [
    Response.json({ events: [event('one')], cursor: 'one' }),
    Response.json({ events: [], cursor: 'two' }),
    Response.json({ message: 'try later' }, { status: 503 }),
    new TypeError('network unavailable'),
    Response.json({ events: [], cursor: 'three' }),
    Response.json({ events: [event('four')], cursor: 'four' }),
  ]
  const client = new GildClient(
    'https://forge.test/api/v1',
    'fixture',
    async (req) => {
      received.push(new URL(String(req)).searchParams.get('since'))
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      if (!reply) {
        controller.abort()
        throw Error('aborted')
      }
      return reply
    },
  )
  await tailEvents(
    client,
    { since: 'start' },
    controller.signal,
    (line) => output.push(line),
    () => {},
    async (ms) => {
      delays.push(ms)
    },
  )
  expect(received).toEqual([
    'start',
    'one',
    'two',
    'two',
    'two',
    'three',
    'four',
  ])
  expect(delays).toEqual([500, 1000, 2000, 4000])
  expect(output.map((x) => JSON.parse(x).cursor)).toEqual(['one', 'four'])
})

test('events tail bounds retries and fails permanent errors', async () => {
  const controller = new AbortController(),
    delays: number[] = []
  const client = new GildClient(
    'https://forge.test/api/v1',
    'fixture',
    async () => Response.json({ message: 'rate limit' }, { status: 429 }),
  )
  await tailEvents(
    client,
    {},
    controller.signal,
    () => {},
    () => {},
    async (ms) => {
      delays.push(ms)
      if (delays.length === 8) controller.abort()
    },
  )
  expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000])
  const forbidden = new GildClient(
    'https://forge.test/api/v1',
    'fixture',
    async () => Response.json({ message: 'forbidden' }, { status: 403 }),
  )
  await expect(
    tailEvents(forbidden, {}, new AbortController().signal),
  ).rejects.toBeInstanceOf(ApiRequestError)
})

test('events tail uses joined server, rejects overrides, hides agent payloads unless raw and once prints cursor', async () => {
  let calls = 0
  let otherCalls = 0
  const other = await fixture(() => {
    otherCalls++
    return Response.json({ events: [], cursor: 'end' })
  })
  const f = await fixture((req) => {
    calls++
    expect(req.headers.get('authorization')).toBe('Bearer gf_agentfixture')
    const url = new URL(req.url)
    expect(url.pathname).toBe('/api/v1/events')
    expect(url.searchParams.get('wait')).toBe('0')
    expect(url.searchParams.get('since')).toBe('start')
    return Response.json({
      events: [
        event('end', {
          approveUrl: 'https://fixture.test/agents/approve/secret-url',
          token: 'gf_privatefixture',
          note: 'Bearer private',
        }),
      ],
      cursor: 'end',
    })
  })
  try {
    await f.agent()
    const mismatch = await cli(f.root, [
      'events',
      'tail',
      '--agent',
      'test',
      '--once',
      '--server',
      other.origin,
    ])
    expect(mismatch.code).toBe(1)
    expect(mismatch.err).toContain('server this agent joined')
    expect(calls).toBe(0)
    expect(otherCalls).toBe(0)
    const args = [
      'events',
      'tail',
      '--agent',
      'test',
      '--once',
      '--since',
      'start',
    ]
    const safe = await cli(f.root, args)
    expect(safe.code).toBe(0)
    expect(safe.err).toContain('cursor: end')
    expect(JSON.parse(safe.out).payload).toEqual({})
    expect(safe.out).not.toContain('secret-url')
    expect(safe.out).not.toContain('gf_privatefixture')
    const raw = await cli(f.root, [...args, '--raw'])
    expect(raw.code).toBe(0)
    expect(JSON.parse(raw.out).payload.token).toBe('gf_privatefixture')
    expect(calls).toBe(2)
  } finally {
    await f.close()
    await other.close()
  }
})

test('events tail retries transient errors with real delays and SIGTERM interrupts empty-page backoff', async () => {
  const times: number[] = []
  let pageReady!: () => void
  const ready = new Promise<void>((r) => (pageReady = r))
  const f = await fixture(() => {
    times.push(Date.now())
    if (times.length === 1)
      return Response.json({ message: 'temporary' }, { status: 503 })
    pageReady()
    return Response.json({ events: [], cursor: 'empty' })
  })
  let proc: ReturnType<typeof startCLI> | undefined
  try {
    await f.agent()
    proc = startCLI(f.root, ['events', 'tail', '--agent', 'test'])
    await Promise.race([
      ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('tail never retried')), 4000),
      ),
    ])
    expect(times.length).toBe(2)
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(450)
    const stopped = Date.now()
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
    expect(Date.now() - stopped).toBeLessThan(500)
    expect(await new Response(proc.stderr).text()).toBe('')
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM')
      await proc.exited
    }
    await f.close()
  }
})
