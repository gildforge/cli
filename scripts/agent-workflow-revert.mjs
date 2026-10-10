import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const base = process.argv[2] ?? 'origin/main'
const files = [
  'src/gild-main.ts',
  'src/issue.ts',
  'src/spawn-bridge.ts',
  'src/spawn-worker.ts',
  'src/gild-invocation.ts',
]
const saved = new Map(
  files.map((file) => [file, readFileSync(join(root, file), 'utf8')]),
)
mkdirSync(join(root, '.tmp'), { recursive: true })
try {
  for (const file of files.slice(0, -1)) {
    const old = spawnSync('git', ['show', `${base}:${file}`], {
      cwd: root,
      encoding: 'utf8',
    })
    if (old.status !== 0) throw Error(old.stderr)
    writeFileSync(join(root, file), old.stdout)
  }
  // This new module extracts the worker's former unconditional formatting.
  writeFileSync(
    join(root, 'src/gild-invocation.ts'),
    `import { shellQuote } from './spawn-adapters/types'\nexport function promptGild(command: string[], _path?: string) { return command.map(shellQuote).join(' ') }\n`,
  )
  const selections = [
    ['src/agent-workflow.test.ts'],
    ['src/agent-workflow.e2e.test.ts'],
    ['src/gild-invocation.test.ts'],
    ['src/spawn-bridge.test.ts', '--test-name-pattern', 'prompt is short'],
  ]
  const failures = []
  for (let i = 0; i < selections.length; i++) {
    const result = spawnSync(
      'bun',
      ['test', '--timeout', '60000', ...selections[i]],
      { cwd: root, encoding: 'utf8', timeout: 180000 },
    )
    const log = result.stdout + result.stderr
    writeFileSync(join(root, '.tmp', `agent-workflow-revert-${i}.log`), log)
    if (
      result.status === 0 ||
      result.error ||
      !/0 pass/.test(log) ||
      !/[1-9][0-9]* fail/.test(log)
    )
      throw Error(
        `Revert selection ${i} did not fail every selected test (see .tmp/agent-workflow-revert-${i}.log)`,
      )
    failures.push(log.match(/\n\s*(\d+) fail/)?.[1])
  }
  console.log(
    `PASS: every selected regression failed with the implementation reverted (${failures.join(' + ')} tests); sources restored`,
  )
} finally {
  for (const [file, content] of saved) writeFileSync(join(root, file), content)
}
