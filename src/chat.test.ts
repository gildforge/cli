import { expect, test } from 'bun:test'
import { unlink } from 'node:fs/promises'
import { rawChannel } from './chat'
import { setup, type Message } from './chat-forge'
import { cli, startCLI } from './test-cli'

test('history prints readable lines, pages with --before, emits JSON, rejects before+after', async () => {
  const s = await setup()
  try {
    for (let i = 1; i <= 5; i++) s.post('sami', `line ${i}\nsecond`)
    const page = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--limit',
      '2',
      '--server',
      s.origin,
    ])
    expect(page.code).toBe(0)
    expect(page.out.trim().split('\n')).toEqual([
      '4  2026-10-09T10:00:00.000Z  sami  line 4 ↵ second',
      '5  2026-10-09T10:00:00.000Z  sami  line 5 ↵ second',
    ])
    expect(page.err).toContain('--before 4')
    const older = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--limit',
      '2',
      '--before',
      '4',
      '--json',
      '--server',
      s.origin,
    ])
    expect(
      older.out
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).cursor),
    ).toEqual(['2', '3'])
    const newer = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--after',
      '4',
      '--server',
      s.origin,
    ])
    expect(newer.out.trim().split('\n')).toHaveLength(1)
    const both = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--before',
      '4',
      '--after',
      '1',
      '--server',
      s.origin,
    ])
    expect(both.code).toBe(1)
    expect(both.err).toContain('--before or --after, not both')
    expect(s.seen.every((r) => !r.path.includes('before=4&after'))).toBe(true)
    expect(
      (
        await cli(s.root, [
          'chat',
          'history',
          'owner/demo',
          '--limit',
          '500',
          '--server',
          s.origin,
        ])
      ).code,
    ).toBe(1)
  } finally {
    await s.close()
  }
})

test('send prints the cursor, passes reply_to, and an agent uses its own token without printing it', async () => {
  const s = await setup()
  try {
    s.post('sami', '@alice/test hello')
    const human = await cli(s.root, [
      'chat',
      'send',
      'owner/demo',
      'hi there',
      '--server',
      s.origin,
    ])
    expect(human).toMatchObject({ code: 0, out: '2\n', err: '' })
    expect(s.seen.at(-1)).toMatchObject({
      auth: 'Bearer gf_fixturetoken',
      body: { body: 'hi there' },
    })
    expect(
      (s.seen.at(-1)!.body as { reply_to?: string }).reply_to,
    ).toBeUndefined()
    // gild-site#55: an agent posts unprompted, e.g. to hand off with @bob.
    const unprompted = await cli(s.root, [
      'chat',
      'send',
      'owner/demo',
      '@bob take this',
      '--agent',
      'test',
    ])
    expect(unprompted).toMatchObject({ code: 0, out: '3\n', err: '' })
    expect(s.seen.at(-1)).toMatchObject({
      auth: 'Bearer gf_agentfixture',
      body: { body: '@bob take this' },
    })
    expect(s.log[2]).toMatchObject({
      reply_to: null,
      author: { name: 'alice/test', kind: 'agent' },
    })
    const reply = await cli(s.root, [
      'chat',
      'send',
      'owner/demo',
      'answer',
      '--agent',
      'test',
      '--reply-to',
      '1',
    ])
    expect(reply).toMatchObject({ code: 0, out: '4\n', err: '' })
    expect(s.seen.at(-1)).toMatchObject({
      auth: 'Bearer gf_agentfixture',
      body: { reply_to: '1' },
    })
    expect(s.log[3]).toMatchObject({
      reply_to: '1',
      author: { name: 'alice/test', kind: 'agent' },
    })
    for (const run of [human, unprompted, reply])
      expect(run.out + run.err).not.toContain('gf_')
    const stdin = await cli(
      s.root,
      ['chat', 'send', 'owner/demo', '-', '--server', s.origin],
      'from stdin',
    )
    expect(stdin.out).toBe('5\n')
  } finally {
    await s.close()
  }
})

test('participants lists who may be mentioned', async () => {
  const s = await setup()
  try {
    const run = await cli(s.root, [
      'chat',
      'participants',
      'owner/demo',
      '--agent',
      'test',
    ])
    expect(run.out.trim().split('\n')).toEqual([
      '@sami\thuman\tonline\t\t',
      '+alice/test\tagent\toffline\t\tchannel:write',
    ])
    expect(run.out + run.err).not.toContain('gf_')
  } finally {
    await s.close()
  }
})

async function lines(proc: ReturnType<typeof startCLI>, count: number) {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 10000
  while (
    text.split('\n').filter(Boolean).length < count &&
    Date.now() < deadline
  ) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  reader.releaseLock()
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}
test('raw streams channel frames in order, resumes from --since, never exits on its own', async () => {
  const s = await setup()
  try {
    s.post('sami', 'one')
    s.post('sami', 'two')
    const first = startCLI(s.root, [
      'chat',
      'raw',
      'owner/demo',
      '--agent',
      'test',
    ])
    const ready = (await lines(first, 1))[0]
    expect(ready.type).toBe('ready')
    expect(ready.messages.map((m: Message) => m.body)).toEqual(['one', 'two'])
    expect(s.seen.find((r) => r.path.includes('/stream'))!.auth).toBe(
      'Bearer gf_agentfixture',
    )
    expect(s.seen.map((r) => r.path).join()).not.toContain('gf_')
    await Bun.sleep(150)
    s.post('sami', 'three')
    s.post('sami', 'four')
    const live = await lines(first, 2)
    expect(live.map((f: { message: Message }) => f.message.body)).toEqual([
      'three',
      'four',
    ])
    expect(first.exitCode).toBeNull()
    first.kill('SIGINT')
    expect(await first.exited).not.toBeNull()
    const second = startCLI(s.root, [
      'chat',
      'raw',
      'owner/demo',
      '--since',
      '3',
      '--server',
      s.origin,
    ])
    const resumed = (await lines(second, 1))[0]
    expect(resumed.messages.map((m: Message) => m.body)).toEqual(['four'])
    expect(s.seen.at(-1)!.path).toContain('after=3')
    second.kill('SIGINT')
    await second.exited
  } finally {
    await s.close()
  }
}, 30000)

