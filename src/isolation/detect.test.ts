// Which levels a machine offers, from its config plus what is really there
// (Firecracker, an OCI engine, Colima on macOS, the host-tier user), and the
// order a run gets them in: vm, container, host, refuse.
import { describe, expect, test } from 'bun:test'
import {
  assertCanIsolate,
  detect,
  startIsolation,
  statusLines,
  type HostConfig,
  type Probes,
} from './index'
import type { ColimaState } from './colima'
import type { Marker } from './host-user'

const marker: Marker = {
  version: 1,
  user: 'gild-runner',
  uid: 1501,
  gid: 1501,
  owner: 'sami',
  agent: '/usr/local/libexec/gild/gild-guest-agent',
  workRoot: '/var/lib/gild-host/gild-runner/work',
  network: 'lan-denied',
}
const colimaUp: ColimaState = {
  running: true,
  socket: 'unix:///Users/sami/.colima/default/docker.sock',
  vmType: 'vz',
  arch: 'x86_64',
  mountType: 'virtiofs',
  mounts: [{ location: '/Users/sami', writable: true }],
}

function machine(have: {
  vm?: boolean
  oci?: boolean
  hostUser?: boolean
  platform?: NodeJS.Platform
  colima?: ColimaState
}): Probes {
  return {
    platform: have.platform ?? 'linux',
    firecracker: () => !!have.vm,
    oci: () => !!have.oci,
    colima: () =>
      have.colima ?? {
        running: false,
        reason: 'Colima is not running',
        fix: 'colima start',
      },
    hostUser: () =>
      have.hostUser
        ? { ok: true, marker }
        : {
            ok: false,
            reason: 'gild-runner is not set up',
            fix: 'Needs Sami: sudo scripts/host-user-setup.sh gild-runner sami --agent <…>',
          },
  }
}

const everything: HostConfig = {
  vm: {
    firecracker: 'firecracker',
    kernel: '/k',
    rootfs: '/r',
    memoryMiB: 512,
    vcpus: 1,
    egress: 'block',
  },
  container: {
    engine: 'docker',
    image: 'debian:12',
    agent: '/Users/sami/.config/gild/gild-guest-agent',
    memory: '1g',
    cpus: '1',
    pids: 128,
    egress: 'block',
  },
  host: { user: 'gild-runner' },
}

describe('resolution order: vm, container, host, refuse', () => {
  const cases: [Parameters<typeof machine>[0], string][] = [
    [{ vm: true, oci: true, hostUser: true }, 'vm'],
    [{ oci: true, hostUser: true }, 'container'],
    [{ hostUser: true }, 'host'],
  ]
  for (const [have, level] of cases)
    test(`${JSON.stringify(have)} -> ${level}`, () => {
      expect(assertCanIsolate(everything, undefined, machine(have))).toEqual({
        level: level as never,
        source: 'auto',
      })
    })

  test('nothing usable refuses, and never picks none on its own', () => {
    expect(() => assertCanIsolate(everything, undefined, machine({}))).toThrow(
      /no isolation backend.*--isolation none/s,
    )
    expect(assertCanIsolate(everything, 'none', machine({}))).toEqual({
      level: 'none',
      source: 'flag',
    })
  })

  test('host tier set up but not in isolation.json is not offered', () => {
    const { host: _host, ...withoutHost } = everything
    expect(detect(withoutHost, machine({ hostUser: true })).levels).toEqual([
      'none',
    ])
  })

  test('a floor of container refuses a host-tier-only machine instead of downgrading', () => {
    expect(() =>
      assertCanIsolate(
        { ...everything, floor: 'container' },
        undefined,
        machine({ hostUser: true }),
      ),
    ).toThrow(/requires isolation "container"/)
    expect(() =>
      assertCanIsolate(
        { ...everything, floor: 'container' },
        'host',
        machine({ hostUser: true }),
      ),
    ).toThrow(/below this host's floor/)
  })

  test('asking for host on a machine without the user set up is refused, not downgraded', () => {
    expect(() =>
      assertCanIsolate(everything, 'host', machine({ oci: true })),
    ).toThrow(/"host" \(from flag\) is not available/)
  })
})

describe('gild status reports each backend honestly', () => {
  test('host tier configured', () => {
    const text = statusLines(everything, {}, machine({ hostUser: true })).join(
      '\n',
    )
    expect(text).toContain(
      'host tier: configured, steps run as gild-runner (uid 1501), LAN denied',
    )
    expect(text).toContain(
      'isolation: host (dedicated OS user), requested by auto',
    )
  })

  test('host tier not configured says what Sami has to run', () => {
    const text = statusLines(everything, {}, machine({ vm: true })).join('\n')
    expect(text).toContain('host tier: not configured')
    expect(text).toContain('Needs Sami: sudo scripts/host-user-setup.sh')
    expect(text).toContain('isolation: vm (firecracker)')
  })

  test('macOS: Colima running makes container available, labelled as Colima', () => {
    const p = machine({ platform: 'darwin', oci: true, colima: colimaUp })
    expect(detect(everything, p).levels).toEqual(['container', 'none'])
    const text = statusLines(everything, {}, p).join('\n')
    expect(text).toContain('colima: running (vz, x86_64, virtiofs mounts')
    expect(text).toContain('isolation: container (oci in Colima VM)')
  })

  test('macOS: Colima down means no container level, and status says how to start it', () => {
    const p = machine({ platform: 'darwin', oci: true })
    expect(detect(everything, p).levels).toEqual(['none'])
    expect(statusLines(everything, {}, p).join('\n')).toContain(
      'colima: unavailable (Colima is not running); colima start',
    )
  })

  test('macOS: an agent outside Colima mounts cannot be mounted into a container', () => {
    const p = machine({ platform: 'darwin', oci: true, colima: colimaUp })
    const outside = {
      ...everything,
      container: { ...everything.container!, agent: '/Volumes/x/agent' },
    }
    const d = detect(outside, p)
    expect(d.levels).toEqual(['none'])
    expect(d.notes.join('\n')).toContain("outside Colima's mounts")
  })

  test('macOS: a job directory outside the Colima mounts is refused before any container starts', async () => {
    const p = machine({ platform: 'darwin', oci: true, colima: colimaUp })
    await expect(
      startIsolation(
        'container',
        everything,
        '/Volumes/Projects/w',
        '/x',
        undefined,
        p,
      ),
    ).rejects.toThrow(/not inside a writable Colima mount.*Needs Sami/s)
  })
})
