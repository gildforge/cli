import { expect, test } from 'bun:test'
import { parseProfile } from './agent-profiles'
import {
  IDLE_PROMPT,
  parseNudge,
  Watchdog,
  type Clock,
  type NudgeEvent,
} from './spawn-nudge'
import { InjectionQueue } from './spawn-queue'

const START = Date.parse('2026-10-09T12:00:00Z')
function fakeClock() {
  let now = START,
    next = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock & { advance(ms: number): void; pending(): number } = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++next, { at: now + ms, fn })
      return next
    },
    clearTimeout: (h) => void timers.delete(h as number),
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    },
    pending: () => timers.size,
  }
  return clock
}
const MIN = 60_000
function dog(
  specs: string[],
  extra: Partial<ConstructorParameters<typeof Watchdog>[0]> = {},
) {
  const clock = fakeClock()
  const prompts: string[] = [],
    events: NudgeEvent[] = [],
    notes: { text: string; repo?: string }[] = []
  const w = new Watchdog({
    rules: specs.map(parseNudge),
    session: 'fixture',
    agent: 'owner/fixture',
    enqueue: (text) => prompts.push(text),
    emit: (e) => events.push(e),
    note: async (text, repo) => notes.push({ text, repo }),
    clock,
    ...extra,
  })
  return { w, clock, prompts, events, notes }
}

test('nudge grammar is validated', () => {
  expect(parseNudge('idle:20m')).toEqual({
    spec: 'idle:20m',
    kind: 'idle',
    after: '20m',
    ms: 20 * MIN,
  })
  expect(parseNudge('idle:20m:3')).toMatchObject({ limit: 3, ms: 20 * MIN })
  expect(parseNudge('idle:1h:2:Check PR #4: status?')).toMatchObject({
    limit: 2,
    message: 'Check PR #4: status?',
  })
  expect(parseNudge('idle:30s:read the log')).toMatchObject({
    message: 'read the log',
    ms: 30_000,
  })
  expect(parseNudge('waiting:5m')).toMatchObject({
    kind: 'waiting',
    ms: 5 * MIN,
  })
  expect(parseNudge('ci:gildforge/cli')).toMatchObject({
    kind: 'ci',
    repo: 'gildforge/cli',
  })
  expect(parseNudge('mention-unanswered:10m')).toMatchObject({
    kind: 'mention-unanswered',
    ms: 10 * MIN,
  })
  for (const bad of [
    'idle',
    'idle:20',
    'idle:0m',
    'idle:8d',
    'idle:20m:0',
    'idle:20m:1000',
    'idle:20m:3:two\nlines',
    'waiting:5m:3',
    'ci:not-a-repo',
    'mention-unanswered:',
    'sleepy:5m',
  ])
    expect(() => parseNudge(bad)).toThrow()
  expect(
    parseProfile({
      name: 'ava',
      runtime: 'claude',
      directory: '/work',
      nudges: ['idle:20m:3', 'ci:owner/repo'],
    }).nudges,
  ).toEqual(['idle:20m:3', 'ci:owner/repo'])
  expect(() =>
    parseProfile({
      name: 'ava',
      runtime: 'claude',
      directory: '/work',
      nudges: ['idle:soon'],
    }),
  ).toThrow(/Invalid nudge rule: Use a duration/)
})

test('idle fires once, re-arms after busy, and respects the repeat limit', () => {
  const { w, clock, prompts, events, notes } = dog(['idle:20m:2'])
  w.state('busy')
  w.state('idle')
  clock.advance(20 * MIN - 1)
  expect(prompts).toEqual([])
  clock.advance(1)
  expect(prompts).toEqual([`[gild] nudge: idle 20m. ${IDLE_PROMPT}`])
  expect(events).toEqual([
    {
      type: 'nudge',
      rule: 'idle:20m:2',
      session: 'fixture',
      queued: true,
      fired: 1,
      ts: new Date(START + 20 * MIN).toISOString(),
    },
  ])
  expect(notes).toEqual([
    {
      text: '[gild nudge] idle 20m; asked the agent for a status report',
      repo: undefined,
    },
  ])
  // Still idle (the nudge sits in the queue): it does not fire again,
  // and a permission wait in between is not work.
  w.state('idle')
  clock.advance(3 * 60 * MIN)
  w.state('waiting')
  w.state('idle')
  clock.advance(3 * 60 * MIN)
  expect(prompts.length).toBe(1)
  // The nudge's own turn re-arms the rule.
  w.state('busy')
  w.state('idle')
  clock.advance(20 * MIN)
  expect(prompts.length).toBe(2)
  // Limit 2 reached: nudge-driven turns do not re-arm it further.
  w.state('busy')
  w.state('idle')
  clock.advance(5 * 60 * MIN)
  expect(prompts.length).toBe(2)
  expect(w.status()[0]).toMatchObject({ fired: 2, limit: 2, nextDue: null })
  // A turn the agent starts itself (no nudge queued) resets the limit.
  w.state('busy')
  w.state('idle')
  clock.advance(20 * MIN)
  expect(prompts.length).toBe(3)
})

