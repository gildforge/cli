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
  prove(
    'pty-retirement-rejection',
    'src/spawn-detach.ts',
    (source) => {
      const a = source.indexOf('  let code = o.code'),
        b = source.indexOf('  const line =', a)
      return (
        source.slice(0, a) +
        '  let code = o.code\n  await o.cleanup()\n' +
        source.slice(b)
      )
    },
    'src/spawn-exit-cleanup.test.ts',
    'retirement rejection',
  ),
  prove(
    'pty-retirement-finally',
    'src/spawn-detach.ts',
    (source) => {
      const a = source.indexOf('export function retireSessionResources('),
        b = source.indexOf('export async function finalizeSessionStreams(', a)
      return (
        source.slice(0, a) +
        'export function retireSessionResources(o:any) { o.files(); o.listener(); o.endpoint() }\n' +
        source.slice(b)
      )
    },
    'src/spawn-exit-cleanup.test.ts',
    'retirement rejection',
  ),
  prove(
    'pty-bounded-retirement-exit',
    'src/spawn-worker.ts',
    (source) =>
      source.replace('setTimeout(() => process.exit(code), 750)', 'undefined'),
    'src/spawn-vm.test.ts',
    'VM worker final result: detached retirement-failure',
  ),
]
mkdirSync('.tmp', { recursive: true })
writeFileSync(
  '.tmp/pty-exit-revert-evidence.json',
  JSON.stringify(evidence, null, 2) + '\n',
)
console.log(JSON.stringify(evidence))
