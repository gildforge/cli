// `gild spawn --vm`: the agent process runs on a pty inside a microVM
// (Firecracker on Linux, Virtualization.framework on macOS); the host keeps the terminal, session socket, hooks, injection queue
// and everything else (spawn-worker.ts). This file only builds the guest
// child and the hook relay.
import { createConnection } from 'node:net'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  loadHostConfig,
  startVm,
  vmAvailable,
  vmBackend,
  type Isolation,
} from './isolation'
import { privateSessionsDirectory, socketPath } from './spawn-sessions'
import {
  describeSync,
  hostManifest,
  syncBack,
  type SyncResult,
} from './isolation/sync'

export const GUEST_AGENT = '/usr/local/bin/gild-guest-agent'
const GUEST_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const MAX_UPLOAD = 1 << 20

export interface VmChild {
  pid: number
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  onData(cb: (data: Buffer) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  pause(): void
  resume(): void
  /** Hang up the guest session (the agent gets SIGHUP). */
  kill(): void
  /** Copy the guest's changes to the working directory back to the host now. */
  sync(): Promise<SyncResult>
  /** Sync one last time, then stop the VM. Safe to call more than once. */
  dispose(): Promise<SyncResult | undefined>
}

/** Env for the guest: a fixed baseline plus only what the adapter or profile added; never the host env. */
export function guestEnvironment(
  hostEnv: Record<string, string | undefined>,
  baseline: Record<string, string | undefined>,
  allowlist?: string[],
) {
  const out: Record<string, string> = {
    PATH: GUEST_PATH,
    HOME: '/root',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
  }
  for (const [k, v] of Object.entries(hostEnv)) {
    if (v === undefined || k in out) continue
    const addedByAdapter = baseline[k] !== v
    if (addedByAdapter || allowlist?.includes(k)) out[k] = v
  }
  return out
}

export async function startVmChild(opts: {
  configDir: string
  sessionId: string
  cwd: string
  binary: string
  args: string[]
  env: Record<string, string>
  cols: number
  rows: number
  log?: (line: string) => void
}): Promise<VmChild> {
  const host = await loadHostConfig(opts.configDir)
  if (!host.vm || !vmAvailable(host.vm))
    throw new Error(
      vmBackend() === 'vz'
        ? '--vm needs a working vz setup: describe `vm` (kernel, rootfs, vz helper) in <config dir>/isolation.json (see FINDINGS.md)'
        : '--vm needs a working Firecracker setup: describe `vm` in <config dir>/isolation.json (see FINDINGS.md) and make /dev/kvm accessible',
    )
  const kb = Number(
    execFileSync('du', ['-sk', opts.cwd], { encoding: 'utf8' }).split(/\s+/)[0],
  )
  if (kb > 2 * 1024 * 1024)
    throw new Error(
      `${opts.cwd} is larger than 2 GiB; --vm copies the working directory into the VM`,
    )
  // What the guest starts from: the baseline every later sync is compared to.
  const baseline = await hostManifest(opts.cwd)
  const vmDir = await mkdtemp(join(tmpdir(), 'gild-spawn-vm-'))
  const iso: Isolation = await startVm(host.vm, opts.cwd, vmDir, opts.log)
  const fail = async (e: unknown) => {
    await iso.close()
    throw e
  }
  try {
    // Hooks run inside the guest and arrive here over vsock; only this session's id is accepted.
    iso.onGuestMessage!(9100, (m) => {
      if (
        m?.op !== 'hook' ||
        m.session !== opts.sessionId ||
        typeof m.raw !== 'string'
      )
        return
      let raw: unknown
      try {
        raw = JSON.parse(m.raw)
      } catch {
        return
      }
      const s = createConnection(socketPath(opts.sessionId))
      s.on('error', () => {})
      s.on('connect', () =>
        s.end(
          JSON.stringify({
            type: 'hook',
            agent: String(m.agent ?? 'claude'),
            raw,
          }) + '\n',
        ),
      )
    })
    // Small files the host prepared (hook settings, a script agent) are copied into the guest tmpfs.
    let n = 0
    const upload = async (path: string, executable: boolean) => {
      if (!isAbsolute(path)) return undefined
      const st = await stat(path).catch(() => null)
      if (!st?.isFile() || st.size > MAX_UPLOAD) return undefined
      const target = `/tmp/gild/${n++}-${basename(path)}`
      await iso.put(
        target,
        await readFile(path, 'utf8'),
        executable ? 0o700 : 0o600,
      )
      return target
    }
    const head = await readFile(opts.binary, {
      encoding: 'latin1',
      flag: 'r',
    }).then(
      (t) => t.slice(0, 2),
      () => '',
    )
    const program =
      (head === '#!' && (await upload(opts.binary, true))) ||
      basename(opts.binary)
    const args: string[] = []
    for (const a of opts.args) args.push((await upload(a, false)) ?? a)
    const pty = await iso.pty!({
      argv: [program, ...args],
      env: opts.env,
      cwd: '/workspace',
      cols: opts.cols,
      rows: opts.rows,
    })
    let exitCb: (e: { exitCode: number }) => void = () => {}
    pty.onExit((code) => exitCb({ exitCode: code }))
    const conflictDir = join(
      await privateSessionsDirectory(),
      `${opts.sessionId}.conflicts`,
    )
    // One sync at a time; each one carries only what changed since the last.
    let chain: Promise<unknown> = Promise.resolve()
    const sync = () => {
      const next = chain.then(async () => {
        const r = await syncBack({
          root: opts.cwd,
          guestRoot: '/workspace',
          files: iso.files!,
          baseline,
          conflictDir,
        })
        opts.log?.(`synced ${describeSync(r)}`)
        return r
      })
      chain = next.catch(() => {})
      return next
    }
    let disposed: Promise<SyncResult | undefined> | undefined
    return {
      pid: -1,
      write: (d) => pty.write(d),
      resize: (c, r) => pty.resize(c, r),
      onData: (cb) => pty.onData(cb),
      onExit: (cb) => (exitCb = cb),
      pause() {},
      resume() {},
      kill: () => pty.close(),
      sync,
      dispose: () =>
        (disposed ??= sync()
          .then(
            (r) => r,
            (e) => {
              opts.log?.(`final sync failed: ${(e as Error).message}`)
              return undefined
            },
          )
          .finally(() => iso.close())),
    }
  } catch (e) {
    return fail(e)
  }
}
