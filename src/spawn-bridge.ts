import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { GildClient } from './api/client'
import { tailEvents, waitForEvents } from './events-tail'
import type { ChannelStatus } from './spawn-sessions'

/** The agent identity and server a session listens as. It reaches the worker
 * over IPC, never argv or env, the same rule spawn-report follows. */
export type BridgeTarget = { server: string; token: string; agent: string }

export type MentionStage = 'received' | 'queued' | 'delivered' | 'failed'
/** Local events-stream records. They never change the agent's busy/idle state. */
export type BridgeEvent =
  | {
      type: 'mention'
      stage: MentionStage
      session: string
      repo: string
      message: string
      id: string
      author: string
      ts: string
      error?: string
    }
  | {
      type: 'channel'
      session: string
      repo: string
      state: ChannelStatus['state']
      error?: string
      ts: string
    }

const mention = z.object({
  repository: z.object({ full_name: z.string() }),
  message: z.object({
    cursor: z.string(),
    id: z.string(),
    body: z.string(),
    author: z.object({ name: z.string() }),
  }),
  agent: z.string(),
})
type Mention = z.output<typeof mention>

const SEEN_LIMIT = 500

/** One short prompt; the agent reads the channel history itself. */
export function mentionPrompt(
  repo: string,
  label: string,
  m: Mention,
  gild = 'gild',
) {
  const { cursor, body, author } = m.message
  return [
    `[gild] @${author.name} mentioned you in ${repo} (message ${cursor}):`,
    body,
    `Context: ${gild} chat history ${repo} --agent ${label} --before ${Number(cursor) + 1} --limit 30`,
    `Reply:   ${gild} chat send ${repo} --agent ${label} --reply-to ${cursor} "<your reply>"`,
  ].join('\n')
}

type Saved = { cursors: Record<string, string>; delivered: string[] }
const savedSchema = z.object({
  cursors: z.record(z.string(), z.string()).default({}),
  delivered: z.array(z.string()).default([]),
})

/** Turns `channel.mention` events for one agent into queued prompts, once each. */
export class MentionBridge {
  readonly channels: ChannelStatus[]
  private saved: Saved = { cursors: {}, delivered: [] }
  private readonly seen = new Set<string>()
  private readonly inflight = new Map<string, number>()
  private readonly head = new Map<string, string>()
  private writing: Promise<void> = Promise.resolve()
  constructor(
    private readonly opts: {
      client: Pick<GildClient, 'request'>
      /** sponsor/label, as the server addresses the mention. */
      agent: string
      /** The local profile label used in `--agent <label>`. */
      label: string
      /** The gild that spawned this session; a `gild` on PATH may be older. */
      gild?: string
      session: string
      repos: string[]
      file: string
      enqueue: (text: string, typed: () => void) => void
      emit: (event: BridgeEvent) => void
      pause?: typeof waitForEvents
    },
  ) {
    this.channels = opts.repos.map((repo) => ({ repo, state: 'connecting' }))
  }
  async start(signal: AbortSignal) {
    try {
      this.saved = savedSchema.parse(
        JSON.parse(await readFile(this.opts.file, 'utf8')),
      )
    } catch {
      // No file yet, or an unreadable one: start from now rather than replay.
    }
    for (const id of this.saved.delivered) this.seen.add(id)
    await Promise.all(this.channels.map((channel) => this.run(channel, signal)))
  }
  private set(
    channel: ChannelStatus,
    state: ChannelStatus['state'],
    error?: string,
  ) {
    if (channel.state === state && channel.error === error) return
    channel.state = state
    if (error) channel.error = error
    else delete channel.error
    this.opts.emit({
      type: 'channel',
      session: this.opts.session,
      repo: channel.repo,
      state,
      ...(error ? { error } : {}),
      ts: new Date().toISOString(),
    })
  }
  private async run(channel: ChannelStatus, signal: AbortSignal) {
    try {
      await tailEvents(
        this.opts.client,
        {
          repo: channel.repo,
          since: this.saved.cursors[channel.repo],
          onPage: (page) => this.page(channel, page),
        },
        signal,
        () => {},
        () => {},
        this.opts.pause,
      )
    } catch (error) {
      // The agent keeps running; the failure is visible in status and events.
      if (!signal.aborted)
        this.set(
          channel,
          'error',
          error instanceof Error ? error.message : String(error),
        )
    }
  }
  private stage(stage: MentionStage, repo: string, m: Mention, error?: string) {
    this.opts.emit({
      type: 'mention',
      stage,
      session: this.opts.session,
      repo,
      message: m.message.cursor,
      id: m.message.id,
      author: m.message.author.name,
      ts: new Date().toISOString(),
      ...(error ? { error } : {}),
    })
  }
  private page(
    channel: ChannelStatus,
    page: {
      events: { event: string; cursor: string; payload: unknown }[]
      cursor: string
    },
  ) {
    this.set(channel, 'listening')
    const repo = channel.repo
    for (const event of page.events) {
      if (event.event !== 'channel.mention') continue
      const parsed = mention.safeParse(event.payload)
      if (!parsed.success) continue
      const m = parsed.data
      // The server already addresses mentions; still never type someone else's.
      if (
        m.agent.toLowerCase() !== this.opts.agent.toLowerCase() ||
        m.repository.full_name.toLowerCase() !== repo.toLowerCase() ||
        this.seen.has(m.message.id)
      )
        continue
      this.seen.add(m.message.id)
      this.stage('received', repo, m)
      this.inflight.set(repo, (this.inflight.get(repo) ?? 0) + 1)
      try {
        this.opts.enqueue(mentionPrompt(repo, this.opts.label, m, this.opts.gild), () => {
          this.stage('delivered', repo, m)
          this.settle(repo, m.message.id)
        })
        this.stage('queued', repo, m)
      } catch (error) {
        // A full queue drops this mention; say so rather than lose it silently.
        this.seen.delete(m.message.id)
        this.inflight.set(repo, this.inflight.get(repo)! - 1)
        this.stage('failed', repo, m, (error as Error).message)
      }
    }
    this.head.set(repo, page.cursor)
    // A cursor may only pass a mention once it has been typed, so a crash
    // replays queued prompts; delivered ids keep typed ones from repeating.
    if (!this.inflight.get(repo)) this.save(repo, page.cursor)
  }
  private settle(repo: string, id: string) {
    this.inflight.set(repo, this.inflight.get(repo)! - 1)
    this.saved.delivered = [...this.saved.delivered, id].slice(-SEEN_LIMIT)
    this.save(repo, this.inflight.get(repo) ? undefined : this.head.get(repo))
  }
  private save(repo: string, cursor?: string) {
    if (cursor) this.saved.cursors[repo] = cursor
    const text = JSON.stringify(this.saved)
    const partial = `${this.opts.file}.${process.pid}.tmp`
    this.writing = this.writing
      .then(async () => {
        await writeFile(partial, text, { mode: 0o600 })
        await rename(partial, this.opts.file)
      })
      .catch(() => {})
  }
  flush() {
    return this.writing
  }
}
