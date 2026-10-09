import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'

function notifyCommand(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === 'string'))
    throw new Error('Codex notify must be an array of strings')
  return value
}
async function config(path: string) {
  try {
    return parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return {}
  }
}
/** Resolve notification layers only; project config cannot set notify. */
export async function originalNotify(
  args: string[],
  environment = process.env,
) {
  const home =
    environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), '.codex')
  const system = await config('/etc/codex/config.toml')
  const user = await config(join(home, 'config.toml'))
  let command = notifyCommand(user.notify ?? system.notify)
  let profile = user.profile ?? system.profile
  let explicitProfile: string | undefined
  let override: string[] | undefined
  const remaining: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      remaining.push(...args.slice(i))
      break
    }
    if (arg === '-p' || arg === '--profile') {
      explicitProfile = args[i + 1]
      remaining.push(arg, args[++i])
      continue
    }
    if (arg.startsWith('--profile=')) explicitProfile = arg.slice(10)
    else if (arg.startsWith('-p') && arg.length > 2)
      explicitProfile = arg.slice(2)
    const separate = arg === '-c' || arg === '--config'
    const value = separate
      ? args[i + 1]
      : arg.startsWith('--config=')
        ? arg.slice(9)
        : arg.startsWith('-c')
          ? arg.slice(2)
          : undefined
    if (value && /^\s*notify\s*=/.test(value)) {
      override = notifyCommand(parse(value).notify)
      if (separate) i++
    } else {
      if (value && /^\s*profile\s*=/.test(value)) profile = parse(value).profile
      remaining.push(arg)
    }
  }
  profile = explicitProfile ?? profile
  if (profile !== undefined) {
    if (typeof profile !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(profile))
      throw new Error('Invalid Codex profile name')
    const selected = await config(join(home, `${profile}.config.toml`))
    if (selected.notify !== undefined) command = notifyCommand(selected.notify)
  }
  if (override !== undefined) command = override
  return { command, args: remaining }
}
