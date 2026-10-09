// Live proof of the filtered network (needs `sudo scripts/vm-network-setup.sh`
// on this host). Runs the same probes inside a Firecracker VM and a container.
//   TEST_VM_CONFIG_DIR=<dir with isolation.json> bun test src/isolation/network.e2e.test.ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { loadHostConfig, type Isolation } from './index'
import { startFirecracker } from './firecracker'
import { startOci } from './container'
import { networkState } from './network'

const dir = process.env.TEST_VM_CONFIG_DIR
const ready = !!dir && networkState().ready

const hostIps = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i!.address)
const PORT = 18099
const tcp = (ip: string, port: number) =>
  `timeout 4 bash -c 'exec 3<>/dev/tcp/${ip}/${port}'`

async function run(iso: Isolation, cmd: string) {
  const lines: string[] = []
  const code = await iso.exec(['bash', '-c', cmd], {
    cwd: '/',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    onLine: async (l) => void lines.push(l),
  })
  return { code, out: lines.join('\n') }
}

let work = ''
// Positive control: every one of these is reachable from the host itself, so
// "blocked" inside the guest is the isolation, not a dead target.
async function hostControl(cmds: string[]) {
  const listener = Bun.listen({
    hostname: '0.0.0.0',
    port: PORT,
    socket: { data() {} },
  })
  try {
    const out: Record<string, string> = {}
    for (const c of cmds) {
      const p = Bun.spawn(['bash', '-c', c], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      out[c] = (await p.exited) === 0 ? 'reachable' : 'blocked'
    }
    return out
  } finally {
    listener.stop(true)
  }
}
// Any HTTP answer proves egress (gild.gg may answer 403 to non-browsers).
const web = (iso: Isolation) =>
  iso.level === 'vm'
    ? `python3 -c "import urllib.request as u,urllib.error as e
r=u.Request('https://gild.gg',method='HEAD',headers={'User-Agent':'curl/8'})
try: print(u.urlopen(r,timeout=8).status)
except e.HTTPError as x: print(x.code)"`
    : `curl -sI -m 8 https://gild.gg | head -1 | grep -q HTTP`

describe.skipIf(!ready)('filtered network, live', () => {
  const table: Record<string, Record<string, string>> = {}
  const probes = (iso: Isolation) => [
    ['https://gild.gg (internet egress)', web(iso), true],
    ['DNS: getent hosts gild.gg', 'getent hosts gild.gg', true],
    ...hostIps.map(
      (ip) => [`host IP ${ip}:${PORT}`, tcp(ip, PORT), false] as const,
    ),
    [`bridge gateway 172.31.255.1:${PORT}`, tcp('172.31.255.1', PORT), false],
    ['LAN host 192.168.1.254:80', tcp('192.168.1.254', 80), false],
    ['LAN host 192.168.1.29:80', tcp('192.168.1.29', 80), false],
    ['tailnet 100.100.100.100:80', tcp('100.100.100.100', 80), false],
    ['metadata 169.254.169.254:80', tcp('169.254.169.254', 80), false],
  ]

  async function check(iso: Isolation) {
    const row: Record<string, string> = {}
    const listener = Bun.listen({
      hostname: '0.0.0.0',
      port: PORT,
      socket: { data() {} },
    })
    try {
      await probe(iso, row)
    } finally {
      listener.stop(true)
    }
    table[iso.level] = row
  }

  async function probe(iso: Isolation, row: Record<string, string>) {
    for (const [name, cmd, shouldWork] of probes(iso)) {
      const r = await run(iso, cmd as string)
      row[name as string] = r.code === 0 ? 'reachable' : 'blocked'
      expect(r.code === 0, `${iso.level} ${name}: ${r.out}`).toBe(
        shouldWork as boolean,
      )
    }
  }

  for (const level of ['vm', 'container'] as const)
    test(`${level}: internet works, host/LAN/tailnet/metadata blocked`, async () => {
      const host = await loadHostConfig(dir!)
      work = mkdtempSync(join(process.env.TMPDIR ?? '.', 'net-'))
      mkdirSync(join(work, 'checkout'))
      const iso =
        level === 'vm'
          ? await startFirecracker(
              { ...host.vm!, port: 9002 },
              work,
              join(work, '..', 'vmnet-a'),
            )
          : startOci(host.container!, work)
      try {
        await check(iso)
      } finally {
        await iso.close()
        console.log(JSON.stringify(table, null, 1))
      }
    }, 180_000)

  test('control: the host itself reaches every blocked target', async () => {
    const targets = probes({ level: 'container' } as Isolation)
      // 169.254.169.254 has no route from this host either, so it has no control.
      .filter((p) => p[2] === false && !String(p[0]).startsWith('metadata'))
      .map((p) => p[1] as string)
    const seen = await hostControl(targets)
    console.log(JSON.stringify(seen, null, 1))
    for (const [c, v] of Object.entries(seen)) expect(v, c).toBe('reachable')
  }, 120_000)

  test('two VMs cannot reach each other', async () => {
    const host = await loadHostConfig(dir!)
    const w = mkdtempSync(join(process.env.TMPDIR ?? '.', 'net2-'))
    const a = await startFirecracker(
      { ...host.vm!, port: 9002 },
      w,
      join(w, '..', 'vmnet-b'),
    )
    const b = await startFirecracker(
      { ...host.vm!, port: 9002 },
      w,
      join(w, '..', 'vmnet-c'),
    )
    try {
      const ipOf = async (v: Isolation) =>
        (
          await run(
            v,
            "ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1",
          )
        ).out.trim()
      const [ia, ib] = [await ipOf(a), await ipOf(b)]
      expect(ia).not.toBe(ib)
      // A listens, B connects; and ping both ways.
      const listener = run(
        a,
        `timeout 10 python3 -m http.server 8099 --bind ${ia} >/dev/null 2>&1`,
      )
      await Bun.sleep(1500)
      const own = await run(a, tcp(ia, 8099))
      const cross = await run(b, tcp(ia, 8099))
      const ping = await run(b, `ping -c1 -W2 ${ia}`)
      console.log(
        JSON.stringify({
          a: ia,
          b: ib,
          listenerSelf: own.code,
          bToA_tcp: cross.code,
          bToA_ping: ping.code,
        }),
      )
      expect(own.code).toBe(0)
      expect(cross.code).not.toBe(0)
      expect(ping.code).not.toBe(0)
      await listener.catch(() => {})
    } finally {
      await a.close()
      await b.close()
    }
  }, 180_000)
})
