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
const tcp = (ip: string, port: number) =>
  `timeout 4 bash -c 'exec 3<>/dev/tcp/${ip}/${port}'`

async function run(iso: Isolation, cmd: string) {
  const lines: string[] = []
  const code = await iso.exec(['bash', '-c', cmd], {
    cwd: iso.guestPath(work),
    env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    onLine: async (l) => void lines.push(l),
  })
  return { code, out: lines.join('\n') }
}

let work = ''
const web = (iso: Isolation) =>
  iso.level === 'vm'
    ? `python3 -c "import urllib.request as u;print(u.urlopen(u.Request('https://gild.gg',method='HEAD'),timeout=8).status)"`
    : `curl -sI -m 8 https://gild.gg | head -1`

describe.skipIf(!ready)('filtered network, live', () => {
  const table: Record<string, Record<string, string>> = {}
  const probes = (iso: Isolation) => [
    ['https://gild.gg (internet egress)', web(iso), true],
    ['DNS: getent hosts gild.gg', 'getent hosts gild.gg', true],
    ...hostIps.map((ip) => [`host IP ${ip}:22`, tcp(ip, 22), false] as const),
    ['gateway 172.31.255.1:22', tcp('172.31.255.1', 22), false],
    ['LAN router 192.168.1.1:80', tcp('192.168.1.1', 80), false],
    ['tailnet 100.100.100.100:80', tcp('100.100.100.100', 80), false],
    ['metadata 169.254.169.254:80', tcp('169.254.169.254', 80), false],
  ]

  async function check(iso: Isolation) {
    const row: Record<string, string> = {}
    for (const [name, cmd, shouldWork] of probes(iso)) {
      const r = await run(iso, cmd as string)
      row[name as string] = r.code === 0 ? 'reachable' : 'blocked'
      expect(r.code === 0, `${iso.level} ${name}: ${r.out}`).toBe(
        shouldWork as boolean,
      )
    }
    table[iso.level] = row
  }

  test('vm and container: internet works, host/LAN/tailnet/metadata blocked', async () => {
    const host = await loadHostConfig(dir!)
    work = mkdtempSync(join(process.env.TMPDIR ?? '.', 'net-'))
    mkdirSync(join(work, 'checkout'))
    const vm = await startFirecracker(
      { ...host.vm!, port: 9002 },
      work,
      join(work, '..', 'vmnet-a'),
    )
    const ct = startOci(host.container!, work)
    try {
      await check(vm)
      await check(ct)
    } finally {
      await vm.close()
      await ct.close()
      console.log(JSON.stringify(table, null, 1))
    }
  }, 180_000)

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
