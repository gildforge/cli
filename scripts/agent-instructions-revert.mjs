import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', { recursive: true })
for (const [
  name,
  file,
  change,
  pattern,
  args = ['src/agent-instructions.test.ts'],
] of [
  [
    'command-sponsor',
    'src/instructions-command.ts',
    (s) => s.replace('!!(opts.edit || opts.push)', 'false'),
    /instructions command round trip/,
    ['src/agent-profiles.test.ts', '-t', 'instructions command round trip'],
  ],
  [
    'heartbeat',
    'src/spawn-report.ts',
    (s) =>
      s.replace(
        'this.pending = this.latest',
        'return; this.pending = this.latest',
      ),
    /idle runtime heartbeat/,
  ],
  [
    'native-overrides',
    'src/runtime-report.ts',
    (s) =>
      s.replace(
        'const settings = { ...defaults }',
        'args = []; const settings = { ...defaults }',
      ),
    /native launch overrides/,
  ],
  [
    'preferences',
    'src/spawn.ts',
    (s) => s.replace('if (remote.preferences) {', 'if (false) {'),
    /profile-instructions/,
    ['src/agent-profiles.test.ts', '-t', 'profile PTY: profile-instructions'],
  ],
  [
    'running-instructions',
    'src/spawn-worker.ts',
    (s) =>
      s.replace('if (target && options.instructionTarget) {', 'if (false) {'),
    /profile-instructions/,
    ['src/agent-profiles.test.ts', '-t', 'profile PTY: profile-instructions'],
  ],
  [
    'conflict',
    'src/agent-instructions.ts',
    (s) => s.replace('!overwrite &&', 'false &&'),
    /local edits after sync/,
  ],
  [
    'prompt',
    'src/agent-instructions.ts',
    (s) =>
      s.replace('this.options.enqueue(', '((..._args: unknown[]) => {} )('),
    /web instruction edits sync/,
  ],
  [
    'environment',
    'src/spawn-report.ts',
    (s) => s.replace('...(this.environment', '...(undefined'),
    /runtime reports include/,
  ],
]) {
  const original = readFileSync(file, 'utf8'),
    mutated = change(original)
  assert.notEqual(mutated, original, name)
  try {
    writeFileSync(file, mutated)
    const r = spawnSync('bun', ['test', ...args], {
      encoding: 'utf8',
      timeout: 90000,
    })
    writeFileSync(`.tmp/instructions-revert-${name}.log`, r.stdout + r.stderr)
    assert.notEqual(r.status, 0, name)
    assert.match(r.stderr, pattern, name)
    assert.doesNotMatch(r.stderr, /SyntaxError|Cannot find module/)
    console.log(`PASS ${name}: effect assertion fails with fix removed`)
  } finally {
    writeFileSync(file, original)
  }
}
