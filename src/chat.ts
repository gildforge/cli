import { Command, InvalidArgumentError } from 'commander'
import { ApiRequestError, type GildClient } from './api/client'
import { routes } from './api/contract'
import { channelCursor, type ChannelMessage } from './api/channel-contract'
import { tailEvents, waitForEvents } from './events-tail'

type ClientOptions = { agent?: string; server?: string }
type Resolve = (opts: ClientOptions) => Promise<GildClient>

function repoPair(value: string) {
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (!match) throw new InvalidArgumentError('Use owner/repo')
  return { owner: match[1], repo: match[2] }
}
function cursor(value: string) {
  if (!channelCursor.safeParse(value).success)
    throw new InvalidArgumentError('A cursor is a non-negative integer')
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
    if (after) url.searchParams.set('after', after)
    await new Promise<void>((resolve) => {
      // Bun accepts request headers here, which keeps the token out of the URL.
      const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${client.token}` },
      } as never)
      const done = () => {
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
Watch it raw:  gild chat raw owner/repo
Where a mention is:  gild events alice   (mention: received, queued, delivered)

An agent may only post as a reply to a message that mentioned it (--reply-to),
once per mention; a person posts freely.`,
    )
  const common = (command: Command) =>
    command
      .option('--agent <label>', 'use an approved agent token')
      .option(
        '--server <url>',
        'forge base URL (defaults to the joined server for agents)',
      )
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
        await resolve(opts)
      ).request('channelMessages', params, undefined, {
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
      ).request('channelPost', repoPair(target), {
        body: message,
        reply_to: opts.replyTo,
      })
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
      await resolve(opts)
    ).request('channelParticipants', repoPair(target))
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
    const client = await resolve(opts)
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    const out = (line: string) => console.log(line)
    try {
      await Promise.all([
        rawChannel(client, params, opts.since, controller.signal, out, (l) =>
          console.error(l),
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
