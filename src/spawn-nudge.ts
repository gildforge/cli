import { z } from 'zod'
import type { AgentState } from './spawn-events'

/** Watchdog nudges: gild pokes a stalled spawned agent through the ordinary
 * injection queue. Rules come from the agent profile and `gild spawn --nudge`. */
export type NudgeRule =
  | {
      spec: string
      kind: 'idle'
      after: string
      ms: number
      limit?: number
      message?: string
    }
  | { spec: string; kind: 'waiting'; after: string; ms: number }
  | { spec: string; kind: 'ci'; repo: string }
  | { spec: string; kind: 'mention-unanswered'; after: string; ms: number }

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const durationText = z
  .string()
  .regex(/^[1-9][0-9]{0,6}[smhd]$/, 'Use a duration like 30s, 20m, 2h or 1d')
  .refine(
    (d) =>
      Number(d.slice(0, -1)) * UNITS[d.at(-1) as keyof typeof UNITS] <=
      7 * UNITS.d,
    'Durations are at most 7d',
  )
const ms = (d: string) =>
  Number(d.slice(0, -1)) * UNITS[d.at(-1) as keyof typeof UNITS]
const repoText = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use owner/repo')
const limitText = z
  .string()
  .regex(/^[1-9][0-9]{0,2}$/, 'A repeat limit is 1 to 999')
const messageText = z
  .string()
  .min(1)
  .max(400)
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s), 'Nudge messages are one line')

/** `idle:<duration>[:<limit>][:<message>]`, `waiting:<duration>`,
 * `ci:<owner/repo>`, `mention-unanswered:<duration>`. */
export const nudgeRule = z
  .string()
  .max(500)
  .transform((spec, ctx): NudgeRule => {
    const fail = (message: string) => {
      ctx.addIssue({ code: 'custom', message: `${message} (in "${spec}")` })
      return z.NEVER
    }
    const check = <T>(schema: z.ZodType<T>, value: string | undefined) => {
      const result = schema.safeParse(value)
      return result.success
        ? { ok: true as const, value: result.data }
        : { ok: false as const, error: result.error.issues[0].message }
    }
    const [kind, ...rest] = spec.split(':')
    if (kind === 'ci') {
      const repo = check(repoText, rest.join(':'))
      return repo.ok ? { spec, kind, repo: repo.value } : fail(repo.error)
    }
    if (kind !== 'idle' && kind !== 'waiting' && kind !== 'mention-unanswered')
      return fail(
        'Use idle:<duration>[:<limit>][:<message>], waiting:<duration>, ci:<owner/repo> or mention-unanswered:<duration>',
      )
    const after = check(durationText, rest.shift())
    if (!after.ok) return fail(after.error)
    if (kind !== 'idle')
      return rest.length
        ? fail(`${kind} takes only a duration`)
        : { spec, kind, after: after.value, ms: ms(after.value) }
    let limit: number | undefined
    if (rest.length && /^[0-9]+$/.test(rest[0])) {
      const parsed = check(limitText, rest.shift())
      if (!parsed.ok) return fail(parsed.error)
      limit = Number(parsed.value)
    }
    let message: string | undefined
    if (rest.length) {
      const parsed = check(messageText, rest.join(':'))
      if (!parsed.ok) return fail(parsed.error)
      message = parsed.value
    }
    return {
      spec,
      kind,
      after: after.value,
      ms: ms(after.value),
      ...(limit ? { limit } : {}),
      ...(message ? { message } : {}),
    }
  })
/** The stored form: the spec text, checked by the same grammar. */
export const nudgeSpec = z.string().superRefine((spec, ctx) => {
  const result = nudgeRule.safeParse(spec)
  if (!result.success)
    ctx.addIssue({ code: 'custom', message: result.error.issues[0].message })
})
export function parseNudge(spec: string): NudgeRule {
  const result = nudgeRule.safeParse(spec)
  if (!result.success) throw Error(result.error.issues[0].message)
  return result.data
}

export const IDLE_PROMPT =
  "Report status: what's done, what's blocked, and next step. If background work finished, read its results now."

/** Local events-stream record; it never changes the agent's busy/idle state. */
export type NudgeEvent = {
  type: 'nudge'
  rule: string
  session: string
  /** Queued as a prompt; false for `waiting`, where a human must answer. */
  queued: boolean
  fired: number
  ts: string
  repo?: string
  message?: string
  run?: number
  error?: string
}
export type NudgeStatus = {
  rule: string
  fired: number
  /** ISO time the rule is next due, or null while it is not armed. */
  nextDue: string | null
  limit?: number
  lastFired?: string
}
export type Clock = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const pullEvent = z.object({
  pull_request: z.object({
    user: z.object({ login: z.string() }),
    head: z.object({ ref: z.string() }),
  }),
})
const runEvent = z.object({
  action: z.literal('completed'),
  workflow_run: z.object({
    id: z.number(),
    name: z.string().nullish(),
    head_branch: z.string(),
    event: z.string().nullish(),
    conclusion: z.string().nullish(),
    completed_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    html_url: z.string().nullish(),
    actor: z.object({ login: z.string() }).nullish(),
  }),
})
/** Mention records from the bridge: only delivered ones start a clock. */
type Delivered = {
  type: string
  stage?: string
  repo?: string
  message?: string
  id?: string
  author?: string
}

