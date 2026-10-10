import { expect, test } from 'bun:test'
import { unlink } from 'node:fs/promises'
import { cli, fixture, startCLI } from './test-cli'

type Message = {
  cursor: string
  id: string
  created_at: string
  reply_to: string | null
  author: { name: string; kind: 'human' | 'agent' }
  kind: 'message' | 'note'
  body: string
  link: null
}
/** In-process stand-in for the repo channel routes of gild-site#55. */
function forge(tokens: string[], anonymousRead = false) {
  const log: Message[] = []
  const seen: { path: string; auth: string | null; body?: unknown }[] = []
  const sockets = new Set<{ send(data: string): void }>()
  const post = (name: string, body: string, reply_to: string | null = null) => {
    const message: Message = {
      cursor: String(log.length + 1),
      id: `id${log.length + 1}`,
      created_at: '2026-10-09T10:00:00.000Z',
      reply_to,
      author: { name, kind: name.includes('/') ? 'agent' : 'human' },
      kind: 'message',
      body,
      link: null,
    }
    log.push(message)
    for (const socket of sockets)
      socket.send(JSON.stringify({ type: 'message', message }))
    return message
  }
  const handler = async (request: Request, server: Bun.Server<unknown>) => {
    const url = new URL(request.url)
    const auth = request.headers.get('authorization')
    seen.push({ path: url.pathname + url.search, auth })
    // A public channel: GETs (and the stream) need no credentials at all.
    const publicRead =
      anonymousRead &&
      auth === null &&
      request.method === 'GET' &&
      url.pathname.startsWith('/api/v1/repos/owner/demo/')
    if (!publicRead && !tokens.some((t) => auth === `Bearer ${t}`))
      return Response.json({ message: 'Bad credentials' }, { status: 401 })
    if (url.pathname === '/api/v1/repos/owner/demo/channel/stream')
      return server.upgrade(request, {
        data: { after: url.searchParams.get('after') },
      })
        ? undefined
        : new Response('upgrade required', { status: 426 })
    if (url.pathname === '/api/v1/repos/owner/demo/channels')
      return Response.json({
        channels: [
          { name: 'demo', archived: false, unread: 0, members: [] },
          { name: 'bob/topic', archived: false, unread: 3, members: [] },
          { name: 'old', archived: true, unread: 0, members: [] },
        ],
      })
    if (url.pathname === '/api/v1/repos/owner/demo/channel/participants')
      return Response.json({
        participants: [
          {
            name: 'sami',
            kind: 'human',
            prefix: '@',
            sponsor: null,
            scopes: [],
            online: true,
          },
          {
            name: 'alice/test',
            kind: 'agent',
            prefix: '+',
            sponsor: 'alice',
            scopes: ['channel:write'],
            online: false,
            state: null,
          },
        ],
        can_post: true,
        viewer: 'sami',
      })
    if (url.pathname !== '/api/v1/repos/owner/demo/channel/messages')
      return Response.json({ message: 'nope' }, { status: 404 })
    if (request.method === 'POST') {
      const body = (await request.json()) as {
        body: string
        reply_to?: string
        kind?: 'message' | 'note'
      }
      seen.at(-1)!.body = body
      const agent = auth === 'Bearer gf_agentfixture'
      // gild-site#55: agents post unprompted; @name in the body wakes them.
      const message = post(
        agent ? 'alice/test' : 'sami',
        body.body,
        body.reply_to ?? null,
      )
      message.kind = body.kind ?? 'message'
      return Response.json(message, { status: 201 })
    }
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const before = url.searchParams.get('before'),
      after = url.searchParams.get('after')
    if (before && after)
      return Response.json(
        { message: 'Use before or after, not both' },
        { status: 400 },
      )
    const rows = after
      ? log.filter((m) => +m.cursor > +after).slice(0, limit)
      : log.filter((m) => !before || +m.cursor < +before).slice(-limit)
    return Response.json({
      messages: rows,
      cursor: String(log.length),
      before: rows.length && +rows[0].cursor > 1 ? rows[0].cursor : null,
      after:
        rows.length && +rows.at(-1)!.cursor < log.length
          ? rows.at(-1)!.cursor
          : null,
    })
  }
  return { log, seen, sockets, post, handler }
}

async function setup(
  tokens = ['gf_fixturetoken', 'gf_agentfixture'],
  anonymousRead = false,
) {
  const state = forge(tokens, anonymousRead)
  const f = await fixture(() => new Response())
  // The shared fixture owns its server; chat needs websockets, so run our own.
  const server = Bun.serve<{ after: string | null }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, s) => state.handler(request, s as never),
    websocket: {
      open(ws) {
        state.sockets.add(ws)
        const after = ws.data.after
        ws.send(
          JSON.stringify({
            type: 'ready',
            messages: state.log.filter((m) => !after || +m.cursor > +after),
          }),
        )
      },
      close(ws) {
        state.sockets.delete(ws)
      },
      message() {},
    },
  })
  const origin = server.url.origin
  await f.identity({ server: origin, token: 'gf_fixturetoken' })
  await f.agent()
  const agentFile = Bun.file(`${f.root}/agents/test.json`)
  await Bun.write(
    agentFile,
    (await agentFile.text()).replace(
      /"server":"[^"]*"/,
      `"server":"${origin}"`,
    ),
  )
  return {
    ...state,
    root: f.root,
    origin,
    async close() {
      server.stop(true)
      await f.close()
    },
  }
}

