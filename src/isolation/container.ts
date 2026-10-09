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
  egress: 'auto' | 'block' | 'allow'
  /** Engine endpoint (`docker --host`), e.g. Colima's socket on macOS. */
  host?: string
  /** Where the engine runs, for labels: `Colima vz VM`. */
  where?: string
}

/** Global engine flags that pick the endpoint; empty for the local default. */
const endpoint = (host?: string) => (host ? ['--host', host] : [])

export const EGRESS_NETWORK = 'gild-egress'

function egressNetworkReady(engine: string, host?: string) {
  try {
    execFileSync(
      engine,
      [...endpoint(host), 'network', 'inspect', EGRESS_NETWORK],
      {
        stdio: 'ignore',
      },
    )
    return true
  } catch {
    return false
  }
}

/** Network the container joins: the filtered bridge, or none. `allow` without setup is an error. */
export function containerNetwork(
  mode: OciConfig['egress'],
  ready: boolean,
  setup = NETWORK_SETUP,
) {
  if (mode === 'block' || (!ready && mode === 'auto')) return 'none'
  if (!ready)
    throw new Error(
      `egress is set to allow but the ${EGRESS_NETWORK} network is not set up. Needs Sami: ${setup}`,
    )
  return EGRESS_NETWORK
}

export const GUEST_WORK = '/workspace'
export const NETWORK_SETUP = 'sudo scripts/vm-network-setup.sh'
/** The same script, run inside Colima's VM, where the containers' network lives. */
export const COLIMA_NETWORK_SETUP =
  'colima ssh -- sudo sh -s up < scripts/vm-network-setup.sh'

export function ociAvailable(engine: string, agent: string, host?: string) {
  try {
    execFileSync(
      engine,
      [...endpoint(host), 'version', '--format', '{{.Server.Version}}'],
      {
        stdio: 'ignore',
        timeout: 5000,
      },
    )
    execFileSync('test', ['-x', agent])
    return true
  } catch {
    return false
  }
}

function execChannel(engine: string, name: string, host?: string): Channel {
  const child = spawn(
    engine,
    [...endpoint(host), 'exec', '-i', name, '/gild-guest-agent', '--stdio'],
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

export function startOci(
  cfg: OciConfig,
  work: string,
  log: (line: string) => void = () => {},
): Isolation {
  const name = 'gild-' + randomBytes(6).toString('hex'),
    me = userInfo()
  const setup = cfg.where ? COLIMA_NETWORK_SETUP : NETWORK_SETUP
  const network = containerNetwork(
    cfg.egress,
    cfg.egress !== 'block' && egressNetworkReady(cfg.engine, cfg.host),
    setup,
  )
  log(
    network === 'none'
      ? `container network: none, egress blocked (enable with: ${setup})`
      : `container network: ${network}, egress allowed, LAN/host/metadata denied`,
  )
  execFileSync(
    cfg.engine,
    [
      ...endpoint(cfg.host),
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
      // No network unless the filtered gild-egress bridge exists (set up by
      // scripts/vm-network-setup.sh); never the default bridge.
      '--network',
      network,
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
  const open: Opener = async () => execChannel(cfg.engine, name, cfg.host)
  const inWork = (p: string) => p === work || p.startsWith(work + '/')
  const guest = (p: string) =>
    inWork(p) ? GUEST_WORK + p.slice(work.length) : p
  return {
    level: 'container',
    backend: 'oci:' + cfg.engine + (cfg.where ? '@colima' : ''),
    label: `container (${cfg.engine}${cfg.where ? ` in ${cfg.where}` : ''})`,
    guestPath: guest,
    put: (p, content, mode) => guestPut(open, guest(p), content, mode),
    exec: (argv, o) => guestExec(open, argv, o),
    close: async () => {
      try {
        execFileSync(cfg.engine, [...endpoint(cfg.host), 'rm', '-f', name], {
          stdio: 'ignore',
        })
      } catch {}
    },
  }
}
