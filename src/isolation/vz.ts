// macOS backend: one Virtualization.framework microVM per job or agent,
// launched by the `gild-vz` helper (vz/gild-vz.swift, ad-hoc signed with the
// virtualization entitlement by scripts/build-vz-helper.sh).
//
// Same guest contract as Firecracker: the helper speaks Firecracker's vsock
// unix-socket protocol, so exec, put, pty, file listing and the hook relay are
// the shared vsockMembers. What differs:
// - the root disk is an APFS clone of the base image (copy-on-write, per VM);
// - the work directory is an APFS clone too, shared into the guest with
//   virtio-fs at /workspace, so the host checkout is never written and no
//   mke2fs is needed on the Mac;
// - networking is VZ NAT or nothing (see planVzNetwork).
import { execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  readFileSync,
  statSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vsockChannel, vsockMembers, type BootTimings } from './firecracker'
import { guestPing, type Isolation, type Opener } from './session'

export interface VzConfig {
  /** The signed gild-vz helper. */
  helper: string
  /** Uncompressed guest kernel (arm64 `Image`) with virtio-pci built in. */
  kernel: string
  /** Base ext4 image; each VM boots an APFS clone of it. */
  rootfs: string
  memoryMiB: number
  vcpus: number
  /** Guest vsock port the agent listens on. */
  port: number
  egress: 'auto' | 'block' | 'allow'
}

/** Guest -> host vsock ports the helper relays (the spawn --vm hook relay). */
export const GUEST_TO_HOST_PORTS = [9100]

export const VZ_NETWORK_MARKER = '/etc/gild/vz-network.json'
export const VZ_SETUP_COMMAND = 'sudo scripts/vz-network-setup.sh'