test('history prints readable lines, pages with --before, emits JSON, rejects before+after', async () => {
  const s = await setup()
  try {
    for (let i = 1; i <= 5; i++) s.post('sami', `line ${i}\nsecond`)
    const page = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--limit',
      '2',
      '--server',
      s.origin,
    ])
    expect(page.code).toBe(0)
    expect(page.out.trim().split('\n')).toEqual([
      '4  2026-10-09T10:00:00.000Z  sami  line 4 ↵ second',
      '5  2026-10-09T10:00:00.000Z  sami  line 5 ↵ second',
    ])
    expect(page.err).toContain('--before 4')
    const older = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--limit',
      '2',
      '--before',
      '4',
      '--json',
      '--server',
      s.origin,
    ])
    expect(
      older.out
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).cursor),
    ).toEqual(['2', '3'])
    const newer = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--after',
      '4',
      '--server',
      s.origin,
    ])
    expect(newer.out.trim().split('\n')).toHaveLength(1)
    const both = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--before',
      '4',
      '--after',
      '1',
      '--server',
      s.origin,
    ])
    expect(both.code).toBe(1)
    expect(both.err).toContain('--before or --after, not both')
    expect(s.seen.every((r) => !r.path.includes('before=4&after'))).toBe(true)
    expect(
      (
        await cli(s.root, [
          'chat',
          'history',
          'owner/demo',
          '--limit',
          '500',
          '--server',
          s.origin,
        ])
      ).code,
    ).toBe(1)
  } finally {
    await s.close()
  }
})

test('send prints the cursor, passes reply_to, and an agent uses its own token without printing it', async () => {
  const s = await setup()
  try {
    s.post('sami', '@alice/test hello')
    const human = await cli(s.root, [
      'chat',
      'send',
      'owner/demo',
      'hi there',
      '--server',
      s.origin,
    ])
    expect(human).toMatchObject({ code: 0, out: '2\n', err: '' })
    expect(s.seen.at(-1)).toMatchObject({
      auth: 'Bearer gf_fixturetoken',
      body: { body: 'hi there' },
    })
    expect(
      (s.seen.at(-1)!.body as { reply_to?: string }).reply_to,
    ).toBeUndefined()
    // gild-site#55: an agent posts unprompted, e.g. to hand off with @bob.
    const unprompted = await cli(s.root, [
      'chat',
      'send',
      'owner/demo',
      '@bob take this',
      '--agent',
      'test',
    ])
    expect(unprompted).toMatchObject({ code: 0, out: '3\n', err: '' })
    expect(s.seen.at(-1)).toMatchObject({
      auth: 'Bearer gf_agentfixture',
      body: { body: '@bob take this' },
    })
    expect(s.log[2]).toMatchObject({
      reply_to: null,
      author: { name: 'alice/test', kind: 'agent' },
    })
    const reply = await cli(s.root, [
      'chat',
      'send',
      'owner/demo',
      'answer',
      '--agent',
      'test',
      '--reply-to',
      '1',
    ])
    expect(reply).toMatchObject({ code: 0, out: '4\n', err: '' })
    expect(s.seen.at(-1)).toMatchObject({
      auth: 'Bearer gf_agentfixture',
      body: { reply_to: '1' },
    })
    expect(s.log[3]).toMatchObject({
      reply_to: '1',
      author: { name: 'alice/test', kind: 'agent' },
    })
    for (const run of [human, unprompted, reply])
      expect(run.out + run.err).not.toContain('gf_')
    const stdin = await cli(
      s.root,
      ['chat', 'send', 'owner/demo', '-', '--server', s.origin],
      'from stdin',
    )
    expect(stdin.out).toBe('5\n')
  } finally {
    await s.close()
  }
})

test('participants lists who may be mentioned', async () => {
  const s = await setup()
  try {
    const run = await cli(s.root, [
      'chat',
      'participants',
      'owner/demo',
      '--agent',
      'test',
    ])
    expect(run.out.trim().split('\n')).toEqual([
      '@sami\thuman\tonline\t\t',
      '+alice/test\tagent\toffline\t\tchannel:write',
    ])
    expect(run.out + run.err).not.toContain('gf_')
  } finally {
    await s.close()
  }
})

