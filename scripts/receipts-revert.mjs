import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', { recursive: true })
for (const [name, file, before, after] of [
  [
    'held',
    'src/spawn-queue.ts',
    'if (reason) for (const item of this.pending) item.held?.(reason)',
    'if (false) for (const item of this.pending) item.held?.(reason!)',
  ],
  [
    'delivered',
    'src/spawn-bridge.ts',
    "this.receipts.report(repo, m.message.cursor, { state: 'delivered' }, m.channel)",
    'void 0',
  ],
  ['read', 'src/spawn-worker.ts', '  bridge?.event(event)', '  void event'],
  [
    'failure',
    'src/spawn-receipts.ts',
    '/* Receipt outages must never interrupt the agent. */',
    "throw Error('receipt outage stops flush')",
  ],
]) {
  const fixed = readFileSync(file, 'utf8')
  assert.ok(fixed.includes(before), name + ' mutation must apply')
  const args =
    name === 'read'
      ? [
          'test',
          'src/spawn-bridge.test.ts',
          '--test-name-pattern',
          'mention bridge PTY',
        ]
      : ['test', 'src/spawn-receipts.test.ts']
  try {
    writeFileSync(file, fixed.replace(before, after))
    const r = spawnSync('bun', args, { encoding: 'utf8', timeout: 180000 })
    writeFileSync('.tmp/receipts-revert-' + name + '.log', r.stdout + r.stderr)
    assert.ok(!r.error, 'regression must fail an assertion, not time out')
    assert.notEqual(r.status, 0, 'reverted ' + name + ' must fail')
    assert.match(
      r.stdout + r.stderr,
      /expect\(|AssertionError|receipt outage stops flush/,
    )
    console.log('PASS reverted ' + name + ': effect assertion fails')
  } finally {
    writeFileSync(file, fixed)
  }
  const r = spawnSync('bun', args, { encoding: 'utf8', timeout: 180000 })
  writeFileSync(
    '.tmp/receipts-revert-' + name + '-restored.log',
    r.stdout + r.stderr,
  )
  assert.equal(r.status, 0, r.stdout + r.stderr)
}
