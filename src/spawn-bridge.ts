import { shellQuote } from './spawn-adapters/types'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { GildClient } from './api/client'
import { tailEvents, waitForEvents } from './events-tail'
import { parseTrigger, type AgentTrigger } from './agent-profiles'
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
      type: 'trigger'
      stage: MentionStage
      session: string
      repo: string
      /** The spec that fired, e.g. issues.labeled:triage. */
      trigger: string
      event: string
      action: string
      /** Stream event id; namespaced before persisting. */
      id: string
      number?: number
      title?: string
      label?: string
      actor: string
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
  channel: z.string().optional(),
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

// GitHub-shaped webhook payloads (gild-site lib/events/payloads.ts). Only the
// fields a trigger needs are parsed; everything else passes through unseen.
const subject = z.object({
  number: z.number(),
  title: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  user: z.object({ login: z.string() }).optional(),
  head: z.object({ ref: z.string() }).optional(),
})
const triggerPayload = z.object({
  action: z.string().optional(),
  sender: z.object({ login: z.string() }).optional(),
  label: z.object({ name: z.string() }).optional(),
  issue: subject.optional(),
  pull_request: subject.optional(),
})
type TriggerPayload = z.output<typeof triggerPayload>

const SEEN_LIMIT = 500

/** One short prompt; the agent reads the channel history itself. */
export function mentionPrompt(
  repo: string,
  label: string,
  m: Mention,
  gild = 'gild',
) {
  const { cursor, body, author } = m.message
  const channel = m.channel || repo.split('/')[1],
    selection = m.channel
      ? ` --channel ${/^[A-Za-z0-9_./-]+$/.test(m.channel) ? m.channel : shellQuote(m.channel)}`
      : ''
  return [
    `[gild] @${author.name} mentioned you in ${repo} #${channel} (message ${cursor}):`,
    body,
    `Context: ${gild} chat history ${repo}${selection} --agent ${label} --before ${Number(cursor) + 1} --limit 30`,
    `Reply:   ${gild} chat send ${repo}${selection} --agent ${label} --reply-to ${cursor} "<your reply>"`,
    `Work notes: ${gild} chat note ${repo}${selection} --agent ${label} "<progress, decisions, blockers or tests>" (never notifies).`,
    MENTION_ETIQUETTE,
    workflowPrompt(repo, label, gild),
  ].join('\n')
}

/** Every @tag wakes that agent, so a courtesy tag ("@bob says 42") makes it
 * answer again and two agents can ping-pong. The rehearsal on 10 Oct did. */
export const MENTION_ETIQUETTE =
  'Note:    an @tag wakes that agent. Tag only whoever must act next; name others without @. If this needs nothing from you, do not reply.'

/** One short prompt per fired trigger; names the read and hand-off commands. */
export function triggerPrompt(
  repo: string,
  trigger: AgentTrigger,
  issue: { number: number; title: string },
  actor: string,
  label: string | undefined,
  gild: string,
  agent: string,
) {
  const kind =
    trigger.event === 'pull_request'
      ? 'pull request'
      : trigger.event === 'issue_comment'
        ? 'issue comment'
        : 'issue'
  const what = label ? `${trigger.action} ${label}` : trigger.action
  return [
    `[gild] ${kind} #${issue.number} "${issue.title}" ${what} in ${repo} by ${actor}`,
    `Read:  ${gild} ${trigger.event === 'pull_request' ? 'pr' : 'issue'} view ${repo}#${issue.number} --agent ${agent}`,
    `Post:  ${gild} chat send ${repo} --agent ${agent} "@<agent> <message>"`,
    workflowPrompt(repo, agent, gild),
  ].join('\n')
}

function workflowPrompt(repo: string, agent: string, gild: string) {
  return `Work: ${gild} clone ${repo} --agent ${agent}; git switch -c <branch>, commit, push; ${gild} issue create|comment|close|label and ${gild} pr create|list|view|diff|checks|comment|review|merge. Use --agent ${agent} on every forge command; reads support --json.`
}

