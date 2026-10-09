import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', { recursive: true })
const cases = [
  [
    'auth',
    'src/import/auth.ts',
    '  if (anonymous) return undefined',
    '  return undefined\n  if (anonymous) return undefined',
    'local env and gh auth',
  ],
  [
    'checkpoint',
    'src/import/execute.ts',
    'await flush(event.checkpoint)',
    'checkpoint = event.checkpoint',
    'local env and gh auth',
  ],
  [
    'snapshot',
    'src/import/snapshot.ts',
    'if (saved !== null)',
    'if (false)',
    'local env and gh auth',
  ],
  [
    'noop',
    'src/import/git.ts',
    'if (remote?.split(/\\s+/)[0] !== oid)',
    'if (true)',
    'an already copied PR head',
  ],
  [
    'git-reason',
    'src/import/git.ts',
    'return line\n',
    "return ''\n  return line\n",
    'Git error details',
  ],
]
for (const [name, path, before, after, pattern] of cases) {
  const original = readFileSync(path, 'utf8')
  try {
    assert.ok(original.includes(before), name)
    writeFileSync(path, original.replace(before, after))
    const r = spawnSync(
      'bun',
      ['test', '--test-name-pattern', pattern, 'src/import.test.ts'],
      { encoding: 'utf8', timeout: 60000 },
    )
    writeFileSync('.tmp/revert-' + name + '.log', r.stdout + r.stderr)
    assert.notEqual(r.status, 0, name + ' must fail with behavior removed')
    assert.match(r.stdout + r.stderr, /expect\(|AssertionError/)
    assert.doesNotMatch(r.stdout + r.stderr, /SyntaxError/)
    console.log('PASS revert ' + name)
  } finally {
    writeFileSync(path, original)
  }
}
const restored = spawnSync('bun', ['test', 'src/import.test.ts'], {
  encoding: 'utf8',
  timeout: 60000,
})
assert.equal(restored.status, 0, restored.stdout + restored.stderr)
console.log('PASS restored import tests')
