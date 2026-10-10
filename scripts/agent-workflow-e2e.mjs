import { spawnSync } from 'node:child_process'
const result = spawnSync(
  'bun',
  ['test', '--timeout', '60000', 'src/agent-workflow.e2e.test.ts'],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
