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
    'debugFallback(error)',
    'throw error',
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
if (['events', 'profiles'].includes(process.argv[2]))
  mutations.push(
    [
      'notify-config',
      'src/spawn-adapters/codex-notify.ts',
      'let command = notifyCommand(',
      'let command = ([] as string[]); void notifyCommand(',
      'src/spawn-notify.test.ts',
      'Codex user notify',
    ],
    [
      'notify-chain',
      'src/spawn-hook.ts',
      "args.indexOf('--notify-command')",
      '-1',
      'src/spawn-notify.test.ts',
      'Codex user notify',
    ],
    [
      'notify-overrides',
      'src/spawn-adapters/codex-notify.ts',
      'override = notifyCommand(parse(value).notify)',
      'void parse(value)',
      'src/spawn-notify.test.ts',
      'Codex notify CLI',
    ],
    [
      'notify-profile',
      'src/spawn-adapters/codex-notify.ts',
      'command = notifyCommand(selected.notify)',
      'void selected.notify',
      'src/spawn-notify.test.ts',
      'Codex selected profile',
    ],
    [
      'windows-command',
      'src/spawn-binary.ts',
      "if (platform === 'win32') return agent",
      '',
      'src/spawn-events.test.ts',
      'Windows native fallback',
    ],
    [
      'remove-depth',
      'src/spawn-binary.ts',
      'env.GILD_SPAWN_CHAIN = JSON.stringify(chain)',
      "env.GILD_SPAWN_CHAIN = JSON.stringify(chain); env.GILD_SPAWN_DEPTH = '2'",
      'src/spawn-events.test.ts',
      'safe alias preserves',
    ],
  )
if (process.argv[2] === 'profiles')
  mutations.push(
    [
      'profile-notify-environment',
      'src/spawn-adapters/codex.ts',
      'context.environment ?? process.env',
      'process.env',
      'src/spawn-notify.test.ts',
      'Codex user notify',
    ],
    [
      'profile-baseline',
      'src/spawn-binary.ts',
      '!baseline.includes(name)',
      'true',
      'src/agent-profiles.test.ts',
      'profile piped spawn',
    ],
    [
      'profile-stale',
      'src/spawn-worker.ts',
      '(await removeDeadSocket(path))',
      'false',
      'src/agent-profiles.test.ts',
      'profile PTY: profile-stale',
    ],
  )
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
