import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  hostUserState,
  startHostUser,
  type HostProbe,
  type Marker,
} from './host-user'

const good: Marker = {
  version: 1,
  user: 'gild-runner',
  uid: 1501,
  gid: 1501,
  owner: 'sami',
  agent: '/usr/local/libexec/gild/gild-guest-agent',
  workRoot: '/var/lib/gild-host/gild-runner/work',
  network: 'lan-denied',
}

function probe(o: {
  marker?: string | undefined
  uid?: number
  me?: Partial<HostProbe['me']>
  agent?: { uid: number; mode: number } | null
  work?: { gid: number; mode: number } | null
}): HostProbe {
  return {
    marker: () => ('marker' in o ? o.marker : JSON.stringify(good)),
    uidOf: () => ('uid' in o ? o.uid : 1501),
    me: { uid: 501, name: 'sami', groups: [20, 1501], ...o.me },
    stat: (p) => {
      if (p === good.agent) {
        const a = o.agent === undefined ? { uid: 0, mode: 0o100755 } : o.agent
        return a ? { ...a, gid: 0, dir: false } : undefined
      }
      if (p === good.workRoot) {
        const w = o.work === undefined ? { gid: 1501, mode: 0o42770 } : o.work
        return w ? { ...w, uid: 501, dir: true } : undefined
      }
      return undefined
    },
  }
}

