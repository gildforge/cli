import { Command, InvalidArgumentError } from 'commander'
import { ApiRequestError, GildClient } from './api/client'
import { routes } from './api/contract'
import {
  channelCursor,
  channelName,
  type ChannelMessage,
} from './api/channel-contract'
import { tailEvents, waitForEvents } from './events-tail'

type ClientOptions = { agent?: string; server?: string; channel?: string }
/** `read` asks for a reader: with no identity it is anonymous (public
 *  channels accept anonymous readers, docs/channel/API.md). */
type Resolve = (opts: ClientOptions, read?: boolean) => Promise<GildClient>

/** A client that sends no Authorization header at all. A refusal names the
 *  fix, since only private channels refuse an anonymous reader. */
export function anonymousClient(baseURL: string, fetcher = fetch) {
  return new GildClient(baseURL, '', async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.delete('authorization')
    const res = await fetcher(input, { ...init, headers })
    if (![401, 403, 404].includes(res.status)) return res
    const message = await res
      .json()
      .then((d: { message?: string }) => d.message)
      .catch(() => undefined)
    return Response.json(
      {
        message: `${message ?? `HTTP ${res.status}`} (read anonymously; a private channel needs an identity: run \`gild auth init\`)`,
      },
      { status: res.status },
    )
  })
}

export function repoPair(value: string) {
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (!match) throw new InvalidArgumentError('Use owner/repo')
  return { owner: match[1], repo: match[2] }
}
function cursor(value: string) {
  if (!channelCursor.safeParse(value).success)
    throw new InvalidArgumentError('A cursor is a non-negative integer')
  return value
}
function branch(value: string) {
  if (!channelName.safeParse(value).success)
    throw new InvalidArgumentError('Use a valid Git branch name')
  return value
}
function limit(value: string) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 200)
    throw new InvalidArgumentError('limit must be an integer from 1 to 200')
  return number
}
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ↵ ')
export const historyLine = (m: ChannelMessage) =>
  [m.cursor, m.created_at, m.author.name, oneLine(m.body)].join('  ')

/** WebSocket frames, as the server sent them, until the signal aborts. */
export async function rawChannel(
  client: Pick<GildClient, 'baseURL' | 'token'>,
  repo: { owner: string; repo: string },
  since: string | undefined,
  signal: AbortSignal,
  output: (line: string) => void,
  error: (line: string) => void,
  pause: typeof waitForEvents = waitForEvents,
  pingEvery = 25000,
  channel?: string,
) {
  const route = routes.find((r) => r.id === 'channelStream')!
  let after = since,
    backoff = 500
  while (!signal.aborted) {
    const url = new URL(
      client.baseURL.replace(/\/$/, '').replace(/^http/, 'ws') +
        route.path
          .replace('{owner}', encodeURIComponent(repo.owner))
          .replace('{repo}', encodeURIComponent(repo.repo)),
    )
    if (channel) url.searchParams.set('channel', channel)
    if (after) url.searchParams.set('after', after)
    await new Promise<void>((resolve) => {
      // Bun accepts request headers here, which keeps the token out of the URL.
      const socket = new WebSocket(url, {
        headers: client.token
          ? { authorization: `Bearer ${client.token}` }
          : {},
      } as never)
      // The forge expires presence after 90 s; ping every 25 s (API.md).
      const ping = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('ping')
      }, pingEvery)
      const done = () => {
        clearInterval(ping)
        signal.removeEventListener('abort', stop)
        resolve()
      }
      const stop = () => {
        socket.close()
        done()
      }
      signal.addEventListener('abort', stop, { once: true })
      socket.onmessage = (event) => {
        const text = String(event.data)
        output(text)
        try {
          const frame = JSON.parse(text)
          const latest =
            frame.type === 'message'
              ? frame.message?.cursor
              : frame.type === 'ready'
                ? frame.messages?.at(-1)?.cursor
                : undefined
          if (typeof latest === 'string') after = latest
          backoff = 500
        } catch {}
      }
      socket.onerror = () => error('channel stream error; reconnecting')
      socket.onclose = done
    })
    if (!signal.aborted) {
      await pause(backoff, signal)
      backoff = Math.min(backoff * 2, 10000)
    }
  }
}

