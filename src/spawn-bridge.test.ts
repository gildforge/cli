import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ApiRequestError } from './api/client'
import { MentionBridge, mentionPrompt, type BridgeEvent } from './spawn-bridge'

const command = () =>
  process.env.TEST_GILD_COMMAND
    ? (JSON.parse(process.env.TEST_GILD_COMMAND) as string[])
    : [process.execPath, 'run', resolve('src/gild.ts')]
for (const scenario of ['', '--auth']) {
  test(`mention bridge PTY${scenario ? ': auth failure keeps the agent alive' : ''}`, async () => {
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
async function bridge(pages: (() => unknown)[], file?: string) {
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
  events.flatMap((e) => (e.type === 'mention' ? [`${e.id}:${e.stage}`] : []))

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
  expect(text.split('\n')).toEqual([
    '[gild] @alice/ava mentioned you in owner/demo (message 41):',
    'hi',
    'Context: gild chat history owner/demo --agent bob --before 42 --limit 30',
    'Reply:   gild chat send owner/demo --agent bob --reply-to 41 "<your reply>"',
  ])
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