async function lines(proc: ReturnType<typeof startCLI>, count: number) {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 10000
  while (
    text.split('\n').filter(Boolean).length < count &&
    Date.now() < deadline
  ) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  reader.releaseLock()
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}
test('raw streams channel frames in order, resumes from --since, never exits on its own', async () => {
  const s = await setup()
  try {
    s.post('sami', 'one')
    s.post('sami', 'two')
    const first = startCLI(s.root, [
      'chat',
      'raw',
      'owner/demo',
      '--agent',
      'test',
    ])
    const ready = (await lines(first, 1))[0]
    expect(ready.type).toBe('ready')
    expect(ready.messages.map((m: Message) => m.body)).toEqual(['one', 'two'])
    expect(s.seen.find((r) => r.path.includes('/stream'))!.auth).toBe(
      'Bearer gf_agentfixture',
    )
    expect(s.seen.map((r) => r.path).join()).not.toContain('gf_')
    await Bun.sleep(150)
    s.post('sami', 'three')
    s.post('sami', 'four')
    const live = await lines(first, 2)
    expect(live.map((f: { message: Message }) => f.message.body)).toEqual([
      'three',
      'four',
    ])
    expect(first.exitCode).toBeNull()
    first.kill('SIGINT')
    expect(await first.exited).not.toBeNull()
    const second = startCLI(s.root, [
      'chat',
      'raw',
      'owner/demo',
      '--since',
      '3',
      '--server',
      s.origin,
    ])
    const resumed = (await lines(second, 1))[0]
    expect(resumed.messages.map((m: Message) => m.body)).toEqual(['four'])
    expect(s.seen.at(-1)!.path).toContain('after=3')
    second.kill('SIGINT')
    await second.exited
  } finally {
    await s.close()
  }
}, 30000)

test('history, participants and raw read a public channel with no identity; send still needs one', async () => {
  const s = await setup(undefined, true)
  try {
    await unlink(`${s.root}/identity.json`)
    s.post('sami', 'public hello')
    const history = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--server',
      s.origin,
    ])
    expect(history).toMatchObject({
      code: 0,
      out: '1  2026-10-09T10:00:00.000Z  sami  public hello\n',
    })
    const participants = await cli(s.root, [
      'chat',
      'participants',
      'owner/demo',
      '--server',
      s.origin,
    ])
    expect(participants.code).toBe(0)
    expect(participants.out).toContain('@sami\thuman\tonline')
    const raw = startCLI(s.root, [
      'chat',
      'raw',
      'owner/demo',
      '--server',
      s.origin,
    ])
    const ready = (await lines(raw, 1))[0]
    expect(ready.messages.map((m: Message) => m.body)).toEqual(['public hello'])
    raw.kill('SIGINT')
    await raw.exited
    // No header at all, not "Bearer " with an empty token.
    expect(s.seen.length).toBeGreaterThanOrEqual(3)
    expect(s.seen.every((r) => r.auth === null)).toBe(true)
    const send = await cli(s.root, [
      'chat',
      'send',
      'owner/demo',
      'hi',
      '--server',
      s.origin,
    ])
    expect(send.code).toBe(1)
    expect(send.err).toContain('gild auth init')
    expect(s.log).toHaveLength(1)
    // A private channel refuses the anonymous reader and names the fix.
    const priv = await cli(s.root, [
      'chat',
      'history',
      'owner/secret',
      '--server',
      s.origin,
    ])
    expect(priv.code).toBe(1)
    expect(priv.err).toContain('Bad credentials')
    expect(priv.err).toContain('gild auth init')
  } finally {
    await s.close()
  }
}, 30000)

test('branch selectors reach every chat endpoint; notes and channel listing use their contract', async () => {
  const s = await setup()
  try {
    for (const args of [
      ['history', 'owner/demo'],
      ['participants', 'owner/demo'],
      ['send', 'owner/demo', 'context'],
      ['note', 'owner/demo', '@bob tests passed'],
    ]) {
      const run = await cli(s.root, [
        'chat',
        ...args,
        '--channel',
        'bob/topic',
        '--agent',
        'test',
      ])
      expect(run.code).toBe(0)
      expect(s.seen.at(-1)!.path).toContain('channel=bob%2Ftopic')
    }
    expect(s.log.at(-1)!.kind).toBe('note')
    expect(s.seen.at(-1)!.body).toMatchObject({
      kind: 'note',
      body: '@bob tests passed',
    })
    const buffers = await cli(s.root, [
      'chat',
      'channels',
      'owner/demo',
      '--agent',
      'test',
      '--json',
    ])
    expect(buffers.code).toBe(0)
    expect(
      JSON.parse(buffers.out).channels.map((c: any) => [
        c.name,
        c.archived,
        c.unread,
      ]),
    ).toEqual([
      ['demo', false, 0],
      ['bob/topic', false, 3],
      ['old', true, 0],
    ])
    const raw = startCLI(s.root, [
      'chat',
      'raw',
      'owner/demo',
      '--channel',
      'bob/topic',
      '--server',
      s.origin,
    ])
    await lines(raw, 1)
    expect(
      s.seen.find(
        (r) =>
          r.path.includes('/stream') && r.path.includes('channel=bob%2Ftopic'),
      ),
    ).toBeDefined()
    raw.kill('SIGINT')
    await raw.exited
  } finally {
    await s.close()
  }
}, 30000)
