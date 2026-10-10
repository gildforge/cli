import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', { recursive: true })
for (const [name, file, change, pattern] of [
  [
    'conflict',
    'src/agent-instructions.ts',
    (s) => s.replace('!overwrite &&', 'false &&'),
    /local edits after sync/,
  ],
  [
    'prompt',
    'src/agent-instructions.ts',
    (s) => s.replace('this.options.enqueue(', '((..._args: unknown[]) => {} )('),
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
    const r = spawnSync('bun', ['test', 'src/agent-instructions.test.ts'], {
      encoding: 'utf8',
      timeout: 60000,
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
