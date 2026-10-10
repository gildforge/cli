import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './packed-packages.mjs'
const result = spawnSync(
  process.execPath,
  ['scripts/check-install.mjs', '--revert-node-pty'],
  {
    cwd: root,
    encoding: 'utf8',
    timeout: 300000,
  },
)
writeFileSync(
  join(root, '.tmp', 'no-install-scripts-revert.log'),
  result.stdout + result.stderr,
)
if (
  result.status === 0 ||
  !/npm warn allow-scripts/.test(result.stdout + result.stderr) ||
  !(result.stdout + result.stderr).includes(
    'global npm install emitted warnings',
  )
)
  throw new Error(
    `Old node-pty dependency did not fail the warning check:\n${result.stdout}\n${result.stderr}`,
  )
console.log(
  'PASS: old node-pty dependency emits allow-scripts warning and fails the same global-install check',
)
