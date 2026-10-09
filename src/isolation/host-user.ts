// `host` level: steps run on this machine as a dedicated, unprivileged OS user
// (the old gild's `sandbox = "host"`, Layer 1). The owner creates the user once
// with scripts/host-user-setup.sh (needs root); gild never runs sudo for setup,
// it only uses the one sudo rule that script installs: run the guest agent as
// that user. Same exec contract as a VM or container (`--stdio`), so runner
// code does not change. What it isolates: the owner's files (home, other
// checkouts) and, through the per-user firewall rule, the LAN. What it does
// not: the kernel, other world-readable files, CPU and memory.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmod,
  cp,
  lchown,
  lstat,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import {
  guestExec,
  guestPing,
  guestPty,
  type Channel,
  type Isolation,
  type Opener,
} from './session'

export const MARKER_DIR = '/etc/gild/host-users'

/** What scripts/host-user-setup.sh wrote to /etc/gild/host-users/<user>.json. */
export interface Marker {
  version: 1
  user: string
  uid: number
  gid: number
  owner: string
  agent: string
  workRoot: string
  network?: string
}

/** Everything detection looks at, so tests can describe any machine. */
export interface HostProbe {
  marker(user: string): string | undefined
  uidOf(user: string): number | undefined
  me: { uid: number; name: string; groups: number[] }
  stat(
    path: string,
  ): { uid: number; gid: number; mode: number; dir: boolean } | undefined
}