test('idle uses its custom message and is cancelled by activity', () => {
  const { w, clock, prompts } = dog(['idle:10m:wrap up and report'])
  w.state('idle')
  clock.advance(9 * MIN)
  w.state('tool_start')
  w.state('idle')
  clock.advance(9 * MIN)
  expect(prompts).toEqual([])
  clock.advance(1 * MIN)
  expect(prompts).toEqual(['[gild] nudge: idle 10m. wrap up and report'])
})

test('a draft holds the nudge until the composer is clear', async () => {
  const clock = fakeClock()
  const written: string[] = []
  const queue = new InjectionQueue(
    (d) => written.push(String(d)),
    0,
    () => true,
    true,
  )
  const w = new Watchdog({
    rules: [parseNudge('idle:1m')],
    session: 'fixture',
    enqueue: (text) => queue.enqueue(text),
    emit: () => {},
    clock,
  })
  queue.userInput(Buffer.from('half a thought'))
  w.state('idle')
  clock.advance(MIN)
  await Bun.sleep(200)
  expect(written).toEqual(['half a thought'])
  expect(queue.held?.reason).toStartWith('unsent draft')
  queue.userInput(Buffer.from('\x15'))
  await Bun.sleep(300)
  expect(written.join('')).toContain('[gild] nudge: idle 1m.')
  expect(written.at(-1)).toBe('\r')
  queue.close()
  w.close()
})

test('waiting never types; it only reports', () => {
  const { w, clock, prompts, events, notes } = dog(['waiting:5m'])
  w.state('busy')
  w.state('waiting')
  expect(w.status()[0].nextDue).toBe(new Date(START + 5 * MIN).toISOString())
  clock.advance(5 * MIN)
  expect(prompts).toEqual([])
  expect(notes).toEqual([])
  expect(events).toEqual([
    {
      type: 'nudge',
      rule: 'waiting:5m',
      session: 'fixture',
      queued: false,
      fired: 1,
      ts: new Date(START + 5 * MIN).toISOString(),
    },
  ])
  // Once per wait: still waiting does not repeat; the next wait does.
  clock.advance(60 * MIN)
  expect(events.length).toBe(1)
  w.state('busy')
  w.state('waiting')
  clock.advance(5 * MIN)
  expect(events.length).toBe(2)
  expect(prompts).toEqual([])
})

