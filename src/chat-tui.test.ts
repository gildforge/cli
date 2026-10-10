// `gild chat <owner/repo>` driven through a real PTY against the fake forge:
// what the screen shows, live frames, sending, @-completion, resizing and a
// clean exit. TEST_GILD_COMMAND runs the same tests through the installed
// npm launcher (scripts/test-installed-pty.mjs).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setup } from './chat-forge'
import { VirtualTerminal } from './vt'

const command = () =>
  process.env.TEST_GILD_COMMAND
    ? (JSON.parse(process.env.TEST_GILD_COMMAND) as string[])
    : [process.execPath, 'run', resolve('src/gild.ts')]

type Forge = Awaited<ReturnType<typeof setup>>

/** gild in a PTY, wrapped in a shell that records the terminal modes
 *  (`stty -g`) before it starts and after it exits. */
function open(
  s: Forge,
  args: string[],
  size = { cols: 100, rows: 16 },
  env: Record<string, string> = {},
) {
  const vt = new VirtualTerminal(size.cols, size.rows)
  let raw = ''
  const decoder = new TextDecoder()
  const before = join(s.root, 'stty.before'),
    after = join(s.root, 'stty.after')
  const base = { ...process.env }
  delete base.NO_COLOR
  const proc = Bun.spawn(
    [
      'sh',
      '-c',
      'stty -g >"$STTY_BEFORE"; "$@"; code=$?; stty -g >"$STTY_AFTER"; exit $code',
      'sh',
      ...command(),
      '--config-dir',
      s.root,
      'chat',
      ...args,
      // Humans name the forge; an agent uses the server it joined.
      ...(args.includes('--agent') || args.includes('--server')
        ? []
        : ['--server', s.origin]),
    ],
    {
      env: {
        ...base,
        TERM: 'xterm-256color',
        TZ: 'UTC',
        STTY_BEFORE: before,
        STTY_AFTER: after,
        ...env,
      },
      terminal: {
        ...size,
        data(_t, chunk) {
          const text = decoder.decode(chunk, { stream: true })
          raw += text
          vt.write(text)
        },
      },
    },
  )
  const waitFor = async (check: (screen: string) => boolean, what: string) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (check(vt.text())) return vt.text()
      await Bun.sleep(20)
    }
    throw new Error(`screen never showed ${what}:\n${vt.text()}`)
  }
  return {
    vt,
    proc,
    raw: () => raw,
    type: (text: string) => proc.terminal!.write(text),
    resize(cols: number, rows: number) {
      vt.resize(cols, rows)
      proc.terminal!.resize(cols, rows)
    },
    waitFor,
    /** Wait until the screen shows `text`, then until it stops changing. */
    async settle(text: string) {
      await waitFor((screen) => screen.includes(text), JSON.stringify(text))
      let last = ''
      while (last !== vt.text()) {
        last = vt.text()
        await Bun.sleep(80)
      }
      return last
    },
    stty: () => [readFileSync(before, 'utf8'), readFileSync(after, 'utf8')],
    async quit() {
      proc.terminal!.write('\x03')
      return proc.exited
    },
  }
}

function seed(s: Forge) {
  s.state.participants = [
    {
      name: 'sami',
      kind: 'human',
      prefix: '@',
      sponsor: null,
      scopes: [],
      online: true,
    },
    {
      name: 'bob',
      kind: 'human',
      prefix: '+',
      sponsor: null,
      scopes: [],
      online: false,
    },
    {
      name: 'alice/test',
      kind: 'agent',
      prefix: '+',
      sponsor: 'alice',
      scopes: ['channel:write'],
      online: true,
      state: {
        status: 'busy',
        tool: 'Edit',
        last_activity: '2026-10-09T10:04:00.000Z',
      },
    },
    {
      name: 'ava/orch',
      kind: 'agent',
      prefix: '%',
      sponsor: 'ava',
      scopes: ['repo:write'],
      online: false,
      state: {
        status: 'waiting',
        last_activity: '2026-10-09T10:04:00.000Z',
      },
    },
  ]
  s.post(
    'sami',
    '@alice/test can you look at #12? The parser drops the last token.',
  )
  s.post('alice/test', 'on it', '1', { created_at: '2026-10-09T10:02:00.000Z' })
  s.post('alice/test', 'alice/test opened PR #13', null, {
    kind: 'system',
    created_at: '2026-10-09T10:05:00.000Z',
    link: { href: '/owner/demo/pulls/13', label: 'fix: keep the last token' },
  })
}

