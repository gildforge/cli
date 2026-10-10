import { accessSync, constants, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { shellQuote } from './spawn-adapters/types'

export function gildInvocation(): string[] {
  return import.meta.url.includes('$bunfs')
    ? [process.execPath]
    : [process.execPath, 'run', new URL('./gild.ts', import.meta.url).pathname]
}

/** Prefer plain gild only when PATH selects this exact gild. */
export function promptGild(command: string[], path = process.env.PATH ?? '') {
  const target = command.length === 1 ? command[0] : command.at(-1)!
  for (const dir of path.split(delimiter)) {
    const candidate = resolve(
      dir || '.',
      process.platform === 'win32' ? 'gild.cmd' : 'gild',
    )
    let real: string
    try {
      accessSync(candidate, constants.X_OK)
      real = realpathSync(candidate)
    } catch {
      continue
    }
    try {
      if (realpathSync(target) === real) return 'gild'
      // Resolve the published npm launcher without executing it.
      if (real.endsWith('/gildforge/bin/gild.js')) {
        const require = createRequire(real)
        const binary = join(
          dirname(
            require.resolve(
              `@gildforge/cli-${process.platform}-${process.arch}/package.json`,
            ),
          ),
          'bin',
          'gild',
        )
        if (realpathSync(binary) === realpathSync(command[0])) return 'gild'
      }
    } catch {
      /* A broken launcher still shadows ours. */
    }
    break
  }
  return command.map(shellQuote).join(' ')
}
