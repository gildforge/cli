// Revert proofs for detached sessions: disable one behavior at a time and
// require the detached-session tests to fail with an assertion.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp', { recursive: true })
const cases = [
  [
    'caller-stdio',
    'src/spawn-attach.ts',
    "stdio: ['ignore', 'ignore', 'ignore', 'ipc']",
    "stdio: ['ignore', 'inherit', 'inherit', 'ipc']",
    'detached session: no-tty',
  ],
  [
    'outlives-caller',
    'src/spawn-worker.ts',
    "if (!options.detach) process.on('disconnect'",
    "process.on('disconnect'",
    'detached session: no-tty',
  ],
  [
    'status-detached',
    'src/spawn-worker.ts',
    '...host?.info,',
    '',
    'detached session: no-tty',
  ],
  [
    'fixed-size',
    'src/spawn-worker.ts',
    'cols: options.detach?.cols ?? process.stdout.columns',
    'cols: process.stdout.columns',
    'detached session: no-tty',
  ],
  [
    'ring-replay',
    'src/spawn-detach.ts',
    'socket.write(this.ring.snapshot())',
    'void 0',
    'detached session: attach',
  ],
  [
    'attach-input',
    'src/spawn-detach.ts',
    "this.options.input(Buffer.from(frame.d, 'base64'))",
    'void frame',
    'detached session: attach',
  ],
  [
    'attach-draft',
    'src/spawn-worker.ts',
    'input: (data) => queue?.userInput(data)',
    'input: (data) => child?.write(data.toString())',
    'detached session: attach',
  ],
  [
    'one-interactive',
    'src/spawn-detach.ts',
    'if (interactive && this.info.interactive)',
    'if (false)',
    'detached session: attach',
  ],
  [
    'detach-key',
    'src/spawn-attach.ts',
    '      byKey = true\n      socket.end()',
    '      byKey = true',
    'detached session: attach',
  ],
  [
    'restore-size',
    'src/spawn-detach.ts',
    'this.options.resize(this.options.cols, this.options.rows)',
    'void 0',
    'detached session: attach',
  ],
  [
    'exited-event',
    'src/spawn-worker.ts',
    '  announceExit(code)\n',
    '  void code\n',
    'detached session: stop',
  ],
  [
    'stop-escalation',
    'src/spawn-worker.ts',
    "    killGroup('SIGKILL')\n    // Should the PTY",
    '    // Should the PTY',
    'detached session: stop',
  ],
  [
    'stop-cleanup',
    'src/spawn-worker.ts',
    '  host?.cleanup()\n',
    '',
    'detached session: stop',
  ],
  [
    'log-rotation',
    'src/spawn-detach.ts',
    "renameSync(this.path, this.path + '.1')",
    'void 0',
    'the output log is private',
  ],
  [
    'ring-bound',
    'src/spawn-detach.ts',
    'while (this.size > this.limit)',
    'while (false)',
    'the output ring keeps',
  ],
]
const only = process.argv.slice(2)
for (const [name, file, before, after, test] of cases) {
  if (only.length && !only.includes(name)) continue
  const original = readFileSync(file, 'utf8')
  if (!original.includes(before))
    throw Error('Mutation anchor missing: ' + name)
  try {
    writeFileSync(file, original.replace(before, after))
    const result = spawnSync(
      'bun',
      ['test', 'src/spawn-detach.test.ts', '--test-name-pattern', test],
      { encoding: 'utf8', timeout: 90000 },
    )
    writeFileSync('.tmp/revert-' + name + '.log', result.stdout + result.stderr)
    if (result.status === 0) throw Error('Mutation survived: ' + name)
    // Require an assertion failure, rather than accepting syntax/type/build errors.
    if (!result.stderr.includes('(fail)'))
      throw Error('No test assertion failed: ' + name)
    console.log(name + ': reverted behavior fails (' + result.status + ')')
  } finally {
    writeFileSync(file, original)
  }
}