test('renders history, participants with prefixes and states, and the input line', async () => {
  const s = await setup()
  try {
    seed(s)
    const tui = open(s, ['owner/demo'])
    const screen = await tui.settle('● live')
    expect(screen.split('\n')).toHaveLength(16)
    for (const text of [
      '#demo',
      'Channels',
      '>#demo',
      '#bob/topic [3]',
      'archived',
      'HUMANS',
      '● @sami',
      'AGENTS',
      'busy · Edit',
      'parser drops the last',
      'fix: keep the last token',
      'sami ›',
    ])
      expect(screen).toContain(text)

    // The link is a real OSC 8 hyperlink to the forge page; the agent's
    // mention of the viewer is not, but sami's own nick is bold.
    expect(tui.raw()).toContain(`\x1b]8;;${s.origin}/owner/demo/pulls/13\x1b\\`)
    expect(tui.vt.altScreen).toBe(true)
    expect(await tui.quit()).toBe(0)
  } finally {
    await s.close()
  }
}, 30000)

test('a live message, a mention of the viewer and presence arrive over the stream', async () => {
  const s = await setup()
  try {
    seed(s)
    const tui = open(s, ['owner/demo'])
    await tui.settle('● live')
    s.post('alice/test', '@sami PR #13 is green', null, {
      created_at: '2026-10-09T10:07:00.000Z',
    })
    const screen = await tui.settle('PR #13 is green')
    expect(screen).toContain('10:07 alice/test │ @sami PR #13 is green')
    // A mention of the viewer is reversed (highlighted) on the raw bytes.
    expect(tui.raw()).toMatch(/\x1b\[0;1;7;33m@sami/)
    // Presence replaces the roster's online flags: bob arrives, alice leaves.
    s.presence(['sami', 'bob'])
    const after = await tui.settle('● +bob')
    expect(after).toContain('○ +alice/test')
    expect(after).toContain('2 humans, 0 agents online')
    // The same presence again changes nothing on screen, so nothing is written.
    const written = tui.raw().length
    s.presence(['sami', 'bob'])
    await Bun.sleep(300)
    expect(tui.raw().length).toBe(written)
    // No HTTP polling for the live message: one history read, then the socket.
    expect(
      s.seen.filter((r) => r.path.includes('/channel/messages')),
    ).toHaveLength(1)
    expect(s.seen.find((r) => r.path.includes('/stream'))!.path).toContain(
      'after=3',
    )
    expect(await tui.quit()).toBe(0)
  } finally {
    await s.close()
  }
}, 30000)

test('Enter posts like gild chat send (as the agent with --agent); the input clears', async () => {
  const s = await setup()
  try {
    seed(s)
    const tui = open(s, ['owner/demo', '--agent', 'test'])
    await tui.settle('alice/test ›')
    tui.type('hello from the terminal')
    await tui.settle('alice/test › hello from the terminal')
    tui.type('\r')
    const screen = await tui.settle('│ hello from the terminal')
    expect(s.log.at(-1)).toMatchObject({
      body: 'hello from the terminal',
      author: { name: 'alice/test', kind: 'agent' },
    })
    expect(
      s.seen.filter((r) => r.method === 'POST').map((r) => [r.auth, r.body]),
    ).toEqual([['Bearer gf_agentfixture', { body: 'hello from the terminal' }]])
    expect(screen.split('\n').at(-1)).toBe('alice/test ›')
    expect(screen).not.toContain('gf_')
    expect(await tui.quit()).toBe(0)
  } finally {
    await s.close()
  }
}, 30000)

test('a public channel opens read-only without an identity; Enter posts nothing', async () => {
  const s = await setup(undefined, true)
  try {
    seed(s)
    await unlink(`${s.root}/identity.json`)
    const tui = open(s, ['owner/demo', '--server', s.origin])
    const screen = await tui.settle('● live')
    expect(screen).toContain('● live · read-only')
    expect(screen).toContain('› read-only: run `gild auth init` to post')
    tui.type('hi\r')
    // The refusal lands on the status line (the input placeholder says the
    // same, so look there), and the typed text stays.
    const refused = await tui.waitFor(
      (t) => t.split('\n').at(-2)!.includes('── read-only: run'),
      'the refusal',
    )
    expect(refused.split('\n').at(-1)).toBe('› hi')
    await Bun.sleep(300)
    expect(s.seen.some((r) => r.method === 'POST')).toBe(false)
    expect(s.seen.every((r) => r.auth === null)).toBe(true)
    expect(await tui.quit()).toBe(0)
  } finally {
    await s.close()
  }
}, 30000)

test('Tab completes @nicks by full name or bare label, and cycles', async () => {
  const s = await setup()
  try {
    seed(s)
    const tui = open(s, ['owner/demo'])
    await tui.settle('sami ›')
    tui.type('ping @al\t')
    await tui.settle('sami › ping @alice/test')
    tui.type('and orc\t')
    await tui.settle('sami › ping @alice/test and @ava/orch')
    // Two candidates: Tab again cycles to the next.
    tui.type('\x15@a\t')
    await tui.settle('sami › @alice/test')
    tui.type('\t')
    await tui.settle('sami › @ava/orch')
    tui.type('\x15@b\t')
    await tui.settle('sami › @bob')
    tui.type('\r')
    await tui.settle('│ @bob')
    // The client validates with the contract, which trims the body.
    expect(s.log.at(-1)!.body).toBe('@bob')
    expect(await tui.quit()).toBe(0)
  } finally {
    await s.close()
  }
}, 30000)

test('resizing re-wraps the log; narrow terminals hide participants and F2 toggles them', async () => {
  const s = await setup()
  try {
    seed(s)
    const tui = open(s, ['owner/demo'])
    await tui.settle('HUMANS')
    tui.resize(60, 14)
    const narrow = await tui.settle('drops the')
    expect(narrow).not.toContain('HUMANS')
    expect(narrow.split('\n').every((l) => Bun.stringWidth(l) <= 60)).toBe(true)
    expect(narrow).toContain(
      '10:00       sami │ @alice/test can you look at #12? The\n' +
        '                 │ parser drops the last token.',
    )
    tui.type('\x1bOQ') // F2
    const shown = await tui.settle('HUMANS')
    expect(shown).toContain('│ ● @sami')
    tui.type('\x1bOQ')
    await tui.waitFor((t) => !t.includes('HUMANS'), 'the column hidden')
    tui.resize(110, 16)
    // Auto again only when asked: the explicit choice stays.
    const wide = await tui.settle('drops the last token.')
    expect(wide).not.toContain('HUMANS')
    tui.type('\x1bOQ')
    await tui.settle('HUMANS')
    expect(await tui.quit()).toBe(0)
  } finally {
    await s.close()
  }
}, 30000)

test('PgUp scrolls and pages older history in; PgDn returns to the newest', async () => {
  const s = await setup()
  try {
    for (let i = 1; i <= 130; i++) s.post('sami', `message ${i}`)
    const tui = open(s, ['owner/demo'], { cols: 80, rows: 12 })
    await tui.settle('message 130')
    for (let i = 0; i < 80 && !tui.vt.text().match(/message 1 /); i++) {
      tui.type('\x1b[5~')
      await Bun.sleep(40)
    }
    const top = await tui.settle('message 1 ')
    expect(top).toContain('↓ more below · PgDn')
    expect(s.seen.some((r) => r.path.includes('before=31'))).toBe(true)
    // A reader scrolled up keeps their place when a message arrives.
    const view = (t: string) => t.split('\n').slice(1, -2).join('\n')
    s.post('sami', 'message 131')
    expect(view(await tui.settle('↓ 1 new below · PgDn'))).toBe(view(top))
    expect(tui.vt.text()).not.toContain('message 131')
    for (let i = 0; i < 80 && !tui.vt.text().includes('message 131'); i++) {
      tui.type('\x1b[6~')
      await Bun.sleep(20)
    }
    const bottom = await tui.settle('message 131')
    expect(bottom).not.toContain('below')
    expect(await tui.quit()).toBe(0)
  } finally {
    await s.close()
  }
}, 30000)

test('Ctrl-C restores the terminal: modes, main screen, cursor, paste mode', async () => {
  const s = await setup()
  try {
    seed(s)
    const tui = open(s, ['owner/demo'])
    await tui.settle('● live')
    expect(tui.vt.altScreen).toBe(true)
    expect(tui.vt.bracketedPaste).toBe(true)
    expect(await tui.quit()).toBe(0)
    const [before, after] = tui.stty()
    expect(after).toBe(before)
    expect(tui.vt.altScreen).toBe(false)
    expect(tui.vt.cursorVisible).toBe(true)
    expect(tui.vt.bracketedPaste).toBe(false)
    expect(tui.vt.text().trim()).toBe('')
    // SIGTERM (a closing terminal tab) restores too.
    const again = open(s, ['owner/demo'])
    await again.settle('● live')
    const pid = Number(
      (await Bun.$`pgrep -P ${again.proc.pid}`.nothrow().text())
        .trim()
        .split('\n')[0],
    )
    expect(pid).toBeGreaterThan(0)
    process.kill(pid, 'SIGTERM')
    await again.proc.exited
    const [b2, a2] = again.stty()
    expect(a2).toBe(b2)
    expect(again.vt.altScreen).toBe(false)
  } finally {
    await s.close()
  }
}, 30000)

test('NO_COLOR drops colours; message text can never inject terminal escapes', async () => {
  const s = await setup()
  try {
    seed(s)
    s.post(
      'mallory',
      'evil\x1b[2J\x1b]8;;http://x\x07link\x1b]8;;\x07\x07 done @sami',
    )
    const tui = open(s, ['owner/demo'], undefined, { NO_COLOR: '1' })
    const screen = await tui.settle('● live')
    expect(screen).toContain('mallory │ evil[2J]8;;http://xlink]8;; done')
    expect(tui.raw()).not.toContain('\x1b[2J\x1b]8;;http://x')
    expect(tui.raw()).not.toMatch(/\x1b\[[0-9;]*;3[0-7](;[0-9]+)*m/)
    expect(tui.raw()).toContain('\x1b[0;1;7m@sami') // bold/reverse still mark it
    expect(await tui.quit()).toBe(0)
    const colour = open(s, ['owner/demo'])
    await colour.settle('● live')
    expect(colour.raw()).toMatch(/\x1b\[0;3[0-7]m/)
    expect(await colour.quit()).toBe(0)
  } finally {
    await s.close()
  }
}, 30000)

test('the buffer list switches channels, keeps notes dim, and archives read-only', async () => {
  const s = await setup()
  try {
    seed(s)
    const tui = open(
      s,
      ['owner/demo', '--channel', 'bob/topic', '--agent', 'test'],
      { cols: 120, rows: 28 },
    )
    let screen = await tui.settle('● live')
    expect(screen.split('\n')[0]).toContain('#bob/topic')
    expect(screen).toContain('Channels')
    expect(s.seen.some((r) => r.path.includes('channel=bob%2Ftopic'))).toBe(
      true,
    )
    tui.type('/note tests passed\r')
    await tui.settle('tests passed')
    expect(s.seen.find((r) => r.method === 'POST')!.body).toMatchObject({
      kind: 'note',
      body: 'tests passed',
    })
    expect(s.seen.find((r) => r.method === 'POST')!.path).toContain(
      'channel=bob%2Ftopic',
    )
    tui.type('/channel old\r')
    screen = await tui.waitFor(
      (text) => text.split('\n')[0].includes('#old (archived)'),
      'archived channel',
    )
    expect(screen).toContain('read-only')
    const posted = s.seen.filter((r) => r.method === 'POST').length
    tui.type('late post\r')
    await Bun.sleep(150)
    expect(s.seen.filter((r) => r.method === 'POST')).toHaveLength(posted)
    expect(await tui.quit()).toBe(0)
  } finally {
    await s.close()
  }
}, 30000)
