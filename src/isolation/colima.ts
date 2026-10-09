// macOS `container` level: OCI containers inside Colima's Linux VM (Lima,
// vmType vz, virtiofs mounts, Docker runtime). The Mac is separated from jobs
// by Colima's VM, and jobs from each other by the same hardened container
// flags and egress policy as on Linux (that policy runs inside Colima's VM).
// gild only detects Colima; installing or starting it is the owner's call.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const COLIMA_INSTALL =
  'brew install colima docker && colima start --vm-type vz --mount-type virtiofs'

export interface ColimaMount {
  location: string
  writable: boolean
}

export type ColimaState =
  | {
      running: true
      /** `unix://…/docker.sock`, passed to docker as `--host`. */
      socket: string
      vmType: string
      arch: string
      mountType: string
      mounts: ColimaMount[]
    }
  | { running: false; reason: string; fix: string }

export interface ColimaProbe {
  /** stdout of `colima status --json`, or undefined if it failed or is not installed. */
  status(): string | undefined
  installed(): boolean
  /** ~/.colima/default/colima.yaml, if present. */
  config(): string | undefined
  home: string
  exists(path: string): boolean
}

export const systemColimaProbe = (profile = 'default'): ColimaProbe => ({
  installed: () => {
    try {
      execFileSync('colima', ['version'], { stdio: 'ignore', timeout: 5000 })
      return true
    } catch {
      return false
    }
  },
  status: () => {
    try {
      return execFileSync('colima', ['status', '--json', '-p', profile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      })
    } catch {
      return undefined
    }
  },
  config: () => {
    try {
      return readFileSync(
        join(homedir(), '.colima', profile, 'colima.yaml'),
        'utf8',
      )
    } catch {
      return undefined
    }
  },
  home: homedir(),
  exists: existsSync,
})

/** The `mounts:` list of colima.yaml; an empty list means Colima's default ($HOME, writable). */
export function colimaMounts(yaml: string | undefined, home: string) {
  let raw: unknown
  try {
    raw = yaml ? (globalThis as any).Bun?.YAML?.parse(yaml)?.mounts : undefined
  } catch {
    raw = undefined
  }
  const list = Array.isArray(raw) ? raw : []
  if (!list.length) return [{ location: home, writable: true }]
  return list
    .filter((m) => m && typeof m.location === 'string')
    .map((m) => ({
      location: resolve(m.location.replace(/^~(?=$|\/)/, home)),
      writable: m.writable === true,
    }))
}

export function detectColima(p: ColimaProbe): ColimaState {
  if (!p.installed())
    return {
      running: false,
      reason: 'Colima is not installed',
      fix: `Needs Sami: ${COLIMA_INSTALL}`,
    }
  const out = p.status()
  let s: Record<string, unknown> | undefined
  try {
    s = out ? JSON.parse(out) : undefined
  } catch {
    s = undefined
  }
  if (!s)
    return {
      running: false,
      reason: 'Colima is not running',
      fix: 'colima start --vm-type vz --mount-type virtiofs',
    }
  const socket = String(s.docker_socket ?? '')
  if (s.runtime !== 'docker' || !socket.startsWith('unix://'))
    return {
      running: false,
      reason: `Colima runs the ${String(s.runtime)} runtime; gild needs docker`,
      fix: 'colima start --runtime docker (a new profile; the runtime of an existing VM cannot change)',
    }
  if (!p.exists(socket.slice('unix://'.length)))
    return {
      running: false,
      reason: `Colima's docker socket ${socket} is missing`,
      fix: 'colima restart',
    }
  const driver = String(s.driver ?? '')
  return {
    running: true,
    socket,
    vmType: /virtualization/i.test(driver)
      ? 'vz'
      : /qemu/i.test(driver)
        ? 'qemu'
        : driver || 'unknown',
    arch: String(s.arch ?? 'unknown'),
    mountType: String(s.mount_type ?? 'unknown'),
    mounts: colimaMounts(p.config(), p.home),
  }
}

/** The mount that makes `path` visible in Colima's VM, if any (and writable when asked). */
export function colimaMountFor(
  path: string,
  mounts: ColimaMount[],
  writable: boolean,
) {
  const abs = resolve(path)
  return mounts.find(
    (m) =>
      (abs === m.location || abs.startsWith(m.location + '/')) &&
      (!writable || m.writable),
  )
}

export function colimaStatusLine(c: ColimaState) {
  return c.running
    ? `colima: running (${c.vmType}, ${c.arch}, ${c.mountType} mounts: ${c.mounts.map((m) => `${m.location}${m.writable ? '' : ' ro'}`).join(', ')})`
    : `colima: unavailable (${c.reason}); ${c.fix}`
}
