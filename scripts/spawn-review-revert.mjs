import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const mutations = [
  [
    'user-config',
    'src/spawn-native.ts',
    'value === undefined ||',
    "value === undefined || name.startsWith('CLAUDE_CODE_') || name === 'CLAUDE_EFFORT' ||",
    'src/spawn-regressions.test.ts',
    'native-env',
  ],
  [
    'nested-markers',
    'src/spawn-native.ts',
    'CLAUDECODE|CLAUDE_PID|',
    '',
    'src/spawn-regressions.test.ts',
    'native-env',
  ],
  [
    'no-node',
    'src/spawn.ts',
    'process.exitCode = await runNative(agent, args)\n        } finally',
    'throw error\n        } finally',
    'src/spawn-regressions.test.ts',
    'no-node',
  ],
  [
    'no-addon',
    'src/spawn-worker.ts',
    'return fallback(error)',
    'throw error',
    'src/spawn-regressions.test.ts',
    'no-addon',
  ],
  [
    'pty-failure',
    'src/spawn-worker.ts',
    'return fallback(error)',
    'throw error',
    'src/spawn-regressions.test.ts',
    'pty-failure',
    true,
  ],
  [
    'windows',
    'src/spawn-worker.ts',
    "return fallback('PTY unavailable')",
    "throw new Error('PTY unavailable')",
    'src/spawn-regressions.test.ts',
    'windows',
  ],
  [
    'single-interrupt',
    'src/spawn-native.ts',
    'const interrupt = () => {}',
    "const interrupt = () => { child.kill('SIGINT') }",
    'src/spawn-regressions.test.ts',
    'native-interrupt',
  ],
  [
    'stale-start',
    'src/spawn-worker.ts',
    'attempt === 0 && (await removeDeadSocket(path))',
    'false',
    'src/spawn.test.ts',
    'stale-start',
  ],
]
mkdirSync('.tmp', { recursive: true })
for (const [name, file, before, after, suite, filter, last] of mutations) {
  const original = readFileSync(file, 'utf8')
  if (!original.includes(before)) throw Error(`Missing anchor: ${name}`)
  try {
    const index = last ? original.lastIndexOf(before) : original.indexOf(before)
    writeFileSync(
      file,
      original.slice(0, index) + after + original.slice(index + before.length),
    )
    const result = spawnSync('bun', ['test', suite, '-t', filter], {
      encoding: 'utf8',
      timeout: 30000,
    })
    writeFileSync(
      `.tmp/review-revert-${name}.log`,
      result.stdout + result.stderr,
    )
    if (
      result.error ||
      result.status !== 1 ||
      !result.stderr.includes('(fail)')
    )
      throw Error(`Mutation not caught by assertion: ${name}`)
    console.log(`${name}: regression fails with fix reverted (exit 1)`)
  } finally {
    writeFileSync(file, original)
  }
}
