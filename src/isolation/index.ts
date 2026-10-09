import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  firecrackerAvailable,
  startFirecracker,
  type FirecrackerConfig,
} from './firecracker'
import { networkState, networkStatusLine } from './network'
import { ociAvailable, startOci, type OciConfig } from './container'
import {
  LEVELS,
  labelFor,
  resolveIsolation,
  type Level,
  type Resolved,
} from './policy'
import type { Isolation } from './session'

export * from './policy'
export type { Isolation } from './session'

const level = z.enum(LEVELS)

/** `<config dir>/isolation.json`: what the owner set once on this host. */
export const hostConfigSchema = z.strictObject({
  floor: level.optional(),
  default: level.optional(),
  vm: z
    .strictObject({
      firecracker: z.string().default('firecracker'),
      kernel: z.string(),
      rootfs: z.string(),
      memoryMiB: z.number().int().min(128).default(1024),
      vcpus: z.number().int().min(1).default(2),
      egress: z.enum(['auto', 'block', 'allow']).default('auto'),
    })
    .optional(),
  container: z
    .strictObject({
      engine: z.string().default('docker'),
      image: z.string().default('ubuntu:24.04'),
      agent: z.string(),
      memory: z.string().default('2g'),
      cpus: z.string().default('2'),
      pids: z.number().int().default(512),
      egress: z.enum(['auto', 'block', 'allow']).default('auto'),
    })
    .optional(),
})
export type HostConfig = z.infer<typeof hostConfigSchema>

export async function loadHostConfig(configDir: string): Promise<HostConfig> {
  try {
    return hostConfigSchema.parse(
      JSON.parse(await readFile(join(configDir, 'isolation.json'), 'utf8')),
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`isolation.json: ${(e as Error).message}`)
  }
}

export function availableLevels(host: HostConfig): Level[] {
  const out: Level[] = []
  if (host.vm && firecrackerAvailable(host.vm)) out.push('vm')
  if (
    host.container &&
    ociAvailable(host.container.engine, host.container.agent)
  )
    out.push('container')
  // `host` (dedicated unprivileged OS user) is designed but not implemented yet.
  out.push('none')
  return out
}

export interface Request {
  flag?: Level
  job?: Level
  profile?: Level
}

export function resolveForHost(host: HostConfig, req: Request): Resolved {
  return resolveIsolation({
    ...req,
    hostDefault: host.default,
    floor: host.floor,
    available: availableLevels(host),
  })
}

const BACKEND: Record<Level, string> = {
  vm: 'firecracker',
  container: 'oci',
  host: 'unprivileged user',
  none: 'none',
}

/** One line for `gild status` and job logs. */
export function describe(resolved: Resolved, backend?: string) {
  return `isolation: ${labelFor(resolved.level, backend ?? BACKEND[resolved.level])}, requested by ${resolved.source}`
}

export async function startIsolation(
  level: Level,
  host: HostConfig,
  work: string,
  vmDir: string,
  log?: (line: string) => void,
): Promise<Isolation | null> {
  if (level === 'vm') {
    const v = host.vm!
    const cfg: FirecrackerConfig = { ...v, port: 9002 }
    return startFirecracker(cfg, work, vmDir, log)
  }
  if (level === 'container') {
    const c: OciConfig = host.container!
    return startOci(c, work, log)
  }
  return null // none: the runner keeps its existing local execution
}

export function statusLines(host: HostConfig, requested: Request = {}) {
  const available = availableLevels(host)
  const lines = [
    ...(host.vm ? [networkStatusLine(host.vm.egress, networkState())] : []),
    `isolation backends available: ${available.filter((l) => l !== 'none').join(', ') || 'none'}`,
    `isolation floor: ${host.floor ?? 'none set'}`,
    `isolation host default: ${host.default ?? 'none set'}`,
  ]
  try {
    const r = resolveForHost(host, requested)
    lines.push(describe(r))
  } catch (e) {
    lines.push(`isolation: refused (${(e as Error).message})`)
  }
  return lines
}

/** `gild runner start` calls this once: a runner that cannot isolate does not start. */
export function assertCanIsolate(host: HostConfig, flag?: Level) {
  try {
    return resolveForHost(host, { flag })
  } catch (e) {
    const message = (e as Error).message
    // Only the "nothing available" case needs the how-to-fix text; a floor or
    // availability refusal already says exactly what is wrong.
    throw new Error(
      message.includes('no isolation backend')
        ? `${message}. This runner would run workflow steps with no isolation. ` +
            `Fix it by describing a microVM or container backend in <config dir>/isolation.json ` +
            `(see FINDINGS.md), or start with --isolation none to run unisolated on purpose.`
        : message,
    )
  }
}