const pull = (login: string, ref: string) => ({
  event: 'pull_request',
  payload: {
    action: 'opened',
    pull_request: { number: 4, user: { login }, head: { ref } },
  },
})
const run = (
  id: number,
  branch: string,
  extra: Record<string, unknown> = {},
  completed = new Date(START + 1000).toISOString(),
) => ({
  event: 'workflow_run',
  payload: {
    action: 'completed',
    workflow_run: {
      id,
      name: 'CI',
      head_branch: branch,
      event: 'push',
      conclusion: 'failure',
      completed_at: completed,
      html_url: `https://gild.gg/owner/demo/actions/${id}`,
      actor: { login: 'owner/fixture' },
      ...extra,
    },
  },
})
test("ci fires only for this agent's PRs and only while idle", () => {
  const { w, prompts, events, notes } = dog(['ci:owner/demo'])
  expect(w.repos).toEqual(['owner/demo'])
  w.events('owner/demo', [
    pull('owner/fixture', 'claude/nudges'),
    pull('owner/other', 'other/work'),
  ])
  w.state('busy')
  // Busy: the agent sees CI in its own turn.
  w.events('owner/demo', [run(1, 'claude/nudges')])
  w.state('idle')
  w.events('owner/demo', [
    run(1, 'claude/nudges'), // already seen while busy
    run(2, 'other/work', { actor: { login: 'owner/other' } }),
    run(3, 'main'), // a push run, not a PR of ours
    run(4, 'claude/nudges', {}, new Date(START - 60_000).toISOString()), // before the session
    {
      event: 'workflow_run',
      payload: { action: 'in_progress', workflow_run: {} },
    },
  ])
  w.events('other/repo', [run(5, 'claude/nudges')])
  expect(prompts).toEqual([])
  w.events('owner/demo', [run(6, 'claude/nudges')])
  expect(prompts).toEqual([
    '[gild] nudge: ci owner/demo: workflow "CI" failure on claude/nudges (run #6, https://gild.gg/owner/demo/actions/6). Read the result and continue.',
  ])
  expect(events).toMatchObject([
    {
      type: 'nudge',
      rule: 'ci:owner/demo',
      queued: true,
      repo: 'owner/demo',
      run: 6,
    },
  ])
  expect(notes[0].repo).toBe('owner/demo')
  expect(notes[0].text).toStartWith('[gild nudge] ci owner/demo:')
  // A pull_request-triggered run by this agent counts without a seen PR event.
  w.events('owner/demo', [run(7, 'fresh', { event: 'pull_request' })])
  expect(prompts.length).toBe(2)
  w.events('owner/demo', [run(7, 'fresh', { event: 'pull_request' })])
  expect(prompts.length).toBe(2)
})

test('mention-unanswered fires, and does not fire after a reply', async () => {
  const answered = new Set<string>()
  const { w, clock, prompts, events } = dog(['mention-unanswered:10m'], {
    replied: async (_repo, cursor) => answered.has(cursor),
  })
  const delivered = (n: number) =>
    w.bridge({
      type: 'mention',
      stage: 'delivered',
      repo: 'owner/demo',
      message: String(n),
      id: `m${n}`,
      author: 'sami',
    })
  w.bridge({
    type: 'mention',
    stage: 'queued',
    repo: 'owner/demo',
    message: '1',
    id: 'm1',
  })
  delivered(5)
  delivered(5) // a duplicate record starts no second clock
  delivered(7)
  expect(w.status()[0].nextDue).toBe(new Date(START + 10 * MIN).toISOString())
  answered.add('7')
  clock.advance(10 * MIN)
  await Bun.sleep(0)
  expect(prompts).toEqual([
    '[gild] nudge: mention unanswered 10m. @sami in owner/demo (message 5) has no reply from you yet. Reply in the channel with your status.',
  ])
  expect(events).toMatchObject([
    {
      rule: 'mention-unanswered:10m',
      queued: true,
      repo: 'owner/demo',
      message: '5',
      fired: 1,
    },
  ])
  expect(w.status()[0]).toMatchObject({ fired: 1, nextDue: null })
})

test('status shows next due time and how often each rule fired', () => {
  const { w, clock } = dog(['idle:20m:3', 'waiting:5m', 'ci:owner/demo'])
  expect(w.status()).toEqual([
    { rule: 'idle:20m:3', fired: 0, nextDue: null, limit: 3 },
    { rule: 'waiting:5m', fired: 0, nextDue: null },
    { rule: 'ci:owner/demo', fired: 0, nextDue: null },
  ])
  w.state('idle')
  expect(w.status()[0].nextDue).toBe(new Date(START + 20 * MIN).toISOString())
  clock.advance(20 * MIN)
  expect(w.status()[0]).toEqual({
    rule: 'idle:20m:3',
    fired: 1,
    nextDue: null,
    limit: 3,
    lastFired: new Date(START + 20 * MIN).toISOString(),
  })
  w.close()
  expect(clock.pending()).toBe(0)
})

test('a full queue is reported on the nudge event', () => {
  const { w, clock, events } = dog(['idle:1m'], {
    enqueue: () => {
      throw new Error('Session message queue is full')
    },
  })
  w.state('idle')
  clock.advance(MIN)
  expect(events).toMatchObject([
    { queued: false, error: 'Session message queue is full' },
  ])
})

test('a permission wait is not a turn of its own: the idle limit holds', () => {
  const { w, clock, prompts } = dog(['idle:1m:1'])
  w.state('idle')
  clock.advance(MIN)
  w.state('busy')
  w.state('idle')
  w.state('waiting')
  w.state('idle')
  clock.advance(10 * MIN)
  expect(prompts.length).toBe(1)
})