export function vzAvailable(
  c: Pick<VzConfig, 'helper' | 'kernel' | 'rootfs'>,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== 'darwin') return false
  try {
    accessSync(c.kernel, constants.R_OK)
    accessSync(c.rootfs, constants.R_OK)
    execFileSync(c.helper, ['check'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface VzNetworkState {
  /** The owner installed the pf anchor that denies VZ NAT guests the LAN. */
  filtered: boolean
  reason?: string
}

/** Reads the root-owned marker scripts/vz-network-setup.sh writes; never runs sudo or pfctl. */
export function vzNetworkState(marker = VZ_NETWORK_MARKER): VzNetworkState {
  try {
    const st = statSync(marker)
    if (st.uid !== 0 || st.mode & 0o022)
      return {
        filtered: false,
        reason: `${marker} is not root-owned and read-only`,
      }
    const m = JSON.parse(readFileSync(marker, 'utf8'))
    return m?.network === 'lan-denied'
      ? { filtered: true }
      : { filtered: false, reason: `${marker} does not say lan-denied` }
  } catch {
    return { filtered: false, reason: 'the vz pf anchor is not installed' }
  }
}

export interface VzNetworkPlan {
  net: 'none' | 'nat'
  note: string
}

/**
 * VZ NAT (vmnet shared mode) gives the guest the internet AND the Mac's LAN,
 * the Mac itself and the tailnet. Only a root pf anchor can deny those, so NAT
 * is used only when that anchor is installed; otherwise the VM has no network.
 */
export function planVzNetwork(
  egress: VzConfig['egress'],
  state: VzNetworkState,
): VzNetworkPlan {
  if (egress === 'block')
    return { net: 'none', note: 'vm network: none (egress: block)' }
  if (state.filtered)
    return {
      net: 'nat',
      note: 'vm network: VZ NAT, egress allowed, LAN/host/metadata denied by the gild-vz pf anchor',
    }
  if (egress === 'allow')
    throw new Error(
      `egress: allow needs the vz network filter (${state.reason}). Needs Sami: ${VZ_SETUP_COMMAND}`,
    )
  return {
    net: 'none',
    note: `vm network: none (${state.reason}; VZ NAT would reach the LAN; for filtered egress: ${VZ_SETUP_COMMAND})`,
  }
}

export function vzNetworkStatusLine(
  egress: VzConfig['egress'],
  state: VzNetworkState,
) {
  try {
    return planVzNetwork(egress, state).note
  } catch (e) {
    return `vm network: refused (${(e as Error).message})`
  }
}

export function kernelCommandLine(net: VzNetworkPlan['net'], now: Date) {
  return (
    'console=hvc0 root=/dev/vda rw rootfstype=ext4 init=/init-gild.sh quiet loglevel=1' +
    ` gild.time=${Math.floor(now.getTime() / 1000)}` +
    (net === 'nat' ? ' gild.net=dhcp' : '')
  )
}

/** APFS clonefile (copy-on-write); a plain copy when the clone is refused (another volume). */
function cloneTree(helper: string, src: string, dst: string) {
  try {
    execFileSync(helper, ['clone', src, dst], { stdio: 'pipe' })
  } catch {
    execFileSync('cp', ['-Rp', src, dst], { stdio: 'ignore' })
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function startVz(
  cfg: VzConfig,
  work: string,
  vmDir: string,
  log: (line: string) => void = () => {},
  network: VzNetworkState = vzNetworkState(),
): Promise<Isolation & { timings: BootTimings; pid: number }> {
  const plan = planVzNetwork(cfg.egress, network)
  log(plan.note)
  await mkdir(vmDir, { recursive: true, mode: 0o700 })
  // Unix socket paths are limited to 104 bytes on macOS, so they live in a short dir.
  const sockDir = await mkdtemp(join(tmpdir(), 'gv-'))
  const uds = join(sockDir, 'v'),
    root = join(vmDir, 'rootfs.img'),
    share = join(vmDir, 'work')
  const t0 = Date.now()
  let helper: ReturnType<typeof spawn> | undefined
  const listeners: Server[] = []
  const stop = async () => {
    for (const l of listeners) l.close()
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const exited = new Promise((r) => helper!.once('exit', r))
      helper.stdin?.end() // the helper stops the VM when its stdin closes
      helper.kill('SIGTERM')
      if (!(await Promise.race([exited.then(() => true), wait(4000)])))
        helper.kill('SIGKILL')
    }
    await rm(sockDir, { recursive: true, force: true })
    await rm(vmDir, { recursive: true, force: true })
  }
  try {
    cloneTree(cfg.helper, cfg.rootfs, root)
    chmodSync(root, 0o600) // the base is usually read-only; its clone is this VM's disk
    cloneTree(cfg.helper, work, share)
    const timings: BootTimings = { imageMs: Date.now() - t0, bootToAgentMs: 0 }
    const args = [
      'run',
      '--kernel',
      cfg.kernel,
      '--rootfs',
      root,
      '--cmdline',
      kernelCommandLine(plan.net, new Date()),
      '--cpus',
      String(cfg.vcpus),
      '--memory',
      String(cfg.memoryMiB),
      '--vsock',
      uds,
      '--serial',
      join(vmDir, 'serial.log'),
      '--share',
      `workspace=${share}`,
      '--net',
      plan.net,
      ...GUEST_TO_HOST_PORTS.flatMap((p) => ['--listen', String(p)]),
    ]
    const t1 = Date.now()
    const h = spawn(cfg.helper, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    helper = h
    let stderr = ''
    h.stderr!.on('data', (c) => (stderr += c))
    h.stdout!.on('data', () => {})
    const open: Opener = () => vsockChannel(uds, cfg.port)
    for (;;) {
      try {
        await guestPing(open)
        break
      } catch (e) {
        if (h.exitCode !== null || h.signalCode !== null) {
          const serial = await readFile(
            join(vmDir, 'serial.log'),
            'utf8',
          ).catch(() => '')
          throw new Error(
            `gild-vz exited: ${stderr.trim()} ${serial.slice(-400)}`.trim(),
          )
        }
        if (Date.now() - t1 > 20_000)
          throw new Error(
            'microVM agent did not come up: ' + (e as Error).message,
          )
        await wait(5)
      }
    }
    timings.bootToAgentMs = Date.now() - t1
    log(
      `microVM ready in ${timings.bootToAgentMs} ms (clone ${timings.imageMs} ms)`,
    )
    return {
      level: 'vm',
      backend: 'vz',
      label: 'vm (vz)',
      timings,
      pid: h.pid!,
      ...vsockMembers(open, uds, work, listeners),
      close: stop,
    }
  } catch (e) {
    await stop()
    throw e
  }
}
