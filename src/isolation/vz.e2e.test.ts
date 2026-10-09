// The macOS vz backend against a real Virtualization.framework VM.
// Needs a Mac with the signed helper, kernel and rootfs described in
// $TEST_VZ_CONFIG_DIR/isolation.json (see FINDINGS.md, "macOS vz backend").
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { loadHostConfig } from './index'
import type { Isolation } from './session'
import { startVz, vzNetworkState } from './vz'

const configDir = process.env.TEST_VZ_CONFIG_DIR

async function run(iso: Isolation, cmd: string, env = {}) {
  const lines: string[] = []
  const code = await iso.exec(['bash', '-c', cmd], {
    cwd: '/workspace',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...env },
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    onLine: async (l) => void lines.push(l),
  })
  return { code, out: lines.join('\n') }
}

/** Resident memory of the Virtualization.framework VM processes (the guest's RAM lives there). */
function vmProcesses() {
  const out = execFileSync('ps', ['-axo', 'pid=,rss=,comm='], {
    encoding: 'utf8',
  })
  return new Map(
    out
      .split('\n')
      .filter((l) => l.includes('com.apple.Virtualization.VirtualMachine'))
      .map((l) => l.trim().split(/\s+/))
      .map(([pid, rss]) => [pid, Number(rss)] as const),
  )
}

describe.skipIf(!configDir)('vz microVM, live', () => {
  const setup = async () => {
    const host = await loadHostConfig(configDir!)
    const base = mkdtempSync(join(process.env.TMPDIR ?? '.', 'vze2e-'))
    const work = join(base, 'work')
    execFileSync('mkdir', ['-p', work])
    writeFileSync(join(work, 'hello.txt'), 'hello from the host\n')
    const cfg = { ...host.vm!, helper: host.vm!.vz, port: 9002 }
    return { cfg, base, work }
  }

  test('boots, runs steps in a copy of the checkout, base image and host untouched', async () => {
    const { cfg, base, work } = await setup()
    const baseStat = statSync(cfg.rootfs)
    const before = vmProcesses()
    const boots: number[] = []
    for (let i = 0; i < 3; i++) {
      const lines: string[] = []
      const iso = (await startVz(
        { ...cfg, egress: 'block' },
        work,
        join(base, `vm${i}`),
        (l) => lines.push(l),
      )) as Isolation & { timings: { bootToAgentMs: number; imageMs: number } }
      boots.push(iso.timings.bootToAgentMs)
      console.log(`VZ boot ${i}: ${lines.join(' | ')}`)
      try {
        const arch = await run(iso, 'uname -m; nproc; free -m | sed -n 2p')
        console.log(`VZ guest: ${arch.out.replace(/\n/g, ' | ')}`)
        expect(arch.code).toBe(0)
        expect(arch.out).toContain('aarch64')
        // The checkout is there and writable; the write lands in the clone only.
        expect((await run(iso, 'cat hello.txt')).out).toBe(
          'hello from the host',
        )
        expect((await run(iso, 'echo guest > made-in-guest.txt')).code).toBe(0)
        expect(existsSync(join(work, 'made-in-guest.txt'))).toBe(false)
        // Root is a per-VM clone: a write in VM 0 is not seen by VM 1.
        const seen = await run(
          iso,
          'cat /etc/gild-e2e 2>/dev/null; echo vm' + i + ' > /etc/gild-e2e',
        )
        expect(seen.code).toBe(0)
        expect(seen.out).toBe('')
        // The host passed its clock; TLS needs it.
        const guestNow = Number((await run(iso, 'date +%s')).out)
        expect(Math.abs(guestNow - Date.now() / 1000)).toBeLessThan(5)
        // No network device without the pf filter.
        expect((await run(iso, 'test -e /sys/class/net/eth0')).code).not.toBe(0)
        // Secrets travel in the exec frame only.
        const secret = await run(
          iso,
          'echo "len=${#TOKEN}"; ! grep -q "$TOKEN" /proc/cmdline',
          { TOKEN: 'sekret-vz-e2e' },
        )
        expect(secret).toEqual({ code: 0, out: 'len=13' })
        if (i === 0) {
          const now = vmProcesses()
          const fresh = [...now].filter(([pid]) => !before.has(pid))
          console.log(
            `VZ memory: VM process RSS ${fresh.map(([, kb]) => Math.round(kb / 1024) + ' MB').join(', ')} (configured ${cfg.memoryMiB} MiB)`,
          )
        }
      } finally {
        await iso.close()
      }
      expect(existsSync(join(base, `vm${i}`))).toBe(false)
    }
    console.log(`VZ boot to agent: ${boots.join(' / ')} ms`)
    const after = statSync(cfg.rootfs)
    expect(after.mtimeMs).toBe(baseStat.mtimeMs)
    expect(after.size).toBe(baseStat.size)
    expect(readFileSync(join(work, 'hello.txt'), 'utf8')).toBe(
      'hello from the host\n',
    )
  }, 120_000)

  test('a guest connection to host port 9100 reaches the host listener (hook relay)', async () => {
    const { cfg, base, work } = await setup()
    const iso = await startVz(
      { ...cfg, egress: 'block' },
      work,
      join(base, 'hk'),
    )
    try {
      const got = new Promise<any>((r) => iso.onGuestMessage!(9100, r))
      const sent = await run(
        iso,
        `echo '{"x":1}' | gild-guest-agent hook --session s-e2e --agent claude`,
      )
      console.log(`VZ hook: ${JSON.stringify(sent)}`)
      const m = await Promise.race([
        got,
        new Promise((_, no) =>
          setTimeout(() => no(new Error('no hook')), 5000),
        ),
      ])
      expect(m).toMatchObject({ op: 'hook', session: 's-e2e' })
    } finally {
      await iso.close()
    }
  }, 60_000)

  // Why NAT is gated: plain VZ NAT reaches the Mac's LAN. Run only to measure
  // (TEST_VZ_NAT_PROBE=<LAN host:port the Mac can reach>); it forces NAT
  // without the pf anchor, which the product never does.
  test.skipIf(!process.env.TEST_VZ_NAT_PROBE)(
    'unfiltered VZ NAT reaches the internet and the LAN (measurement)',
    async () => {
      const { cfg, base, work } = await setup()
      const iso = await startVz(
        { ...cfg, egress: 'auto' },
        work,
        join(base, 'nat'),
        (l) => console.log(`VZ nat: ${l}`),
        { filtered: true },
      )
      try {
        const lan = process.env.TEST_VZ_NAT_PROBE!.replace(':', '/')
        const r = await run(
          iso,
          `ip -4 addr show eth0 | grep inet; ip route | head -1; ` +
            `getent hosts gild.gg >/dev/null && echo dns=ok; ` +
            `timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' && echo internet=ok; ` +
            `timeout 5 bash -c 'exec 3<>/dev/tcp/${lan}' && echo lan=reachable || echo lan=blocked; ` +
            `timeout 3 bash -c 'exec 3<>/dev/tcp/169.254.169.254/80' && echo metadata=reachable || echo metadata=blocked`,
        )
        console.log(`VZ nat probe: ${r.out.replace(/\n/g, ' | ')}`)
        expect(r.out).toContain('internet=ok')
        console.log(`vz pf anchor installed: ${vzNetworkState().filtered}`)
      } finally {
        await iso.close()
      }
    },
    60_000,
  )
})
