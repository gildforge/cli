// `container` level, OCI implementation (Docker or Podman). Same guest agent,
// same exec contract, the job directory bind-mounted at /workspace. Other
// container technologies (FreeBSD jails) slot in as another backend name.
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import {
  guestExec,
  guestPut,
  type Channel,
  type Isolation,
  type Opener,
} from './session'

export interface OciConfig {
  /** `docker` or `podman` (anything with the same CLI). */
  engine: string
  image: string
  /** Static linux guest agent binary, mounted read-only into the container. */
  agent: string
  memory: string
  cpus: string
  pids: number
  egress: 'block' | 'allow'
}

export const GUEST_WORK = '/workspace'

export function ociAvailable(engine: string, agent: string) {
  try {
    execFileSync(engine, ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      timeout: 5000,
    })
    execFileSync('test', ['-x', agent])
    return true
  } catch {
    return false
  }
}

function execChannel(engine: string, name: string): Channel {
  const child = spawn(
    engine,
    ['exec', '-i', name, '/gild-guest-agent', '--stdio'],
    {
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  )
  let closeCb: (e?: Error) => void = () => {}
  child.on('close', () => closeCb())
  child.on('error', (e) => closeCb(e))
  return {
    write: (d) => void child.stdin!.write(d),
    onData: (cb) => child.stdout!.on('data', cb),
    onClose: (cb) => (closeCb = cb),
    // Closing stdin is EOF to the agent, which then kills the step's group.
    close: () => {
      child.stdin!.end()
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    },
  }
}

export function startOci(cfg: OciConfig, work: string): Isolation {
  const name = 'gild-' + randomBytes(6).toString('hex'),
    me = userInfo()
  execFileSync(
    cfg.engine,
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      // Hardening: no capabilities, no privilege gain, immutable root, bounded.
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,size=512m',
      '--pids-limit',
      String(cfg.pids),
      '--memory',
      cfg.memory,
      '--cpus',
      cfg.cpus,
      // No network at all unless egress is allowed; allowed egress still needs
      // host firewall rules to keep the LAN and metadata address unreachable.
      '--network',
      cfg.egress === 'block' ? 'none' : 'bridge',
      '--user',
      `${me.uid}:${me.gid}`,
      '-v',
      `${cfg.agent}:/gild-guest-agent:ro`,
      '-v',
      `${work}:${GUEST_WORK}`,
      '-w',
      GUEST_WORK,
      cfg.image,
      'sleep',
      'infinity',
    ],
    { stdio: 'ignore' },
  )
  const open: Opener = async () => execChannel(cfg.engine, name)
  const inWork = (p: string) => p === work || p.startsWith(work + '/')
  const guest = (p: string) =>
    inWork(p) ? GUEST_WORK + p.slice(work.length) : p
  return {
    level: 'container',
    backend: 'oci:' + cfg.engine,
    label: `container (${cfg.engine})`,
    guestPath: guest,
    put: (p, content, mode) => guestPut(open, guest(p), content, mode),
    exec: (argv, o) => guestExec(open, argv, o),
    close: async () => {
      try {
        execFileSync(cfg.engine, ['rm', '-f', name], { stdio: 'ignore' })
      } catch {}
    },
  }
}
