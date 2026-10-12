// Real socket regression: cleanup moved after final wire delivery must fail.
import { mkdirSync, writeFileSync } from 'node:fs'
import { prove } from './review-revert.mjs'
const evidence = [
  prove(
    'pty-cleanup-before-exit',
    'src/spawn-detach.ts',
    (source) =>
      source
        .replace('  await o.cleanup()', '')
        .replace(
          '    clearTimeout(timer)',
          '    await o.cleanup()\n    clearTimeout(timer)',
        ),
    'src/spawn-exit-cleanup.test.ts',
    'final exit and EOF',
  ),
]
mkdirSync('.tmp', { recursive: true })
writeFileSync(
  '.tmp/pty-exit-revert-evidence.json',
  JSON.stringify(evidence, null, 2) + '\n',
)
console.log(JSON.stringify(evidence))
