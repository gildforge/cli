// Disable one behavior at a time and require a test to fail. Source is always
// restored; transcripts go to this worktree's .tmp.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const bridge = 'src/spawn-bridge.ts'
const worker = 'src/spawn-worker.ts'
const chat = 'src/chat.ts'
const queue = 'src/spawn-queue.ts'
const tui = 'src/chat-tui.ts'
const tuiTest = 'src/chat-tui.test.ts'
// [name, file, from, to, test file]
const mutations = [
  [
    'other agent filter',
    bridge,
    'm.agent.toLowerCase() !== this.opts.agent.toLowerCase() ||',
    'false ||',
    'src/spawn-bridge.test.ts',
  ],
  [
    'message id dedupe',
    bridge,
    'this.seen.has(m.message.id)',
    'false',
    'src/spawn-bridge.test.ts',
  ],
  [
    'persisted cursor',
    bridge,
    'since: this.saved.cursors[channel.repo],',
    'since: undefined,',
    'src/spawn-bridge.test.ts',
  ],
  [
    'cursor waits for typing',
    bridge,
    'if (!this.inflight.get(repo)) this.save(repo, page.cursor)',
    'this.save(repo, page.cursor)',
    'src/spawn-bridge.test.ts',
  ],
  [
    'auth failure reported',
    bridge,
    "          'error',\n          error instanceof Error",
    "          'listening',\n          error instanceof Error",
    'src/spawn-bridge.test.ts',
  ],
  [
    'delivered stage',
    queue,
    '          typed?.()\n',
    '',
    'src/spawn-bridge.test.ts',
  ],
  [
    'bridge started',
    worker,
    'void bridge.start(bridgeAbort.signal)',
    'void bridgeAbort',
    'src/spawn-bridge.test.ts',
  ],
  [
    'before/after exclusivity',
    chat,
    'if (opts.before && opts.after)',
    'if (false)',
    'src/chat.test.ts',
  ],
  ['reply-to sent', chat, 'reply_to: opts.replyTo,', '', 'src/chat.test.ts'],
  [
    'raw resume',
    chat,
    "if (after) url.searchParams.set('after', after)",
    '',
    'src/chat.test.ts',
  ],
  [
    'stream ping',
    chat,
    "if (socket.readyState === WebSocket.OPEN) socket.send('ping')",
    '',
    'src/chat.test.ts',
  ],
  // gild chat <owner/repo>: the terminal UI, driven through a PTY.
  ['tui agent state', tui, 'if (p.state) {', 'if (false) {', tuiTest],
  [
    'tui live message',
    tui,
    "frame.type === 'message' && frame.message",
    'false && frame.message',
    tuiTest,
  ],
  [
    'tui presence',
    tui,
    'view.online = new Set(frame.online)',
    'void frame.online',
    tuiTest,
  ],
  ['tui enter sends', tui, 'void send()', '', tuiTest],
  ['tui read-only guard', tui, 'if (!view.canPost) {', 'if (false) {', tuiTest],
  ['tui completion', tui, 'this.replaceWord(start, options[0])', '', tuiTest],
  [
    'tui completion cycles',
    tui,
    'c.index = (c.index + 1) % c.options.length',
    'c.index = c.index',
    tuiTest,
  ],
  [
    'tui quiet redraw',
    tui,
    'if (!changed && cursor === previousCursor) return',
    '',
    tuiTest,
  ],
  ['tui resize', tui, "output.on('resize', onResize)", '', tuiTest],
  ['tui narrow hides participants', tui, 'cols >= 72', 'cols >= 0', tuiTest],
  ['tui F2', tui, 'view.togglePanel(size().cols)', '', tuiTest],
  ['tui older pages', tui, 'if (view.atTop()) void loadOlder()', '', tuiTest],
  [
    'tui keeps place',
    tui,
    'this.scroll += this.logLines(this.bodyWidth).length - before',
    '',
    tuiTest,
  ],
  ['tui unseen count', tui, 'this.unseen += fresh', '', tuiTest],
  ['tui leaves alt screen', tui, 'output.write(LEAVE)', '', tuiTest],
  ['tui restores modes', tui, 'input.setRawMode(false)', '', tuiTest],
  ['tui SIGTERM restores', tui, "process.on('SIGTERM', onSignal)", '', tuiTest],
  ['tui NO_COLOR', tui, 'if (colour && style?.fg)', 'if (style?.fg)', tuiTest],
  [
    'tui strips escapes',
    tui,
    ".replace(/[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]/g, '')",
    '',
    tuiTest,
  ],
]
mkdirSync('.tmp', { recursive: true })
for (const [name, file, from, to, test] of mutations) {
  if (
    process.argv[2] &&
    !name.toLowerCase().includes(process.argv[2].toLowerCase())
  )
    continue
  const original = readFileSync(file, 'utf8')
  if (!original.includes(from))
    throw new Error(`Missing mutation anchor: ${name}`)
  try {
    writeFileSync(file, original.replace(from, to))
    const result = spawnSync('bun', ['test', test, '--timeout', '30000'], {
      encoding: 'utf8',
      timeout: 120000,
    })
    writeFileSync(
      `.tmp/chat-revert-${name.replace(/[^a-z0-9]+/gi, '-')}.log`,
      result.stdout + result.stderr,
    )
    if (result.error || result.status === 0)
      throw new Error(
        `Mutation not caught: ${name}: ${result.error ?? 'tests passed'}`,
      )
    console.log(
      `${name}: tests failed with behavior reverted (exit ${result.status})`,
    )
  } finally {
    writeFileSync(file, original)
  }
}