test('history, participants and raw read a public channel with no identity; send still needs one', async () => {
  const s = await setup(undefined, true)
  try {
    await unlink(`${s.root}/identity.json`)
    s.post('sami', 'public hello')
    const history = await cli(s.root, [
      'chat',
      'history',
      'owner/demo',
      '--server',
      s.origin,
    ])
    expect(history).toMatchObject({
      code: 0,
      out: '1  2026-10-09T10:00:00.000Z  sami  public hello\n',
    })
    const participants = await cli(s.root, [
      'chat',
      'participants',
      'owner/demo',
      '--server',
      s.origin,
    ])
    expect(participants.code).toBe(0)
    expect(participants.out).toContain('@sami\thuman\tonline')
    const raw = startCLI(s.root, [
      'chat',
      'raw',
      'owner/demo',
      '--server',
      s.origin,
    ])
    const ready = (await lines(raw, 1))[0]
    expect(ready.messages.map((m: Message) => m.body)).toEqual(['public hello'])
    raw.kill('SIGINT')
    await raw.exited
    // No header at all, not "Bearer " with an empty token.
    expect(s.seen.length).toBeGreaterThanOrEqual(3)
    expect(s.seen.every((r) => r.auth === null)).toBe(true)
    const send = await cli(s.root, [
      'chat',
      'send',
      'owner/demo',
      'hi',
      '--server',
      s.origin,
    ])
    expect(send.code).toBe(1)
    expect(send.err).toContain('gild auth init')
    expect(s.log).toHaveLength(1)
    // A private channel refuses the anonymous reader and names the fix.
    const priv = await cli(s.root, [
      'chat',
      'history',
      'owner/secret',
      '--server',
      s.origin,
    ])
    expect(priv.code).toBe(1)
    expect(priv.err).toContain('Bad credentials')
    expect(priv.err).toContain('gild auth init')
  } finally {
    await s.close()
  }
}, 30000)

test('the stream pings so the forge keeps the reader present (presence expires after 90 s)', async () => {
  const s = await setup()
  try {
    const controller = new AbortController()
    const frames: string[] = []
    const stream = rawChannel(
      { baseURL: `${s.origin}/api/v1`, token: 'gf_fixturetoken' },
      { owner: 'owner', repo: 'demo' },
      undefined,
      controller.signal,
      (line) => frames.push(line),
      () => {},
      undefined,
      40,
    )
    const deadline = Date.now() + 5000
    while (s.state.pings < 3 && Date.now() < deadline) await Bun.sleep(20)
    controller.abort()
    await stream
    expect(JSON.parse(frames[0]).type).toBe('ready')
    expect(s.state.pings).toBeGreaterThanOrEqual(3)
  } finally {
    await s.close()
  }
})

test('branch selectors reach every chat endpoint; notes and channel listing use their contract', async () => {
  const s = await setup()
  try {
    for (const args of [
      ['history', 'owner/demo'],
      ['participants', 'owner/demo'],
      ['send', 'owner/demo', 'context'],
      ['note', 'owner/demo', '@bob tests passed'],
    ]) {
      const run = await cli(s.root, [
        'chat',
        ...args,
        '--channel',
        'bob/topic',
        '--agent',
        'test',
      ])
      expect(run.code).toBe(0)
      expect(s.seen.at(-1)!.path).toContain('channel=bob%2Ftopic')
    }
    expect(s.log.at(-1)!.kind).toBe('note')
    expect(s.seen.at(-1)!.body).toMatchObject({
      kind: 'note',
      body: '@bob tests passed',
    })
    const buffers = await cli(s.root, [
      'chat',
      'channels',
      'owner/demo',
      '--agent',
      'test',
      '--json',
    ])
    expect(buffers.code).toBe(0)
    expect(
      JSON.parse(buffers.out).channels.map((c: any) => [
        c.name,
        c.archived,
        c.unread,
      ]),
    ).toEqual([
      ['demo', false, 0],
      ['bob/topic', false, 3],
      ['old', true, 0],
    ])
    const raw = startCLI(s.root, [
      'chat',
      'raw',
      'owner/demo',
      '--channel',
      'bob/topic',
      '--server',
      s.origin,
    ])
    await lines(raw, 1)
    expect(
      s.seen.find(
        (r) =>
          r.path.includes('/stream') && r.path.includes('channel=bob%2Ftopic'),
      ),
    ).toBeDefined()
    raw.kill('SIGINT')
    await raw.exited
  } finally {
    await s.close()
  }
}, 30000)
