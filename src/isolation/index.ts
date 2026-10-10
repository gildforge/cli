import { z } from 'zod'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  firecrackerAvailable,
  firecrackerHostReady,
  startFirecracker,
  type FirecrackerConfig,
} from './firecracker'
import { networkState, networkStatusLine } from './network'
import {
  startVz,
  vzAvailable,
  vzHostReady,
  vzNetworkState,
  vzNetworkStatusLine,
} from './vz'
import { ociAvailable, startOci, type OciConfig } from './container'
import {
  colimaMountFor,
  colimaStatusLine,
  detectColima,
  systemColimaProbe,
  type ColimaState,
} from './colima'
import {
  hostUserState,
  startHostUser,
  systemProbe,
  type HostUserState,
} from './host-user'
import {
  IsolationRefused,
  LEVELS,
  labelFor,
  resolveIsolation,
  type Level,
  type Resolved,
} from './policy'
import {
  ensureVmImage,
  vmImagePaths,
  vmPlatform,
  VmImageError,
  type VmPlatform,
} from './image'
import type { Isolation } from './session'

export * from './policy'
export type { Isolation } from './session'
export { vmImagePaths } from './image'

const level = z.enum(LEVELS)

/** `<config dir>/isolation.json`: what the owner set once on this host. */
export const hostConfigSchema = (configDir: string) =>
  z.strictObject({
    floor: level.optional(),
    default: level.optional(),
    vm: z
      .strictObject({
        firecracker: z.string().default('firecracker'),
        /** macOS: the signed Virtualization.framework helper: the published
         *  one in <config dir>/vm when it was fetched, else `gild-vz` on PATH
         *  (scripts/build-vz-helper.sh). */
        vz: z
          .string()
          .default(() =>
            existsSync(vmImagePaths(configDir).vz)
              ? vmImagePaths(configDir).vz
              : 'gild-vz',
          ),
        kernel: z.string().default(vmImagePaths(configDir).kernel),
        rootfs: z.string().default(vmImagePaths(configDir).rootfs),
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
    /** `host` level: the dedicated OS user scripts/host-user-setup.sh created. */
    host: z
      .strictObject({
        user: z.string().regex(/^gild-[a-z0-9-]{1,30}$/),
      })
      .optional(),
  })
export type HostConfig = z.infer<ReturnType<typeof hostConfigSchema>>
export type VmConfig = NonNullable<HostConfig['vm']>

/** The `vm` level's backend: Virtualization.framework on macOS, Firecracker elsewhere. */
export const vmBackend = (platform: NodeJS.Platform = process.platform) =>
  platform === 'darwin' ? 'vz' : 'firecracker'

export function vmAvailable(
  vm: VmConfig,
  platform: NodeJS.Platform = process.platform,
) {
  return vmBackend(platform) === 'vz'
    ? vzAvailable({ helper: vm.vz, kernel: vm.kernel, rootfs: vm.rootfs })
    : firecrackerAvailable(vm)
}

/** Boot one microVM with `work` at /workspace, on this platform's backend. */
export function startVm(
  vm: VmConfig,
  work: string,
  vmDir: string,
  log?: (line: string) => void,
  platform: NodeJS.Platform = process.platform,
): Promise<Isolation> {
  if (vmBackend(platform) === 'vz')
    return startVz({ ...vm, helper: vm.vz, port: 9002 }, work, vmDir, log)
  const cfg: FirecrackerConfig = { ...vm, port: 9002 }
  return startFirecracker(cfg, work, vmDir, log)
}

export async function loadHostConfig(configDir: string): Promise<HostConfig> {
  try {
    return hostConfigSchema(configDir).parse(
      JSON.parse(await readFile(join(configDir, 'isolation.json'), 'utf8')),
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`isolation.json: ${(e as Error).message}`)
  }
}

/** The level a run asks for, before availability: what decides whether the
 *  published VM image is worth fetching. */
export const requestedLevel = (host: HostConfig, req: Request) =>
  req.flag ?? req.job ?? req.profile ?? host.default

export interface PreparedVm {
  host: HostConfig
  /** Why the published VM image could not be fetched; `vm` then falls to the next tier. */
  vmUnavailable?: string
}

/**
 * Load isolation.json and, when this run asks for `vm` and the owner did not
 * point it at their own kernel and rootfs, make sure the published guest
 * image for this gild version is in <config dir>/vm (downloaded once, then
 * used offline) and describe `vm` with it.
 */
export async function prepareVm(
  configDir: string,
  o: {
    want: boolean
    log?: (line: string) => void
    base?: string
    platform?: VmPlatform
    /** The backend's own prerequisites (Firecracker, /dev/kvm) are present. */
    backendReady?: (host: HostConfig) => boolean
  },
): Promise<PreparedVm> {
  const host = await loadHostConfig(configDir)
  if (!o.want) return { host }
  const paths = vmImagePaths(configDir)
  if (
    host.vm &&
    (resolve(host.vm.kernel) !== paths.kernel ||
      resolve(host.vm.rootfs) !== paths.rootfs)
  )
    return { host } // the owner's own image: theirs to manage
  const platform = o.platform ?? vmPlatform()
  const ready =
    o.backendReady ??
    ((h: HostConfig) =>
      vmBackend() === 'vz'
        ? vzHostReady()
        : firecrackerHostReady(h.vm?.firecracker ?? 'firecracker'))
  // No Firecracker, /dev/kvm or hypervisor: an image would not help; vmAvailable says what is missing.
  if (platform && !ready(host)) return { host }
  try {
    await ensureVmImage({ configDir, log: o.log, base: o.base, platform })
  } catch (e) {
    if (!(e instanceof VmImageError)) throw e
    return { host, vmUnavailable: e.message }
  }
  // Load again after the download: the vz helper default looks in <config dir>/vm.
  const fresh = await loadHostConfig(configDir)
  return {
    host: {
      ...fresh,
      vm: fresh.vm ?? hostConfigSchema(configDir).parse({ vm: {} }).vm,
    },
  }
}

/** What this machine can do; tests pass their own. */
export interface Probes {
  platform: NodeJS.Platform
  /** The `vm` backend (vmBackend) works with this config. */
  vm(vm: VmConfig): boolean
  oci(engine: string, agent: string, endpoint?: string): boolean
  colima(): ColimaState
  hostUser(user: string): HostUserState
}

export const systemProbes = (): Probes => ({
  platform: process.platform,
  vm: (v) => vmAvailable(v),
  oci: ociAvailable,
  colima: () => detectColima(systemColimaProbe()),
  hostUser: (user) => hostUserState(user, systemProbe()),
})

export interface Detected {
  levels: Level[]
  /** One line per backend that is configured or detected, for `gild status`. */
  notes: string[]
  colima?: ColimaState
  hostUser?: HostUserState
}

export function detect(host: HostConfig, p: Probes = systemProbes()): Detected {
  const levels: Level[] = [],
    notes: string[] = []
  if (host.vm && p.vm(host.vm)) levels.push('vm')
  let colima: ColimaState | undefined
  if (p.platform === 'darwin') {
    // macOS has no local OCI kernel: containers run inside Colima's VM.
    colima = p.colima()
    notes.push(colimaStatusLine(colima))
    if (host.container && colima.running) {
      if (!colimaMountFor(host.container.agent, colima.mounts, false))
        notes.push(
          `container: agent ${host.container.agent} is outside Colima's mounts`,
        )
      else if (
        p.oci(host.container.engine, host.container.agent, colima.socket)
      )
        levels.push('container')
    }
  } else if (
    host.container &&
    p.oci(host.container.engine, host.container.agent)
  )
    levels.push('container')
  let hostUser: HostUserState | undefined
  if (host.host) {
    hostUser = p.hostUser(host.host.user)
    notes.push(
      hostUser.ok
        ? `host tier: configured, steps run as ${host.host.user} (uid ${hostUser.marker.uid}), LAN ${hostUser.marker.network === 'lan-denied' ? 'denied' : 'not filtered'}`
        : `host tier: not configured (${hostUser.reason}); ${hostUser.fix}`,
    )
    if (hostUser.ok) levels.push('host')
  }
  levels.push('none')
  return { levels, notes, colima, hostUser }
}

export function availableLevels(host: HostConfig, p?: Probes): Level[] {
  return detect(host, p).levels
}

export interface Request {
  flag?: Level
  job?: Level
  profile?: Level
}

/**
 * Resolve a run's isolation. With `vmUnavailable` (the published VM image
 * could not be fetched), a request for `vm` falls to the strongest other
 * tier the floor allows, never to `none`, and the result says so.
 */
export function resolveForHost(
  host: HostConfig,
  req: Request,
  p?: Probes,
  vmUnavailable?: string,
): Resolved {
  const available = availableLevels(host, p)
  const input = {
    ...req,
    hostDefault: host.default,
    floor: host.floor,
    available,
  }
  try {
    return resolveIsolation(input)
  } catch (e) {
    if (
      !vmUnavailable ||
      !(e instanceof IsolationRefused) ||
      requestedLevel(host, req) !== 'vm' ||
      available.includes('vm')
    )
      throw e
    let next: Resolved
    try {
      next = resolveIsolation({ floor: host.floor, available })
    } catch (e2) {
      throw new IsolationRefused(
        `isolation "vm" is unavailable: ${vmUnavailable}; and no other tier can take it: ${(e2 as Error).message}`,
      )
    }
    const source = resolveIsolation({
      ...input,
      available: [...available, 'vm'],
    }).source
    return {
      level: next.level,
      source,
      fallback: `vm image unavailable, fell back to ${next.level}: ${vmUnavailable}`,
    }
  }
}

const BACKEND: Record<Exclude<Level, 'vm'>, string> = {
  container: 'oci',
  host: 'dedicated OS user',
  none: 'none',
}

export const backendName = (level: Level, platform = process.platform) =>
  level === 'vm'
    ? vmBackend(platform)
    : level === 'container' && platform === 'darwin'
      ? 'oci in Colima VM'
      : BACKEND[level]

/** One line for `gild status` and job logs. */
export function describe(resolved: Resolved, backend?: string) {
  const line = `isolation: ${labelFor(resolved.level, backend ?? backendName(resolved.level))}, requested by ${resolved.source}`
  return resolved.fallback ? `${line} (${resolved.fallback})` : line
}

export async function startIsolation(
  level: Level,
  host: HostConfig,
  work: string,
  vmDir: string,
  log?: (line: string) => void,
  p: Probes = systemProbes(),
): Promise<Isolation | null> {
  if (level === 'vm') return startVm(host.vm!, work, vmDir, log, p.platform)
  if (level === 'container') {
    const c: OciConfig = host.container!
    if (p.platform !== 'darwin') return startOci(c, work, log)
    const colima = p.colima()
    if (!colima.running)
      throw new Error(`container: ${colima.reason}; ${colima.fix}`)
    if (!colimaMountFor(work, colima.mounts, true))
      throw new Error(
        `container: ${work} is not inside a writable Colima mount (${colima.mounts.map((m) => m.location).join(', ')}). ` +
          `Needs Sami: add it under mounts in ~/.colima/default/colima.yaml, then colima restart`,
      )
    return startOci(
      { ...c, host: colima.socket, where: `Colima ${colima.vmType} VM` },
      work,
      log,
    )
  }
  if (level === 'host') {
    const s = p.hostUser(host.host!.user)
    if (!s.ok) throw new Error(`host tier: ${s.reason}; ${s.fix}`)
    return startHostUser(s.marker, work, log)
  }
  return null // none: the runner keeps its existing local execution
}

export function statusLines(
  host: HostConfig,
  requested: Request = {},
  p: Probes = systemProbes(),
) {
  const found = detect(host, p),
    available = found.levels
  const lines = [
    ...(host.vm
      ? [
          vmBackend(p.platform) === 'vz'
            ? vzNetworkStatusLine(host.vm.egress, vzNetworkState())
            : networkStatusLine(host.vm.egress, networkState()),
        ]
      : []),
    ...found.notes,
    `isolation backends available: ${available.filter((l) => l !== 'none').join(', ') || 'none'}`,
    `isolation floor: ${host.floor ?? 'none set'}`,
    `isolation host default: ${host.default ?? 'none set'}`,
  ]
  try {
    const r = resolveIsolation({
      ...requested,
      hostDefault: host.default,
      floor: host.floor,
      available,
    })
    lines.push(describe(r, backendName(r.level, p.platform)))
  } catch (e) {
    lines.push(`isolation: refused (${(e as Error).message})`)
  }
  return lines
}

/** `gild runner start` calls this once: a runner that cannot isolate does not start. */
export function assertCanIsolate(
  host: HostConfig,
  flag?: Level,
  p?: Probes,
  vmUnavailable?: string,
) {
  try {
    return resolveForHost(host, { flag }, p, vmUnavailable)
  } catch (e) {
    const message = (e as Error).message
    // Only the "nothing available" case needs the how-to-fix text; a floor or
    // availability refusal already says exactly what is wrong.
    throw new Error(
      message.includes('no isolation backend')
        ? `${message}. This runner would run workflow steps with no isolation. ` +
            `Fix it by describing a microVM, container or host-user backend in <config dir>/isolation.json ` +
            `(see FINDINGS.md), or start with --isolation none to run unisolated on purpose.`
        : message,
    )
  }
}