describe('host tier detection never runs sudo and refuses unsafe setups', () => {
  const cases: [string, Parameters<typeof probe>[0], RegExp][] = [
    ['no marker', { marker: undefined }, /not set up/],
    ['bad marker', { marker: '{' }, /not valid JSON/],
    ['no such user', { uid: undefined }, /does not exist/],
    ['uid changed since setup', { uid: 1600 }, /uid 1600, setup recorded 1501/],
    [
      'the runner itself',
      { uid: 501, marker: JSON.stringify({ ...good, uid: 501 }) },
      /runner's own user/,
    ],
    [
      'root',
      { uid: 0, marker: JSON.stringify({ ...good, uid: 0 }) },
      /is root/,
    ],
    ['another owner', { me: { name: 'eve' } }, /set up for sami, not eve/],
    ['not in the group yet', { me: { groups: [20] } }, /not in group/],
    ['agent missing', { agent: null }, /missing/],
    [
      'agent writable by the runner',
      { agent: { uid: 501, mode: 0o100755 } },
      /root-owned/,
    ],
    [
      'agent group-writable',
      { agent: { uid: 0, mode: 0o100775 } },
      /root-owned/,
    ],
    ['work root missing', { work: null }, /work root .* missing/],
    ['work root not shared', { work: { gid: 20, mode: 0o40770 } }, /mode 2770/],
    [
      'work root open to others',
      { work: { gid: 1501, mode: 0o42775 } },
      /mode 2770/,
    ],
  ]
  for (const [name, o, reason] of cases)
    test(name, () => {
      const s = hostUserState('gild-runner', probe(o))
      expect(s.ok).toBe(false)
      if (!s.ok) expect(s.reason).toMatch(reason)
    })

  test('not in the group: the fix is a re-login, not a re-run of setup', () => {
    const s = hostUserState('gild-runner', probe({ me: { groups: [20] } }))
    expect(!s.ok && s.fix).toMatch(/log out and in/)
  })

  test('the missing-setup fix is the exact setup command', () => {
    const s = hostUserState('gild-runner', probe({ marker: undefined }))
    expect(!s.ok && s.fix).toBe(
      'Needs Sami: sudo scripts/host-user-setup.sh gild-runner sami --agent <gild-guest-agent for this OS>',
    )
  })

  test('a correct setup is configured', () => {
    expect(hostUserState('gild-runner', probe({}))).toEqual({
      ok: true,
      marker: good,
    })
  })

  // The script writes the marker the detector reads: one format, checked end to end.
  for (const os of ['linux', 'macos'])
    test(`setup script (${os}, dry run) writes a marker the detector accepts, and the exact sudo rule`, () => {
      const r = spawnSync(
        'sh',
        [
          resolve('scripts/host-user-setup.sh'),
          'gild-runner',
          'sami',
          '--agent',
          '/x',
          '--dry-run',
          '--os',
          os,
        ],
        { encoding: 'utf8' },
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toContain(
        'sami ALL=(gild-runner) NOPASSWD: /usr/local/libexec/gild/gild-guest-agent --stdio --shared',
      )
      const line = r.stdout
        .split('\n')
        .find((l) => l.startsWith('{"version":1'))!
      const written = JSON.parse(
        line.replace('<uid>', '1501').replace('<gid>', '1501'),
      )
      expect(
        hostUserState(
          'gild-runner',
          probe({
            marker: JSON.stringify(written),
            work: written.workRoot === good.workRoot ? undefined : null,
          }),
        ).ok,
      ).toBe(os === 'linux') // the fake probe only knows the Linux paths
      expect(written.workRoot).toBe(
        os === 'linux'
          ? '/var/lib/gild-host/gild-runner/work'
          : '/Users/Shared/gild-host/gild-runner/work',
      )
      expect(r.stdout).toContain(
        os === 'linux'
          ? 'meta skuid "gild-runner" ip daddr { 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } reject'
          : 'block return out quick inet proto { tcp udp } from any to { 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 } user gild-runner',
      )
    })

  test('setup refuses names outside gild-*', () => {
    const r = spawnSync(
      'sh',
      [
        resolve('scripts/host-user-setup.sh'),
        'sami',
        'sami',
        '--agent',
        '/x',
        '--dry-run',
      ],
      { encoding: 'utf8' },
    )
    expect(r.status).toBe(2)
  })
})

// Real staging and exec through the agent, as the current user (runAs = []):
// proves everything except the privilege switch, which needs Sami's setup.
const agent = process.env.GILD_TEST_AGENT
test.skipIf(!agent)(
  'host tier: job dir staged under the shared root, steps run there, files group-shared, dir restored',
  async () => {
    const base = mkdtempSync(join(tmpdir(), 'hosttier-'))
    const workRoot = join(base, 'shared'),
      work = join(base, 'runner', 'work', 'job1')
    mkdirSync(workRoot, { mode: 0o2770 })
    mkdirSync(join(work, 'checkout'), { recursive: true })
    writeFileSync(join(work, 'checkout', 'hello.txt'), 'hi\n', { mode: 0o644 })
    const m: Marker = {
      ...good,
      gid: process.getgid!(),
      agent: agent!,
      workRoot,
    }
    const iso = await startHostUser(m, work, () => {}, [])
    expect(lstatSync(work).isSymbolicLink()).toBe(true)
    const staged = iso.guestPath(work)
    expect(staged.startsWith(workRoot + '/job-')).toBe(true)
    // Everything the runner made is now group read/write.
    expect(statSync(join(staged, 'checkout', 'hello.txt')).mode & 0o060).toBe(
      0o060,
    )
    await iso.put(
      join(work, 'step-0.script'),
      'echo from-script; touch made.txt; pwd\n',
    )
    expect(statSync(join(staged, 'step-0.script')).mode & 0o060).toBe(0o060)
    const lines: string[] = []
    const code = await iso.exec(
      ['sh', iso.guestPath(join(work, 'step-0.script'))],
      {
        cwd: iso.guestPath(join(work, 'checkout')),
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        onLine: async (l) => void lines.push(l),
      },
    )
    expect(code).toBe(0)
    expect(lines).toEqual(
      ['from-script', join(staged, 'checkout').replace(/^\/private/, '')].map(
        (l) => l,
      ),
    )
    // --shared: files the step creates are group read/write (umask 007).
    expect(statSync(join(staged, 'checkout', 'made.txt')).mode & 0o777).toBe(
      0o660,
    )
    await iso.close()
    expect(lstatSync(work).isDirectory()).toBe(true)
    expect(existsSync(staged)).toBe(false)
    expect(readFileSync(join(work, 'checkout', 'made.txt'), 'utf8')).toBe('')
    rmSync(base, { recursive: true })
  },
)
