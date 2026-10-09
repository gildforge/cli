// Network for `vm` isolation. Set up once by the owner with
// `sudo scripts/vm-network-setup.sh`: a bridge `gildbr0`, a pool of tap devices
// `gildtap0..N` owned by the runner user, and nftables rules that allow the
// internet but deny the host, the LAN, 100.64/10 and the metadata address.
// Without that setup a VM has no network device at all.
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

export const BRIDGE = 'gildbr0'
export const SETUP_COMMAND = 'sudo scripts/vm-network-setup.sh'
const PREFIX = '172.31.255'

export interface NetworkState {
  ready: boolean
  /** Tap slots this user can use. */
  slots: number[]
  reason?: string
}

export function networkState(
  uid = process.getuid?.() ?? -1,
  sys = '/sys/class/net',
): NetworkState {
  if (!existsSync(join(sys, BRIDGE)))
    return { ready: false, slots: [], reason: `no ${BRIDGE} bridge` }
  const slots = readdirSync(sys)
    .map((n) => /^gildtap(\d+)$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .filter((n) => {
      try {
        return (
          Number(readFileSync(join(sys, `gildtap${n}`, 'owner'), 'utf8')) ===
          uid
        )
      } catch {
        return false
      }
    })
    .sort((a, b) => a - b)
  return slots.length
    ? { ready: true, slots }
    : {
        ready: false,
        slots: [],
        reason: `no gildtap devices owned by uid ${uid}`,
      }
}

export function guestNetwork(slot: number) {
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return {
    tap: `gildtap${slot}`,
    mac: `06:00:ac:1f:ff:${hex(10 + slot)}`,
    ip: `${PREFIX}.${10 + slot}`,
    cidr: 24,
    gateway: `${PREFIX}.1`,
    dns: '1.1.1.1',
  }
}

/** Kernel args read by /init-gild.sh in the guest. */
export function bootNetArgs(n: ReturnType<typeof guestNetwork>) {
  return `gild.ip=${n.ip}/${n.cidr} gild.gw=${n.gateway} gild.dns=${n.dns}`
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Claim a free tap slot with a pid lock file; stale locks of dead pids are taken over. */
export function claimTap(
  slots: number[],
  lockDir: string,
): { slot: number; release: () => void } {
  mkdirSync(lockDir, { recursive: true, mode: 0o700 })
  for (const slot of slots) {
    const file = join(lockDir, `gildtap${slot}.lock`)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(file, 'wx', 0o600)
        writeSync(fd, String(process.pid))
        closeSync(fd)
        return {
          slot,
          release: () => {
            try {
              unlinkSync(file)
            } catch {}
          },
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const holder = Number(readFileSyncSafe(file))
        if (holder && alive(holder)) break
        try {
          unlinkSync(file)
        } catch {}
      }
    }
  }
  throw new Error('all VM network slots are in use')
}

function readFileSyncSafe(file: string) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function networkStatusLine(
  mode: 'auto' | 'block' | 'allow',
  s: NetworkState,
) {
  if (mode === 'block') return 'vm network: none (egress blocked by config)'
  return s.ready
    ? `vm network: egress allowed, LAN/host/metadata denied (${s.slots.length} slots on ${BRIDGE})`
    : `vm network: none, egress blocked (${s.reason}; enable with: ${SETUP_COMMAND})`
}

export interface NetworkPlan {
  net?: ReturnType<typeof guestNetwork>
  release: () => void
  /** Printed in the job log. */
  note: string
}

/** Decide whether a VM gets a network device. `allow` without setup is an error, `auto` degrades loudly. */
export function planNetwork(
  mode: 'auto' | 'block' | 'allow',
  state: NetworkState,
  lockDir: string,
): NetworkPlan {
  if (mode === 'block')
    return { release() {}, note: networkStatusLine(mode, state) }
  if (!state.ready) {
    if (mode === 'allow')
      throw new Error(
        `egress is set to allow but the VM network is not set up (${state.reason}). Needs Sami: ${SETUP_COMMAND}`,
      )
    return { release() {}, note: networkStatusLine(mode, state) }
  }
  const claim = claimTap(state.slots, lockDir)
  return {
    net: guestNetwork(claim.slot),
    release: claim.release,
    note: networkStatusLine(mode, state),
  }
}
