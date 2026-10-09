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
export function realAgent(agent: string): string {
  let visited: string[] = []
  try {
    const chain = JSON.parse(process.env.GILD_SPAWN_CHAIN ?? '[]')
    if (Array.isArray(chain))
      visited = chain.filter((p): p is string => typeof p === 'string')
  } catch {}
  const candidates = agent.includes('/')
    ? [resolve(agent)]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .map((dir) => resolve(dir || '.', agent))
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
export function agentEnvironment(binary?: string) {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CODEX_SESSION_ID|CODEX_THREAD_ID)$/.test(
        name,
      ) ||
      name.startsWith('CLAUDE_CODE_')
    )
      continue
    env[name] = value
  }
  let chain: string[] = []
  try {
    const previous = JSON.parse(process.env.GILD_SPAWN_CHAIN ?? '[]')
    if (Array.isArray(previous))
      chain = previous.filter((p): p is string => typeof p === 'string')
  } catch {}
  if (binary) {
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
  env.GILD_SPAWN_DEPTH = String(Number(process.env.GILD_SPAWN_DEPTH ?? 0) + 1)
  return env
}
