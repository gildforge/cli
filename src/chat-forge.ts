// Test helper: an in-process stand-in for the repo channel routes of
// gild-site#55 (docs/channel/API.md there), shared by the chat tests.
import type { ChannelParticipant } from './api/channel-contract'
import { fixture } from './test-cli'

export type Message = {
  cursor: string
  id: string
  created_at: string
  reply_to: string | null
  author: { name: string; kind: 'human' | 'agent' }
  kind: 'message' | 'note' | 'system'
  body: string
  link: { href: string; label: string } | null
}
export const defaultParticipants = (): ChannelParticipant[] => [
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
]
function forge(tokens: string[], anonymousRead = false) {
  const log: Message[] = []
  const seen: {
    path: string
    method: string
    auth: string | null
    body?: unknown
  }[] = []
  const sockets = new Set<{ send(data: string): void }>()
  const state = { participants: defaultParticipants(), pings: 0 }
  const post = (
    name: string,
    body: string,
    reply_to: string | null = null,
    extra: Partial<Message> = {},
  ) => {
    const message: Message = {
      cursor: String(log.length + 1),
      id: `id${log.length + 1}`,
      created_at: '2026-10-09T10:00:00.000Z',
      reply_to,
      author: { name, kind: name.includes('/') ? 'agent' : 'human' },
      kind: 'message',
      body,
      link: null,
      ...extra,
    }
    log.push(message)
    for (const socket of sockets)
      socket.send(JSON.stringify({ type: 'message', message }))
    return message
  }
  const presence = (online: string[]) => {
    for (const socket of sockets)
      socket.send(JSON.stringify({ type: 'presence', online }))
  }
  const handler = async (request: Request, server: Bun.Server<unknown>) => {
    const url = new URL(request.url)
    const auth = request.headers.get('authorization')
    seen.push({ path: url.pathname + url.search, method: request.method, auth })
    // A public channel: GETs (and the stream) need no credentials at all.
    const publicRead =
      anonymousRead &&
      auth === null &&
      request.method === 'GET' &&
      url.pathname.startsWith('/api/v1/repos/owner/demo/')
    if (!publicRead && !tokens.some((t) => auth === `Bearer ${t}`))
      return Response.json({ message: 'Bad credentials' }, { status: 401 })
    const agent = auth === 'Bearer gf_agentfixture'
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
        participants: state.participants,
        can_post: auth !== null,
        viewer: auth === null ? null : agent ? 'alice/test' : 'sami',
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
  return { log, seen, sockets, state, post, presence, handler }
}

export async function setup(
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
      message(_ws, data) {
        if (String(data) === 'ping') state.state.pings++
      },
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