type Saved = { cursors: Record<string, string>; delivered: string[] }
const savedSchema = z.object({
  cursors: z.record(z.string(), z.string()).default({}),
  delivered: z.array(z.string()).default([]),
})

type StreamRecord = {
  id: string
  cursor: string
  event: string
  payload: unknown
}
type Trigger = { spec: string } & AgentTrigger

/** Turns `channel.mention` events and profile triggers for one agent into
 * queued prompts, once each, over the same events subscription. */
export class MentionBridge {
  readonly channels: ChannelStatus[]
  private readonly watched: ChannelStatus[]
  private saved: Saved = { cursors: {}, delivered: [] }
  private readonly seen = new Set<string>()
  private readonly inflight = new Map<string, number>()
  private readonly head = new Map<string, string>()
  private readonly triggers: Trigger[]
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
      /** More repos to read events from without delivering their mentions. */
      watch?: string[]
      /** Sees every page of every repo before mentions are handled. */
      observe?: (
        repo: string,
        events: { event: string; payload: unknown }[],
      ) => void
      /** Trigger specs from the profile (`--on`), matched on the same repos. */
      triggers?: string[]
      file: string
      enqueue: (text: string, typed: () => void) => void
      emit: (event: BridgeEvent) => void
      pause?: typeof waitForEvents
    },
  ) {
    this.channels = opts.repos.map((repo) => ({ repo, state: 'connecting' }))
    const own = new Set(opts.repos.map((r) => r.toLowerCase()))
    this.watched = [...new Set(opts.watch ?? [])]
      .filter((repo) => !own.has(repo.toLowerCase()))
      .map((repo) => ({ repo, state: 'connecting' }))
    this.triggers = (opts.triggers ?? [])
      .map((spec) => ({ spec, ...parseTrigger(spec) }))
      .filter((t): t is Trigger => t.event !== undefined)
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
    await Promise.all(
      [...this.channels, ...this.watched].map((channel) =>
        this.run(channel, signal),
      ),
    )
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
  private stageTrigger(
    stage: MentionStage,
    repo: string,
    t: {
      spec: string
      event: string
      action: string
      id: string
      number?: number
      title?: string
      label?: string
      actor: string
    },
    error?: string,
  ) {
    this.opts.emit({
      type: 'trigger',
      stage,
      session: this.opts.session,
      repo,
      trigger: t.spec,
      event: t.event,
      action: t.action,
      id: t.id,
      ...(t.number !== undefined ? { number: t.number } : {}),
      ...(t.title !== undefined ? { title: t.title } : {}),
      ...(t.label !== undefined ? { label: t.label } : {}),
      actor: t.actor,
      ts: new Date().toISOString(),
      ...(error ? { error } : {}),
    })
  }
  private async page(
    channel: ChannelStatus,
    page: { events: StreamRecord[]; cursor: string },
  ) {
    this.set(channel, 'listening')
    const repo = channel.repo
    this.opts.observe?.(repo, page.events)
    if (this.watched.includes(channel)) return this.save(repo, page.cursor)
    for (const event of page.events) {
      if (event.event === 'channel.mention') this.mention(repo, event)
      else {
        const payload = triggerPayload.safeParse(event.payload)
        const branch = payload.success
          ? payload.data.pull_request?.head?.ref
          : undefined
        if (
          branch &&
          payload.success &&
          this.matchTrigger(event.event, payload.data)
        ) {
          const [owner, name] = repo.split('/')
          const list = await this.opts.client.request('channelList', {
            owner,
            repo: name,
          })
          const member = list.channels
            .find((c) => (c.key ?? c.name) === branch)
            ?.members.some((p) => p.name === this.opts.agent)
          const coordinator = list.channels
            .find(
              (c) => c.key === '' || (c.key === undefined && c.name === name),
            )
            ?.members.some(
              (p) =>
                p.name === this.opts.agent &&
                (p.prefix === '%' || p.prefix === '@'),
            )
          if (
            !member &&
            !coordinator &&
            payload.data.pull_request?.user?.login !== this.opts.agent
          )
            continue
        }
        this.trigger(repo, event)
      }
    }
    this.head.set(repo, page.cursor)
    // A cursor may only pass an enqueued prompt once it has been typed, so a
    // crash replays it; delivered ids keep typed ones from repeating.
    if (!this.inflight.get(repo)) this.save(repo, page.cursor)
  }
  private mention(repo: string, record: StreamRecord) {
    const parsed = mention.safeParse(record.payload)
    if (!parsed.success) return
    const m = parsed.data
    // The server already addresses mentions; still never type someone else's.
    if (
      m.agent.toLowerCase() !== this.opts.agent.toLowerCase() ||
      m.repository.full_name.toLowerCase() !== repo.toLowerCase() ||
      this.seen.has(m.message.id)
    )
      return
    this.seen.add(m.message.id)
    this.stage('received', repo, m)
    this.inflight.set(repo, (this.inflight.get(repo) ?? 0) + 1)
    try {
      this.opts.enqueue(
        mentionPrompt(repo, this.opts.label, m, this.opts.gild),
        () => {
          this.stage('delivered', repo, m)
          this.settle(repo, m.message.id)
        },
      )
      this.stage('queued', repo, m)
    } catch (error) {
      // A full queue drops this mention; say so rather than lose it silently.
      this.seen.delete(m.message.id)
      this.inflight.set(repo, this.inflight.get(repo)! - 1)
      this.stage('failed', repo, m, (error as Error).message)
    }
  }
  private matchTrigger(
    event: string,
    p: TriggerPayload,
  ): (Trigger & { labelHit?: string }) | null {
    for (const t of this.triggers) {
      if (t.event !== event || t.action !== p.action) continue
      // `labeled`/`unlabeled` carry the label on the event itself; other
      // actions match against the subject's current labels.
      if (t.label !== undefined) {
        const names =
          t.action === 'labeled' || t.action === 'unlabeled'
            ? [p.label?.name]
            : ((p.issue ?? p.pull_request)?.labels.map((l) => l.name) ?? [])
        if (!names.includes(t.label)) continue
      }
      return { ...t, labelHit: t.label ?? p.label?.name }
    }
    return null
  }
  private trigger(repo: string, record: StreamRecord) {
    if (!this.triggers.length) return
    const parsed = triggerPayload.safeParse(record.payload)
    if (!parsed.success) return
    const p = parsed.data
    const match = this.matchTrigger(record.event, p)
    if (!match) return
    const subject = p.issue ?? p.pull_request
    // Events without a subject (push, workflow_run) name no issue to read.
    if (!subject) return
    // Namespaced so a trigger id can never collide with a mention message id.
    const key = `trigger:${record.id}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    const t = {
      spec: match.spec,
      event: match.event,
      action: match.action,
      id: record.id,
      number: subject.number,
      title: subject.title,
      actor: p.sender?.login ?? 'someone',
      ...(match.labelHit !== undefined ? { label: match.labelHit } : {}),
    }
    this.stageTrigger('received', repo, t)
    this.inflight.set(repo, (this.inflight.get(repo) ?? 0) + 1)
    try {
      this.opts.enqueue(
        triggerPrompt(
          repo,
          match,
          subject,
          t.actor,
          match.labelHit,
          this.opts.gild ?? 'gild',
          this.opts.label,
        ),
        () => {
          this.stageTrigger('delivered', repo, t)
          this.settle(repo, key)
        },
      )
      this.stageTrigger('queued', repo, t)
    } catch (error) {
      this.seen.delete(key)
      this.inflight.set(repo, this.inflight.get(repo)! - 1)
      this.stageTrigger('failed', repo, t, (error as Error).message)
    }
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