export function chatCommands(program: Command, resolve: Resolve) {
  const chat = program
    .command('chat')
    .description('read and post in a repository channel')
    .addHelpText(
      'after',
      `
Each command works as you, or as an approved agent with --agent <label>.

Two agents talking, end to end:
  1. gild agent add alice --runtime claude --dir ~/work/alice --channel owner/repo
     gild agent add bob   --runtime claude --dir ~/work/bob   --channel owner/repo
     (both need an approved identity: gild agent join <label> --sponsor <you>)
  2. gild spawn agent alice      # terminal 1
     gild spawn agent bob        # terminal 2
  3. gild chat send owner/repo "@alice ask @bob for the number"
  4. alice is woken with the mention, reads gild chat history, and replies in
     the channel with "@bob what is the number?"; bob is woken, replies with
     "@alice <number>", and alice is woken again.
Open the channel:  gild chat owner/repo   (an IRC-style terminal UI)
Watch it raw:  gild chat raw owner/repo
Where a mention is:  gild events alice   (mention: received, queued, delivered)

An agent posts like a person; @name in the body wakes that agent's bridge
(gild-site#55 lifted the reply-only rule).`,
    )
  const common = (command: Command) =>
    command
      .option(
        '--channel <branch>',
        'select a branch channel (default: repository)',
        branch,
      )
      .option('--agent <label>', 'use an approved agent token')
      .option(
        '--server <url>',
        'forge base URL (defaults to the joined server for agents)',
      )
  common(
    chat
      .command('channels <repo>')
      .description('list buffers, unread counts and members')
      .option('--json', 'print JSON'),
  ).action(async (target: string, opts: ClientOptions & { json?: boolean }) => {
    const d = await (
      await resolve(opts, true)
    ).request('channelList', repoPair(target))
    if (opts.json) return console.log(JSON.stringify(d))
    for (const c of d.channels)
      console.log(
        `#${c.name}\t${c.archived ? 'archived' : 'active'}\t${c.unread} unread\t${c.members.map((m) => m.prefix + m.name).join(', ')}`,
      )
  })
  common(
    chat
      .command('note <repo> <message>')
      .description('post progress or context without notifying anyone'),
  ).action(async (target: string, message: string, opts: ClientOptions) => {
    const posted = await (
      await resolve(opts)
    ).request(
      'channelPost',
      repoPair(target),
      { body: message, kind: 'note' },
      { channel: opts.channel },
    )
    console.log(posted.cursor)
  })
  common(
    chat
      .command('open [repo]', { isDefault: true })
      .description(
        'the channel as a full-screen IRC-style terminal UI (the default: gild chat owner/repo)',
      )
      .addHelpText(
        'after',
        `
Keys: Enter sends · Tab completes @nicks · PgUp/PgDn (or the wheel) scroll ·
F2 shows or hides participants · Ctrl-C quits.
A public channel opens read-only without an identity; NO_COLOR is honoured.`,
      ),
  ).action(async (target: string | undefined, opts: ClientOptions) => {
    if (!target) return chat.help()
    const params = repoPair(target)
    const client = await resolve(opts, true)
    const { runChatTui } = await import('./chat-tui')
    await runChatTui({ client, repo: params, channel: opts.channel })
  })
  common(
    chat
      .command('history <repo>')
      .description('print recent channel messages (cursor  time  author  body)')
      .option('--limit <n>', 'messages per page (1-200)', limit, 50)
      .option('--before <cursor>', 'messages older than this cursor', cursor)
      .option('--after <cursor>', 'messages newer than this cursor', cursor)
      .option('--json', 'one JSON message per line'),
  ).action(
    async (
      target: string,
      opts: ClientOptions & {
        limit: number
        before?: string
        after?: string
        json?: boolean
      },
    ) => {
      if (opts.before && opts.after)
        throw Error('Use --before or --after, not both')
      const params = repoPair(target)
      const page = await (
        await resolve(opts, true)
      ).request('channelMessages', params, undefined, {
        channel: opts.channel,
        limit: opts.limit,
        before: opts.before,
        after: opts.after,
      })
      for (const message of page.messages)
        console.log(opts.json ? JSON.stringify(message) : historyLine(message))
      if (!opts.json && page.before)
        console.error(
          `older: gild chat history ${target} --before ${page.before}`,
        )
    },
  )
  common(
    chat
      .command('send <repo> <message>')
      .description('post a message (use - to read stdin); prints its cursor')
      .option('--reply-to <cursor>', 'the message you answer', cursor),
  ).action(
    async (
      target: string,
      message: string,
      opts: ClientOptions & { replyTo?: string },
    ) => {
      if (message === '-') {
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
        message = Buffer.concat(chunks).toString('utf8')
      }
      const posted = await (
        await resolve(opts)
      ).request(
        'channelPost',
        repoPair(target),
        {
          body: message,
          reply_to: opts.replyTo,
        },
        { channel: opts.channel },
      )
      console.log(posted.cursor)
    },
  )
  common(
    chat
      .command('participants <repo>')
      .description('who is in the channel')
      .option('--json', 'print the server response as JSON'),
  ).action(async (target: string, opts: ClientOptions & { json?: boolean }) => {
    const result = await (
      await resolve(opts, true)
    ).request('channelParticipants', repoPair(target), undefined, {
      channel: opts.channel,
    })
    if (opts.json) return console.log(JSON.stringify(result))
    for (const p of result.participants)
      console.log(
        [
          `${p.prefix}${p.name}`,
          p.kind,
          p.online ? 'online' : 'offline',
          p.state?.status ?? '',
          p.scopes.join(','),
        ].join('\t'),
      )
  })
  common(
    chat
      .command('raw <repo>')
      .description(
        'stream every channel frame as raw JSON lines until Ctrl-C (as an agent, also its mention events)',
      )
      .option('--since <cursor>', 'resume after a channel cursor', cursor),
  ).action(async (target: string, opts: ClientOptions & { since?: string }) => {
    const params = repoPair(target)
    const client = await resolve(opts, true)
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    const out = (line: string) => console.log(line)
    try {
      await Promise.all([
        rawChannel(
          client,
          params,
          opts.since,
          controller.signal,
          out,
          (l) => console.error(l),
          undefined,
          undefined,
          opts.channel,
        ),
        opts.agent
          ? mentionEvents(client, target, controller.signal, out)
          : undefined,
      ])
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
  })
}

async function mentionEvents(
  client: GildClient,
  repo: string,
  signal: AbortSignal,
  output: (line: string) => void,
) {
  try {
    await tailEvents(
      client,
      {
        repo,
        raw: true,
        onPage: (page) => {
          for (const event of page.events)
            if (event.event === 'channel.mention') output(JSON.stringify(event))
        },
      },
      signal,
      () => {},
      () => {},
    )
  } catch (error) {
    if (!signal.aborted)
      console.error(
        error instanceof ApiRequestError
          ? `mention events stopped: ${error.message}`
          : String(error),
      )
  }
}
