import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const path = 'src/gild-main.ts',
  before = readFileSync(path, 'utf8'),
  after = before.replace('environmentCommands(program, chatClient)', '')
mkdirSync('.tmp', { recursive: true })
try {
  writeFileSync(path, after)
  const r = spawnSync('bun', ['test', 'src/environments.test.ts'], {
    encoding: 'utf8',
    timeout: 60000,
  })
  writeFileSync('.tmp/environment-command-revert.log', r.stdout + r.stderr)
  if (
    r.status === 0 ||
    !/secret set reads stdin|var set reads stdin/.test(r.stdout + r.stderr)
  )
    throw Error(
      'Removing production CLI registration did not fail the stdin commands',
    )
  console.log(
    'PASS: reverted CLI command registration fails all four actual stdin secret/variable command tests',
  )
} finally {
  writeFileSync(path, before)
}