type Slot = {
  rule: NudgeRule
  fired: number
  /** Idle fires since the agent last started a turn of its own. */
  streak: number
  armed: boolean
  due?: number
  timer?: unknown
  last?: number
  pending: Map<string, { due: number; timer: unknown }>
}

export class Watchdog {
  private readonly slots: Slot[]
  private readonly clock: Clock
  private readonly started: number
  private current: AgentState = 'unknown'
  /** A nudge was queued, so the next turn is the agent answering it. */
  private nudgeTurn = false
  private readonly branches = new Map<string, Set<string>>()
  private readonly seenRuns = new Set<number>()
  private closed = false
  constructor(
    private readonly o: {
      rules: NudgeRule[]
      session: string
      /** The server identity (`sponsor/label`) whose PRs and replies count. */
      agent?: string
      enqueue: (text: string) => void
      emit: (event: NudgeEvent) => void
      /** Posts a channel note; `repo` is the rule's own repo when it has one. */
      note?: (text: string, repo?: string) => Promise<unknown>
      /** Whether the agent posted in `repo` after channel message `cursor`. */
      replied?: (repo: string, cursor: string) => Promise<boolean>
      clock?: Clock
    },
  ) {
    this.clock = o.clock ?? realClock
    this.started = this.clock.now()
    this.slots = o.rules.map((rule) => ({
      rule,
      fired: 0,
      streak: 0,
      armed: true,
      pending: new Map(),
    }))
  }
  /** Repos the `ci` rules read from the existing events subscription. */
  get repos() {
    return [
      ...new Set(
        this.slots.flatMap((s) => (s.rule.kind === 'ci' ? [s.rule.repo] : [])),
      ),
    ]
  }
  /** Every published agent event; only transitions matter. */
  state(next: AgentState) {
    const previous = this.current
    if (next === previous || this.closed) return
    this.current = next
    if (next !== 'idle' && next !== 'unknown') {
      // Only work re-arms an idle rule; a permission wait is not a turn.
      const working = next === 'busy' || next === 'tool_start'
      if (working && (previous === 'idle' || previous === 'unknown')) {
        // A turn the agent started itself resets the idle repeat limit.
        if (this.nudgeTurn) this.nudgeTurn = false
        else for (const s of this.slots) s.streak = 0
      }
      for (const s of this.slots)
        if (s.rule.kind === 'idle') {
          this.cancel(s)
          if (working) s.armed = true
        }
    }
    for (const s of this.slots)
      if (s.rule.kind === 'waiting') {
        this.cancel(s)
        if (next === 'waiting') this.arm(s, s.rule.ms, () => this.waiting(s))
      }
    if (next === 'idle')
      for (const s of this.slots)
        if (s.rule.kind === 'idle' && s.armed)
          this.arm(s, s.rule.ms, () => this.idle(s))
  }
  /** Bridge records; a delivered mention starts the `mention-unanswered` clocks. */
  bridge(event: Delivered) {
    if (
      this.closed ||
      event.type !== 'mention' ||
      event.stage !== 'delivered' ||
      !event.repo ||
      !event.message ||
      !event.id
    )
      return
    const { repo, message, id } = event
    for (const s of this.slots) {
      if (s.rule.kind !== 'mention-unanswered' || s.pending.has(id)) continue
      const due = this.clock.now() + s.rule.ms
      const timer = this.clock.setTimeout(() => {
        void this.unanswered(s, id, repo, message, event.author)
      }, s.rule.ms)
      s.pending.set(id, { due, timer })
    }
  }
  /** Pages from the events subscription the bridge already holds. */
  events(repo: string, events: { event: string; payload: unknown }[]) {
    if (this.closed || !this.o.agent) return
    const agent = this.o.agent.toLowerCase()
    const slots = this.slots.filter(
      (s) =>
        s.rule.kind === 'ci' &&
        s.rule.repo.toLowerCase() === repo.toLowerCase(),
    )
    if (!slots.length) return
    const key = repo.toLowerCase()
    const branches = this.branches.get(key) ?? new Set<string>()
    this.branches.set(key, branches)
    for (const event of events) {
      if (event.event === 'pull_request') {
        const pull = pullEvent.safeParse(event.payload)
        if (
          pull.success &&
          pull.data.pull_request.user.login.toLowerCase() === agent
        )
          branches.add(pull.data.pull_request.head.ref)
        continue
      }
      if (event.event !== 'workflow_run') continue
      const parsed = runEvent.safeParse(event.payload)
      if (!parsed.success) continue
      const run = parsed.data.workflow_run
      const finished = Date.parse(run.completed_at ?? run.updated_at ?? '')
      // A replayed page must not nudge for runs that ended before the session.
      if (!(finished >= this.started - 1000) || this.seenRuns.has(run.id))
        continue
      const ours =
        branches.has(run.head_branch) ||
        (run.event === 'pull_request' &&
          run.actor?.login.toLowerCase() === agent)
      if (!ours) continue
      this.seenRuns.add(run.id)
      // Only an idle agent is stalled; a busy one sees CI in its own turn.
      if (this.current !== 'idle') continue
      for (const s of slots) {
        const what = `workflow ${JSON.stringify(run.name ?? 'run')} ${run.conclusion ?? 'finished'} on ${run.head_branch} (run #${run.id}${run.html_url ? `, ${run.html_url}` : ''})`
        this.fire(s, {
          prompt: `[gild] nudge: ci ${repo}: ${what}. Read the result and continue.`,
          note: `ci ${repo}: ${what}; nudged the agent`,
          repo,
          run: run.id,
        })
      }
    }
  }
  status(): NudgeStatus[] {
    return this.slots.map((s) => {
      const due =
        s.rule.kind === 'mention-unanswered'
          ? Math.min(...[...s.pending.values()].map((p) => p.due))
          : s.due
      return {
        rule: s.rule.spec,
        fired: s.fired,
        nextDue:
          due !== undefined && Number.isFinite(due)
            ? new Date(due).toISOString()
            : null,
        ...(s.rule.kind === 'idle' && s.rule.limit
          ? { limit: s.rule.limit }
          : {}),
        ...(s.last !== undefined
          ? { lastFired: new Date(s.last).toISOString() }
          : {}),
      }
    })
  }
  close() {
    this.closed = true
    for (const s of this.slots) {
      this.cancel(s)
      for (const p of s.pending.values()) this.clock.clearTimeout(p.timer)
      s.pending.clear()
    }
  }
  private arm(s: Slot, after: number, run: () => void) {
    if (s.rule.kind === 'idle' && s.rule.limit && s.streak >= s.rule.limit)
      return
    s.due = this.clock.now() + after
    s.timer = this.clock.setTimeout(() => {
      s.timer = undefined
      s.due = undefined
      run()
    }, after)
  }
  private cancel(s: Slot) {
    if (s.timer !== undefined) this.clock.clearTimeout(s.timer)
    s.timer = undefined
    s.due = undefined
  }
  private idle(s: Slot) {
    if (s.rule.kind !== 'idle' || this.current !== 'idle') return
    s.armed = false
    s.streak++
    this.fire(s, {
      prompt: `[gild] nudge: idle ${s.rule.after}. ${s.rule.message ?? IDLE_PROMPT}`,
      note: `idle ${s.rule.after}; asked the agent for a status report`,
    })
  }
  private waiting(s: Slot) {
    s.fired++
    s.last = this.clock.now()
    this.o.emit({
      type: 'nudge',
      rule: s.rule.spec,
      session: this.o.session,
      queued: false,
      fired: s.fired,
      ts: new Date(s.last).toISOString(),
    })
  }
  private async unanswered(
    s: Slot,
    id: string,
    repo: string,
    cursor: string,
    author?: string,
  ) {
    if (s.rule.kind !== 'mention-unanswered' || this.closed) return
    s.pending.delete(id)
    // An unreadable channel counts as unanswered: a spare nudge is cheap.
    const answered = await this.o.replied?.(repo, cursor).catch(() => false)
    if (answered || this.closed) return
    this.fire(s, {
      prompt: `[gild] nudge: mention unanswered ${s.rule.after}. ${author ? `@${author}` : 'A mention'} in ${repo} (message ${cursor}) has no reply from you yet. Reply in the channel with your status.`,
      note: `mention ${cursor} unanswered for ${s.rule.after}; nudged the agent`,
      repo,
      message: cursor,
    })
  }
  private fire(
    s: Slot,
    f: {
      prompt: string
      note: string
      repo?: string
      message?: string
      run?: number
    },
  ) {
    s.fired++
    s.last = this.clock.now()
    let error: string | undefined
    try {
      this.o.enqueue(f.prompt)
      this.nudgeTurn = true
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    this.o.emit({
      type: 'nudge',
      rule: s.rule.spec,
      session: this.o.session,
      queued: !error,
      fired: s.fired,
      ts: new Date(s.last).toISOString(),
      ...(f.repo ? { repo: f.repo } : {}),
      ...(f.message ? { message: f.message } : {}),
      ...(f.run !== undefined ? { run: f.run } : {}),
      ...(error ? { error } : {}),
    })
    void this.o.note?.(`[gild nudge] ${f.note}`, f.repo)?.catch(() => {})
  }
}
