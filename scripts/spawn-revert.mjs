// Deliberately disable one behavior at a time and require its integration test to fail.
// Always restore source, and keep transcripts under this worktree's .tmp.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const worker = 'src/spawn-worker.ts'
const queue = 'src/spawn-queue.ts'
const sessions = 'src/spawn-sessions.ts'
const mutations = [
  [
    'stdin bytes / Ctrl-C',
    worker,
    '    child!.write(data)',
    "    child!.write('')",
    'bytes|ctrl-c',
  ],
  [
    'stdout bytes',
    worker,
    'process.stdout.write(data)',
    "process.stdout.write(Buffer.from(data).toString('utf8'))",
    'bytes',
  ],
  [
    'resize',
    worker,
    'child!.resize(process.stdout.columns || 80, process.stdout.rows || 24)',
    'child!.resize(80, 24)',
    'resize',
  ],
  [
    'exit code',
    worker,
    'finish(signal ? 128 + signal : exitCode, false)',
    'finish(0, false)',
    'exit',
  ],
  [
    'submit',
    worker,
    'queue.enqueue(request.message)',
    'queue.userInput()',
    'send',
  ],
  ['bracketed paste', queue, "text.includes('\\n')", 'false', 'paste'],
  ['idle', queue, 'this.idleMs - (Date.now() - this.lastInput)', '0', 'idle'],
  [
    'sanitization',
    queue,
    "message.replace(/[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]/g, '')",
    'message',
    'sanitize',
  ],
  ['env markers', worker, "name.startsWith('CLAUDE_CODE_')", 'false', 'env'],
  [
    'group cleanup',
    worker,
    'process.kill(-child.pid, signal)',
    'void signal',
    'kill|hangup',
  ],
  [
    'parent death',
    worker,
    "process.on('disconnect', () => finish(1))",
    '// disconnect handler removed',
    'parent-death',
  ],
  [
    'terminal restoration',
    worker,
    'process.stdin.setRawMode(wasRaw)',
    'void wasRaw',
    'terminal',
  ],
  [
    'socket permissions',
    worker,
    'await chmod(path, 0o600)',
    'await chmod(path, 0o644)',
    'sessions',
  ],
  [
    'stale sockets',
    sessions,
    'await unlink(path).catch(() => {})',
    'void path',
    'sessions',
  ],
  [
    'startup cleanup',
    worker,
    [
      ['server.close()', 'void server'],
      ['if (ownsSocket && path)', 'if (false && path)'],
    ],
    null,
    'startup-failure',
  ],
  ['FIFO', queue, 'this.pending.shift()!', 'this.pending.pop()!', 'fifo'],
]
mkdirSync('.tmp', { recursive: true })
for (const [name, file, before, after, filter] of mutations) {
  if (
    process.argv[2] &&
    !name.toLowerCase().includes(process.argv[2].toLowerCase())
  )
    continue
  const original = readFileSync(file, 'utf8')
  const replacements = Array.isArray(before) ? before : [[before, after]]
  for (const [from] of replacements)
    if (!original.includes(from))
      throw new Error(`Missing mutation anchor: ${name}`)
  try {
    writeFileSync(
      file,
      replacements.reduce(
        (text, [from, to]) => text.replace(from, to),
        original,
      ),
    )
    const result = spawnSync(
      'bun',
      ['test', 'src/spawn.test.ts', '-t', `spawn PTY: (${filter})$`],
      { encoding: 'utf8', timeout: 55000 },
    )
    writeFileSync(
      `.tmp/revert-${name.replace(/[^a-z0-9]+/gi, '-')}.log`,
      result.stdout + result.stderr,
    )
    if (result.error || result.status === 0)
      throw new Error(
        `Mutation not caught: ${name}: ${result.error ?? 'test passed'}`,
      )
    console.log(
      `${name}: test failed with behavior reverted (exit ${result.status})`,
    )
  } finally {
    writeFileSync(file, original)
  }
}