export const systemProbe = (markerDir = MARKER_DIR): HostProbe => ({
  marker: (user) => {
    try {
      return readFileSync(join(markerDir, `${user}.json`), 'utf8')
    } catch {
      return undefined
    }
  },
  uidOf: (user) => {
    try {
      return Number(
        execFileSync('id', ['-u', user], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      )
    } catch {
      return undefined
    }
  },
  me: {
    uid: process.getuid?.() ?? -1,
    name: userInfo().username,
    groups: process.getgroups?.() ?? [],
  },
  stat: (path) => {
    try {
      const s = statSync(path)
      return { uid: s.uid, gid: s.gid, mode: s.mode, dir: s.isDirectory() }
    } catch {
      return undefined
    }
  },
})

export type HostUserState =
  { ok: true; marker: Marker } | { ok: false; reason: string; fix: string }

export const setupCommand = (user: string, owner: string) =>
  `sudo scripts/host-user-setup.sh ${user} ${owner} --agent <gild-guest-agent for this OS>`

/** Is the host tier for `user` set up, and set up safely? Never runs sudo. */
export function hostUserState(user: string, probe: HostProbe): HostUserState {
  const fix = `Needs Sami: ${setupCommand(user, probe.me.name)}`
  const no = (reason: string): HostUserState => ({ ok: false, reason, fix })
  const raw = probe.marker(user)
  if (!raw) return no(`${user} is not set up (no ${MARKER_DIR}/${user}.json)`)
  let m: Marker
  try {
    m = JSON.parse(raw)
  } catch {
    return no(`${MARKER_DIR}/${user}.json is not valid JSON`)
  }
  if (m.version !== 1 || m.user !== user)
    return no(`${MARKER_DIR}/${user}.json does not describe ${user}`)
  const uid = probe.uidOf(user)
  if (uid === undefined) return no(`OS user ${user} does not exist`)
  if (uid !== m.uid)
    return no(`${user} has uid ${uid}, setup recorded ${m.uid}`)
  if (uid === 0) return no(`${user} is root`)
  if (uid === probe.me.uid)
    return no(`${user} is the runner's own user; that is not isolation`)
  if (m.owner !== probe.me.name)
    return no(`${user} was set up for ${m.owner}, not ${probe.me.name}`)
  if (!probe.me.groups.includes(m.gid))
    return {
      ok: false,
      reason: `${probe.me.name} is not in group ${user} yet`,
      fix: 'log out and in again (group membership is read at login)',
    }
  const agent = probe.stat(m.agent)
  if (!agent || agent.dir) return no(`agent ${m.agent} is missing`)
  if (agent.uid !== 0 || agent.mode & 0o022)
    return no(
      `agent ${m.agent} must be root-owned and not group/other-writable`,
    )
  const work = probe.stat(m.workRoot)
  if (!work?.dir) return no(`work root ${m.workRoot} is missing`)
  if (work.gid !== m.gid || (work.mode & 0o070) !== 0o070 || work.mode & 0o007)
    return no(`work root ${m.workRoot} must be group ${user}, mode 2770`)
  return { ok: true, marker: m }
}

/** Give the shared group read/write on everything (the dedicated user is in it, not the owner's other files). */
async function shareWithGroup(path: string, gid: number) {
  const st = await lstat(path)
  // Files the dedicated user made are already shared (setgid dirs, umask 007).
  if (st.isSymbolicLink() || st.uid !== process.getuid?.()) return
  if (st.gid !== gid) await lchown(path, -1, gid)
  if (st.isDirectory()) {
    await chmod(path, (st.mode & 0o7777) | 0o2070)
    for (const name of await readdir(path))
      await shareWithGroup(join(path, name), gid)
  } else await chmod(path, (st.mode & 0o777) | 0o060 | ((st.mode & 0o100) >> 3))
}

async function move(from: string, to: string) {
  try {
    await rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await cp(from, to, { recursive: true, verbatimSymlinks: true })
    await rm(from, { recursive: true, force: true })
  }
}

function stdioChannel(argv: string[]): Channel {
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let closeCb: (e?: Error) => void = () => {},
    stderr = ''
  child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
  child.on('close', (code) =>
    closeCb(
      code && stderr
        ? new Error(`${argv[0]} exited ${code}: ${stderr.trim()}`)
        : undefined,
    ),
  )
  child.on('error', (e) => closeCb(e))
  return {
    write: (d) => void child.stdin!.write(d),
    onData: (cb) => child.stdout!.on('data', cb),
    onClose: (cb) => (closeCb = cb),
    close: () => {
      child.stdin!.end()
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    },
  }
}

/**
 * Stage the job directory under the shared work root, then run the agent as
 * the dedicated user. `runAs` is the privilege switch: the sudo rule from the
 * setup script; tests pass [] to exercise the same path as themselves.
 */
export async function startHostUser(
  marker: Marker,
  work: string,
  log: (line: string) => void = () => {},
  runAs: string[] = ['sudo', '-n', '-u', marker.user, '--'],
): Promise<Isolation> {
  const staged = join(marker.workRoot, `job-${randomBytes(6).toString('hex')}`)
  await move(work, staged)
  // The runner keeps using its own path; the dedicated user sees the staged one.
  await symlink(staged, work)
  const restore = async () => {
    await unlink(work).catch(() => {})
    await move(staged, work)
  }
  try {
    await shareWithGroup(staged, marker.gid)
    const open: Opener = async () =>
      stdioChannel([...runAs, marker.agent, '--stdio', '--shared'])
    try {
      await guestPing(open)
    } catch (e) {
      throw new Error(
        `cannot run the agent as ${marker.user}: ${(e as Error).message}. Needs Sami: ${setupCommand(marker.user, marker.owner)}`,
      )
    }
    log(`steps run as OS user ${marker.user} in ${staged}`)
    const guest = (p: string) =>
      p === work
        ? staged
        : p.startsWith(work + '/')
          ? staged + p.slice(work.length)
          : p
    return {
      level: 'host',
      backend: 'os-user',
      label: `host (OS user ${marker.user})`,
      guestPath: guest,
      // The runner's own files (step scripts) are written by the runner and
      // shared with the group, not by the dedicated user into a runner-owned file.
      put: async (p, content, mode = 0o600) => {
        await writeFile(guest(p), content, { mode })
        await shareWithGroup(guest(p), marker.gid)
      },
      exec: (argv, o) => guestExec(open, argv, o),
      pty: (request) => guestPty(open, request),
      close: restore,
    }
  } catch (e) {
    await restore()
    throw e
  }
}
