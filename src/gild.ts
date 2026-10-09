#!/usr/bin/env bun
import { runHook } from './spawn-hook'
if (process.argv[2] === 'hook') {
  // Hook failures are intentionally silent and never change agent behavior.
  await runHook(process.argv.slice(3)).catch(() => {})
  process.exit(0)
} else {
  const { main } = await import('./gild-main')
  await main()
}
