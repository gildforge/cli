import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ApiRequestError } from './api/client'
import {
  MentionBridge,
  mentionPrompt,
  MENTION_ETIQUETTE,
  triggerPrompt,
  type BridgeEvent,
} from './spawn-bridge'

const command = () =>
  process.env.TEST_GILD_COMMAND
    ? (JSON.parse(process.env.TEST_GILD_COMMAND) as string[])
    : [process.execPath, 'run', resolve('src/gild.ts')]
test('trigger bridge PTY: label wakes alice, her unprompted post wakes bob', async () => {
  const proc = Bun.spawn(
    ['python3', resolve('scripts/fixtures/trigger-harness.py')],
    {
      env: { ...process.env, TEST_GILD_COMMAND: JSON.stringify(command()) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const timer = setTimeout(() => proc.kill('SIGTERM'), 55000)
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(JSON.parse(out).passed).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}, 60000)
const scenarios: Record<string, string> = {
  '': '',
  '--auth': ': auth failure keeps the agent alive',
  '--codex': ': a fresh Codex session gets its first mention',
  '--codex-trust':
    ': Codex trust dialog is left to the person, then the mention arrives',
}
for (const [scenario, title] of Object.entries(scenarios)) {
  test(`mention bridge PTY${title}`, async () => {
    const proc = Bun.spawn(
      [
        'python3',
        resolve('scripts/fixtures/chat-harness.py'),
        ...(scenario ? [scenario] : []),
      ],
      {
        env: { ...process.env, TEST_GILD_COMMAND: JSON.stringify(command()) },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const timer = setTimeout(() => proc.kill('SIGTERM'), 50000)
    try {
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect({ code, err }).toEqual({ code: 0, err: '' })
      expect(JSON.parse(out).passed).toBe(true)
    } finally {
      clearTimeout(timer)
    }
  }, 60000)
}

const mentionEvent = (n: number, agent = 'owner/bob', id = `m${n}`) => ({
  id: `e${n}`,
  cursor: String(n),
  event: 'channel.mention',
  repository: 'owner/demo',
  created_at: 'now',
  payload: {
    repository: { full_name: 'owner/demo' },
    message: {
      cursor: String(n),
      id,
      body: 'hello\nworld',
      author: { name: 'sami' },
    },
    agent,
  },
})
const issueEvent = (
  n: number,
  opts: {
    action?: string
    label?: string
    labels?: string[]
    number?: number
    title?: string
    actor?: string
    id?: string
    event?: string
  } = {},
) => {
  const event = opts.event ?? 'issues'
  const subject = {
    number: opts.number ?? 12,
    title: opts.title ?? 'Triage me',
    labels: (opts.labels ?? (opts.label ? [opts.label] : [])).map((name) => ({
      name,
    })),
    user: { login: opts.actor ?? 'sami' },
  }
  return {
    id: opts.id ?? `evt${n}`,
    cursor: String(n),
    event,
    repository: 'owner/demo',
    created_at: 'now',
    payload: {
      action: opts.action ?? 'labeled',
      ...(event === 'pull_request'
        ? { pull_request: subject }
        : { issue: subject }),
      ...(opts.label ? { label: { name: opts.label } } : {}),
      sender: { login: opts.actor ?? 'sami' },
    },
  }
}
async function bridge(
  pages: (() => unknown)[],
  file?: string,
  triggers: string[] = [],
  branchMembers: string[] = ['owner/bob'],
  backlog: unknown[] = [],
) {
  await mkdir('.tmp', { recursive: true })
  file ??= join(await mkdtemp(resolve('.tmp/br-')), 'bob.mentions.json')
  const typed: (() => void)[] = []
  const prompts: string[] = [],
    events: BridgeEvent[] = [],
    sinces: (string | undefined)[] = []
  const controller = new AbortController()
  let index = 0
  const b = new MentionBridge({
    client: {
      request: (async (
        _op: string,
        _p: unknown,
        _b: unknown,
        query: { since?: string },
      ) => {
        if (_op === 'channelList')
          return {
            channels: [
              { name: 'demo', members: [] },
              {
                name: 'bob/topic',
                members: branchMembers.map((name) => ({ name, prefix: '+' })),
              },
            ],
          }
        if (_op === 'issues') return backlog
        sinces.push(query.since)
        const page = pages[Math.min(index++, pages.length - 1)]()
        if (index >= pages.length + 1) controller.abort()
        return page
      }) as never,
    },
    agent: 'owner/bob',
    label: 'bob',
    session: 'bob',
    repos: ['owner/demo'],
    triggers,
    file,
    enqueue: (text, done) => {
      prompts.push(text)
      typed.push(done)
    },
    emit: (e) => events.push(e),
    pause: async () => {},
  })
  const done = b.start(controller.signal)
  return { b, done, typed, prompts, events, sinces, file, controller }
}
const stages = (events: BridgeEvent[]) =>
  events.flatMap((e) =>
    e.type === 'mention' || e.type === 'trigger' ? [`${e.id}:${e.stage}`] : [],
  )

test('prompt is short, names the history and reply commands', () => {
  const text = mentionPrompt('owner/demo', 'bob', {
    repository: { full_name: 'owner/demo' },
    message: {
      cursor: '41',
      id: 'x',
      body: 'hi',
      author: { name: 'alice/ava' },
    },
    agent: 'owner/bob',
  })
  expect(text).toContain('clone owner/demo --agent')
  expect(text).toContain('pr create|list|view|diff|checks|comment|review|merge')
  expect(text.split('\n').slice(0, -1)).toEqual([
    '[gild] @alice/ava mentioned you in owner/demo #demo (message 41):',

    'hi',
    'Context: gild chat history owner/demo --agent bob --before 42 --limit 30',
    'Reply:   gild chat send owner/demo --agent bob --reply-to 41 "<your reply>"',
    'Work notes: gild chat note owner/demo --agent bob "<progress, decisions, blockers or tests>" (never notifies).',
    MENTION_ETIQUETTE,
  ])
  // Without the note, agents tag each other as a courtesy and wake each other
  // again (rehearsal, 10 Oct: bob answered coordinator's relay of his answer).
  expect(MENTION_ETIQUETTE).toContain('Tag only whoever must act next')
  expect(MENTION_ETIQUETTE).toContain('do not reply')
})
test('prompt names the gild that spawned the session, not whatever is on PATH', () => {
  const text = mentionPrompt(
    'owner/demo',
    'bob',
    {
      repository: { full_name: 'owner/demo' },
      message: { cursor: '7', id: 'y', body: 'go', author: { name: 'a' } },
      agent: 'owner/bob',
    },
    "'/opt/gild bin/gild'",
  )
  expect(text).toContain(
    "Context: '/opt/gild bin/gild' chat history owner/demo --agent bob",
  )
  expect(text).toContain("Reply:   '/opt/gild bin/gild' chat send owner/demo")
})

test('only this agent mentions are queued, once, and typed progress reaches the stream', async () => {
  const run = await bridge([
    () => ({
      events: [mentionEvent(1, 'owner/alice'), mentionEvent(2)],
      cursor: '2',
    }),
    () => ({ events: [mentionEvent(3, 'owner/bob', 'm2')], cursor: '3' }), // same message again
  ])
  await run.done
  expect(run.prompts).toHaveLength(1)
  expect(run.prompts[0]).toContain('(message 2)')
  expect(stages(run.events)).toEqual(['m2:received', 'm2:queued'])
  run.typed[0]()
  expect(stages(run.events).at(-1)).toBe('m2:delivered')
  await run.b.flush()
  expect(JSON.parse(await readFile(run.file, 'utf8'))).toEqual({
    cursors: { 'owner/demo': '3' },
    delivered: ['m2'],
  })
})

test('a restart resumes from the persisted cursor and skips delivered ids', async () => {
  await mkdir('.tmp', { recursive: true })
  const file = join(await mkdtemp(resolve('.tmp/br-')), 'bob.mentions.json')
  await writeFile(
    file,
    JSON.stringify({ cursors: { 'owner/demo': '7' }, delivered: ['m2'] }),
  )
  const run = await bridge(
    [() => ({ events: [mentionEvent(2), mentionEvent(8)], cursor: '8' })],
    file,
  )
  await run.done
  expect(run.sinces[0]).toBe('7')
  expect(run.prompts).toHaveLength(1)
  expect(run.prompts[0]).toContain('(message 8)')
})

test('the cursor does not pass a mention that was queued but not typed', async () => {
  const run = await bridge([() => ({ events: [mentionEvent(4)], cursor: '4' })])
  await run.done
  await run.b.flush()
  const saved = await readFile(run.file, 'utf8').catch(() => '')
  expect(saved).toBe('')
  run.typed[0]()
  await run.b.flush()
  expect(
    JSON.parse(await readFile(run.file, 'utf8')).cursors['owner/demo'],
  ).toBe('4')
})

test('lost auth is reported per channel and does not throw', async () => {
  const run = await bridge([
    () => {
      throw new ApiRequestError(401, 'token revoked')
    },
  ])
  await run.done
  expect(run.b.channels).toEqual([
    { repo: 'owner/demo', state: 'error', error: 'token revoked' },
  ])
  expect(run.events).toMatchObject([
    { type: 'channel', state: 'error', error: 'token revoked' },
  ])
})

test('trigger prompt is short, names the read and hand-off commands', () => {
  const text = triggerPrompt(
    'owner/demo',
    { event: 'issues', action: 'labeled', label: 'triage' },
    { number: 12, title: 'Triage me' },
    'sami',
    'triage',
    'gild',
    'alice',
  )
  expect(text).toContain('clone owner/demo --agent')
  expect(text).toContain('pr create|list|view|diff|checks|comment|review|merge')
  expect(text.split('\n').slice(0, -1)).toEqual([
    '[gild] issue #12 "Triage me" labeled triage in owner/demo by sami',
    'Read:  gild issue view owner/demo#12 --agent alice',
    'Post:  gild chat send owner/demo --agent alice "@<agent> <message>"',
  ])
  const pr = triggerPrompt(
    'owner/demo',
    { event: 'pull_request', action: 'opened' },
    { number: 4, title: 'Add thing' },
    'sami',
    undefined,
    "'/opt/gild bin/gild'",
    'alice',
  )
  expect(pr).toContain(
    '[gild] pull request #4 "Add thing" opened in owner/demo by sami',
  )
  expect(pr).toContain(
    "Read:  '/opt/gild bin/gild' pr view owner/demo#4 --agent alice",
  )
})

test('a matching labeled issue is queued once; other labels and duplicates are not', async () => {
  const run = await bridge(
    [
      () => ({
        events: [
          issueEvent(1, { label: 'wontfix' }),
          issueEvent(2, { label: 'triage', title: 'Triage me' }),
        ],
        cursor: '2',
      }),
      () => ({ events: [issueEvent(2, { label: 'triage' })], cursor: '3' }), // same event again
      () => ({ events: [], cursor: '3' }),
    ],
    undefined,
    ['issues.labeled:triage'],
  )
  await run.done
  expect(run.prompts).toHaveLength(1)
  expect(run.prompts[0]).toContain(
    '[gild] issue #12 "Triage me" labeled triage in owner/demo by sami',
  )
  expect(run.prompts[0]).toContain('Read:  gild issue view owner/demo#12')
  expect(run.prompts[0]).toContain(
    'Post:  gild chat send owner/demo --agent bob',
  )
  expect(stages(run.events)).toEqual(['evt2:received', 'evt2:queued'])
  const fired = run.events.find((e) => e.type === 'trigger')
  expect(fired).toMatchObject({
    trigger: 'issues.labeled:triage',
    event: 'issues',
    action: 'labeled',
    label: 'triage',
    actor: 'sami',
    number: 12,
    title: 'Triage me',
  })
  run.typed[0]()
  expect(stages(run.events).at(-1)).toBe('evt2:delivered')
  await run.b.flush()
  expect(JSON.parse(await readFile(run.file, 'utf8'))).toEqual({
    cursors: { 'owner/demo': '3' },
    delivered: ['trigger:owner/demo#12:issues.labeled:triage'],
  })
})

test('non-labeled actions match the issue labels; pull_request matches its subject', async () => {
  const run = await bridge(
    [
      () => ({
        events: [
          issueEvent(1, { action: 'opened', labels: [] }), // no triage label
          issueEvent(2, { action: 'opened', labels: ['triage'] }),
          issueEvent(3, {
            event: 'pull_request',
            action: 'opened',
            number: 4,
            title: 'Add thing',
          }),
          issueEvent(4, { action: 'closed', labels: ['triage'] }), // not subscribed
        ],
        cursor: '4',
      }),
    ],
    undefined,
    ['issues.opened:triage', 'pull_request.opened'],
  )
  await run.done
  expect(run.prompts).toHaveLength(2)
  expect(run.prompts[0]).toContain(
    '[gild] issue #12 "Triage me" opened triage in owner/demo by sami',
  )
  expect(run.prompts[1]).toContain(
    '[gild] pull request #4 "Add thing" opened in owner/demo by sami',
  )
  run.typed.forEach((t) => t())
  await run.b.flush()
})

test('a restart skips delivered trigger ids and resumes from the cursor', async () => {
  await mkdir('.tmp', { recursive: true })
  const file = join(await mkdtemp(resolve('.tmp/br-')), 'bob.mentions.json')
  await writeFile(
    file,
    JSON.stringify({
      cursors: { 'owner/demo': '7' },
      delivered: ['trigger:owner/demo#12:issues.labeled:triage'],
    }),
  )
  const run = await bridge(
    [
      () => ({
        events: [
          issueEvent(2, { label: 'triage' }), // delivered before the restart
          issueEvent(8, { label: 'triage', number: 13 }),
        ],
        cursor: '8',
      }),
    ],
    file,
    ['issues.labeled:triage'],
  )
  await run.done
  expect(run.sinces[0]).toBe('7')
  expect(run.prompts).toHaveLength(1)
  expect(run.prompts[0]).toContain('issue view owner/demo#13')
  run.typed[0]()
  await run.b.flush()
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    cursors: { 'owner/demo': '8' },
    delivered: [
      'trigger:owner/demo#12:issues.labeled:triage',
      'trigger:owner/demo#13:issues.labeled:triage',
    ],
  })
})

test('the repo event bridge delivers mentions from every branch and prompts select the same channel', async () => {
  const one = mentionEvent(1),
    two = mentionEvent(2)
  const a = { ...one, payload: { ...one.payload, channel: 'bob/topic' } }
  const b = { ...two, payload: { ...two.payload, channel: 'alice/topic' } }
  const run = await bridge([
    () => ({ events: [a, b], cursor: '2' }),
    () => ({ events: [], cursor: '2' }),
  ])
  await run.done
  expect(run.prompts).toHaveLength(2)
  expect(run.prompts[0]).toContain('#bob/topic')
  expect(run.prompts[0]).toContain('--channel bob/topic')
  expect(run.prompts[1]).toContain('--channel alice/topic')
  expect(run.prompts.every((p) => p.includes('chat note'))).toBe(true)
})

test('branch trigger prompts require membership; a direct tag can wake a non-member', async () => {
  const pr = issueEvent(1, { event: 'pull_request', action: 'opened' })
  const scoped = {
    ...pr,
    payload: {
      ...pr.payload,
      pull_request: {
        ...('pull_request' in pr.payload ? pr.payload.pull_request : {}),
        head: { ref: 'bob/topic' },
      },
    },
  }
  const direct = {
    ...mentionEvent(2),
    payload: { ...mentionEvent(2).payload, channel: 'bob/topic' },
  }
  for (const members of [[], ['owner/bob']]) {
    const run = await bridge(
      [
        () => ({ events: [scoped, direct], cursor: '2' }),
        () => ({ events: [], cursor: '2' }),
      ],
      undefined,
      ['pull_request.opened'],
      members,
    )
    await run.done
    expect(run.prompts).toHaveLength(members.length ? 2 : 1)
    expect(run.prompts.at(-1)).toContain('#bob/topic')
  }
})

test('a labeled trigger also fires for an issue opened with the label, once', async () => {
  const run = await bridge(
    [
      () => ({
        events: [
          issueEvent(1, {
            action: 'opened',
            labels: ['triage'],
            label: undefined,
          }),
          issueEvent(2, { label: 'triage' }), // the same issue labeled too
          issueEvent(3, { action: 'opened', number: 13, labels: ['other'] }),
        ],
        cursor: '3',
      }),
      () => ({ events: [], cursor: '3' }),
    ],
    undefined,
    ['issues.labeled:triage'],
  )
  await run.done
  expect(run.prompts).toHaveLength(1)
  expect(run.prompts[0]).toContain('issue #12')
})

test('open issues already carrying the label are picked up on start', async () => {
  const run = await bridge(
    [() => ({ events: [], cursor: '1' })],
    undefined,
    ['issues.labeled:triage'],
    undefined,
    [
      {
        number: 7,
        title: 'Backlog task',
        labels: [{ name: 'triage' }],
        user: { login: 'sami' },
      },
    ],
  )
  await run.done
  expect(run.prompts).toHaveLength(1)
  expect(run.prompts[0]).toContain('issue #7 "Backlog task"')
})
