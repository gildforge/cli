#!/usr/bin/env bun
import { runHook } from './spawn-hook'
if (process.argv[2] === 'hook') {
  // Hook failures are intentionally silent and never change agent behavior.
  await runHook(process.argv.slice(3)).catch(() => {})
  process.exit(0)
} else if (process.argv[2] === '__main-worker') {
  const { runLocalMain } = await import('./local-main')
  await runLocalMain()
} else if (process.argv[2] === '__vm-worker') {
  // VM sessions use the compiled Bun runtime for descriptor-anchored sync.
  await import('./spawn-worker')
} else {
  const { main } = await import('./gild-main')
  await main()
}
