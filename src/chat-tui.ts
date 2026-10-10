import { createInterface } from 'node:readline'
import type { GildClient } from './api/client'
import type {
  ChannelMessage,
  ChannelSummary,
  ChannelParticipant,
} from './api/channel-contract'
import { rawChannel } from './chat'
/** Buffers above users leave the full terminal width for the log, including on phones. */
export async function chatTUI(
  client: GildClient,
  repo: { owner: string; repo: string },
  initial?: string,
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error(
      'Interactive chat needs a terminal; use gild chat history or gild chat raw',
    )
  let selected = initial ?? repo.repo,
    channels: ChannelSummary[] = [],
    people: ChannelParticipant[] = [],
    messages: ChannelMessage[] = [],
    archived = false,
    controller = new AbortController(),
    generation = 0
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const safe = (text: string) =>
    text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\n/g, ' ↵ ')
  const paint = () => {
    const width = process.stdout.columns ?? 80,
      height = process.stdout.rows ?? 24
    const rows = [
      `${repo.owner}/${repo.repo}  #${selected}${archived ? ' (archived)' : ''}`,
      channels
        .map(
          (c) =>
            `${c.name === selected ? '>' : ' '}#${c.name}${c.unread ? ' [' + c.unread + ']' : ''}${c.archived ? ' (archived)' : ''}`,
        )
        .join('  '),
      people.map((p) => p.prefix + p.name).join('  '),
      '─'.repeat(width),
      ...messages
        .slice(-Math.max(1, height - 7))
        .map(
          (m) =>
            `${m.created_at.slice(11, 19)} ${m.kind === 'message' ? '' : '* '}${m.author.name}: ${m.body}`,
        ),
      '/channel <name> · /note <text> · /quit',
    ]
    process.stdout.write(
      '\x1b[2J\x1b[H' +
        rows.map((r) => safe(r).slice(0, width)).join('\n') +
        '\n',
    )
    input.setPrompt(`#${selected}> `)
    input.prompt(true)
  }
  const switchTo = async (name: string) => {
    const own = ++generation
    controller.abort()
    controller = new AbortController()
    selected = name
    const [page, roster, list] = await Promise.all([
      client.request('channelMessages', repo, undefined, { channel: name }),
      client.request('channelParticipants', repo, undefined, { channel: name }),
      client.request('channelList', repo),
    ])
    if (own !== generation) return
    messages = page.messages
    people = roster.participants
    channels = list.channels
    archived = !!channels.find((c) => c.name === name)?.archived
    paint()
    void rawChannel(
      client,
      repo,
      page.cursor,
      controller.signal,
      (line) => {
        if (own !== generation) return
        const frame = JSON.parse(line)
        if (frame.type === 'message') messages.push(frame.message)
        if (frame.type === 'ready') messages.push(...frame.messages)
        if (frame.type === 'presence' && frame.participants)
          people = frame.participants
        if (frame.type === 'archived') archived = true
        paint()
      },
      (line) => {
        process.stderr.write(safe(line) + '\n')
      },
      undefined,
      name,
    )
  }
  try {
    await switchTo(selected)
    for await (const line of input) {
      try {
        if (line === '/quit') break
        if (line.startsWith('/channel ')) {
          await switchTo(line.slice(9).trim().replace(/^#/, ''))
          continue
        }
        if (!line.trim()) continue
        if (archived) throw Error('Channel is archived')
        await client.request(
          'channelPost',
          repo,
          {
            body: line.startsWith('/note ') ? line.slice(6) : line,
            kind: line.startsWith('/note ') ? 'note' : 'message',
          },
          { channel: selected },
        )
      } catch (error) {
        process.stderr.write(safe(String(error)) + '\n')
        input.prompt(true)
      }
    }
  } finally {
    controller.abort()
    input.close()
  }
}
