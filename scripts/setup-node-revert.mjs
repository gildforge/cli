import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

mkdirSync('.tmp', { recursive: true })
const path = 'src/runner.ts',
  original = readFileSync(path, 'utf8')
const start = original.indexOf(
    "          } else if (action === 'actions/setup-node') {",
  ),
  end = original.indexOf('          } else if (tool) {', start)
assert.ok(start > 0 && end > start, 'upstream setup-node branch must exist')
try {
  // Restore the previous installed-version-check behavior, retaining the tests.
  writeFileSync(path, original.slice(0, start) + original.slice(end))
  const result = spawnSync('bun', ['test', 'src/runner-setup-node.test.ts'], {
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
  })
  writeFileSync('.tmp/setup-node-revert.log', result.stdout + result.stderr)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /3 fail/)
  assert.match(result.stderr, /expect\(/)
  console.log(
    'PASS revert: latest, 24 and 22 fail when upstream setup-node execution is removed; runner source restored',
  )
} finally {
  writeFileSync(path, original)
}
