import { agentEnvironment as baseEnvironment } from './spawn-native'
import {
  accessSync,
  constants,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from 'node:fs'
import { basename, delimiter, resolve } from 'node:path'
/** Resolve PATH without executing shims; aliases are expanded by the caller's shell. */
export function realAgent(
  agent: string,
  cwd = process.cwd(),
  platform = process.platform,
): string {
  // Native Windows spawning owns executable-suffix lookup.
  if (platform === 'win32') return agent
  let visited: string[] = []
  try {
    const chain = JSON.parse(process.env.GILD_SPAWN_CHAIN ?? '[]')
    if (Array.isArray(chain))
      visited = chain.filter((p): p is string => typeof p === 'string')
  } catch {}
  const candidates = agent.includes('/')
    ? [resolve(cwd, agent)]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .map((dir) => resolve(cwd, dir || '.', agent))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      const real = realpathSync(candidate)
      if (visited.includes(real)) continue
      if (real === realpathSync(process.execPath) && basename(agent) === 'gild')
        continue
      // Shell/script wrappers that re-enter gild cannot be the native agent.
      const fd = openSync(candidate, 'r')
      const buffer = Buffer.alloc(8192)
      let prefix: string
      try {
        prefix = buffer
          .subarray(0, readSync(fd, buffer, 0, buffer.length, 0))
          .toString()
      } finally {
        closeSync(fd)
      }
      if (prefix.startsWith('#!') && /\bgild\s+spawn\b/.test(prefix)) continue
      if (basename(real) === 'gild' || basename(real) === 'gild.js') continue
      return candidate
    } catch {}
  }
  throw new Error(
    `No native ${agent} executable found on PATH (gild spawn wrappers are skipped)`,
  )
}
export function agentEnvironment(binary?: string, allowlist?: string[]) {
  const env = baseEnvironment()
  const baseline = ['PATH', 'HOME', 'TERM', 'LANG', 'USER', 'SHELL', 'TMPDIR']
  for (const name of Object.keys(env)) {
    if (allowlist && !allowlist.includes(name) && !baseline.includes(name))
      delete env[name]
  }

  let chain: string[] = []
  try {
    const previous = JSON.parse(process.env.GILD_SPAWN_CHAIN ?? '[]')
    if (Array.isArray(previous))
      chain = previous.filter((p): p is string => typeof p === 'string')
  } catch {}
  if (binary && process.platform !== 'win32') {
    const fd = openSync(binary, 'r'),
      prefix = Buffer.alloc(2)
    let script = false
    try {
      script = readSync(fd, prefix, 0, 2, 0) === 2 && prefix.toString() === '#!'
    } finally {
      closeSync(fd)
    }
    // Native executables cannot re-enter gild as shell shims. Do not carry their
    // paths into an agent's own later spawn command.
    if (script) chain.push(realpathSync(binary))
    else chain = []
  }
  env.GILD_SPAWN_CHAIN = JSON.stringify(chain)
  return env
}
