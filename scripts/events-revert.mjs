import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp', { recursive: true })
const cases = [
  [
    'hook-forward',
    'src/spawn-hook.ts',
    "socket!.end(JSON.stringify({ type: 'hook', agent, raw }) + '\\n')",
    "socket!.end('{}\\n')",
    'hook forwards',
  ],
  [
    'hook-timeout',
    'src/spawn-hook.ts',
    'setTimeout(done, 200)',
    'setTimeout(done, 800)',
    'hook forwards',
  ],
  [
    'hook-stdout',
    'src/spawn-hook.ts',
    'export async function runHook(args: string[]) {',
    "export async function runHook(args: string[]) { console.log('broken')",
    'hook forwards',
  ],
  [
    'claude-translation',
    'src/spawn-adapters/claude.ts',
    'translate(session, raw) {',
    'translate(session, raw) { return null;',
    'recorded native Claude',
  ],
  [
    'codex-translation',
    'src/spawn-adapters/codex.ts',
    "p?.type === 'agent-turn-complete'",
    "p?.type === 'disabled'",
    'Codex notify',
  ],
  [
    'busy-gating',
    'src/spawn-queue.ts',
    '!this.ready() || (this.structured && this.input.unsent)',
    'false',
    'structured injection',
  ],
  [
    'draft-gating',
    'src/spawn-queue.ts',
    '!this.ready() || (this.structured && this.input.unsent)',
    '!this.ready()',
    'structured injection',
  ],
  [
    'fifo',
    'src/spawn-queue.ts',
    'this.pending.shift()!',
    'this.pending.pop()!',
    'structured injection',
  ],
  [
    'fallback-timeout',
    'src/spawn-queue.ts',
    'this.structured ? 0 : this.idleMs',
    '0',
    'fallback retains',
  ],
  [
    'settings-cleanup',
    'src/spawn-adapters/claude.ts',
    'cleanup: () => rmSync(directory, { recursive: true, force: true })',
    'cleanup: () => {}',
    'Claude settings are private',
  ],
  [
    'settings-permissions',
    'src/spawn-adapters/claude.ts',
    'mode: 0o600,',
    'mode: 0o644,',
    'Claude settings are private',
  ],
  [
    'state-privacy',
    'src/spawn-report.ts',
    "notes: '',",
    'notes: "private prompt",',
    'state reporting coalesces',
  ],
  [
    'alias-argv',
    'src/spawn.ts',
    '.passThroughOptions()',
    '.allowUnknownOption()',
    'safe alias preserves',
  ],
  [
    'additive-hooks',
    'src/spawn-adapters/claude.ts',
    "extra.push('--plugin-dir', directory)",
    'void directory',
    'Claude settings are private',
  ],
  [
    'local-status',
    'src/spawn-worker.ts',
    'applyEvent(state, event)',
    'void event',
    'PTY events, hook command',
  ],
  [
    'linked-reporting',
    'src/spawn-worker.ts',
    'if (reportConfig)',
    'if (false)',
    'linked PTY sessions upload',
  ],
  [
    'terminal-backpressure',
    'src/spawn-worker.ts',
    'child.onData((data) => output.push(data))',
    'child.onData((data) => process.stdout.write(data))',
    'spawn PTY: backpressure',
    'src/spawn.test.ts',
  ],
]
for (const [
  name,
  file,
  before,
  after,
  test,
  suite = 'src/spawn-events.test.ts',
] of cases) {
  const original = readFileSync(file, 'utf8')
  if (!original.includes(before))
    throw Error('Mutation anchor missing: ' + name)
  try {
    writeFileSync(file, original.replace(before, after))
    const result = spawnSync(
      'bun',
      ['test', suite, '--test-name-pattern', test],
      { encoding: 'utf8', timeout: 25000 },
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
