import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', { recursive: true })
const cases = [
  [
    'commands',
    'src/grant-requests.ts',
    ".command('request-grants <repo>')",
    ".command('reverted-request-grants <repo>')",
    'CLI grant request',
  ],
  [
    'error',
    'src/api/client.ts',
    'if(this.agentLabel && res.status===403',
    'if(false && this.agentLabel && res.status===403',
    'actual missing-scope',
  ],
  ['prompt', 'src/api/grant-request-contract.ts', 'instead of asking in chat', 'by asking in chat', 'mention and trigger'],
]
for (const [name, path, before, after, pattern] of cases) {
  const original = readFileSync(path, 'utf8')
  assert.ok(original.includes(before))
  try {
    writeFileSync(path, original.replace(before, after))
    const r = spawnSync(
      'bun',
      ['test', 'src/grant-requests.test.ts', '--test-name-pattern', pattern],
      { encoding: 'utf8', timeout: 60000 },
    )
    const log = r.stdout + r.stderr
    writeFileSync('.tmp/grant-revert-' + name + '.log', log)
    assert.notEqual(r.status, 0, name + ' must fail')
    assert.match(log, /expect\(|Expected:|AssertionError/)
    assert.doesNotMatch(log, /SyntaxError|Cannot find module/)
    console.log('PASS reverted ' + name + ' fails its CLI effect test')
  } finally {
    writeFileSync(path, original)
  }
}
