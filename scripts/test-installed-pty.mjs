import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { root } from './packed-packages.mjs'

const launcher = join(
  root,
  '.tmp',
  'install',
  'prefix',
  'lib',
  'node_modules',
  'gildforge',
  'bin',
  'gild.js',
)
const require = createRequire(launcher)
const platform = require.resolve(
  `@gildforge/cli-${process.platform}-${process.arch}/package.json`,
)
mkdirSync(join(root, '.tmp'), { recursive: true })
const home = mkdtempSync(join(root, '.tmp', 'installed-pty-home-'))
const child = spawn(
  'bun',
  [
    'test',
    '--timeout',
    '30000',
    'src/spawn.test.ts',
    'src/spawn-regressions.test.ts',
    'src/spawn-events.test.ts',
    'src/spawn-notify.test.ts',
    'src/agent-profiles.test.ts',
    'src/spawn-detach.test.ts',
    'src/spawn-nudge-pty.test.ts',
    'src/spawn-vm.test.ts',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      TEST_GILD_COMMAND: JSON.stringify(['node', launcher]),
      TEST_GILD_HOOK_COMMAND: JSON.stringify([
        join(platform, '..', 'bin', 'gild'),
      ]),
    },
  },
)
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
