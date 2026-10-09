import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { containerNetwork } from './container'
import {
  bootNetArgs,
  guestNetwork,
  networkState,
  planNetwork,
  type NetworkState,
} from './network'

const sys = (taps: Record<string, number>, bridge = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'sys-'))
  if (bridge) mkdirSync(join(dir, 'gildbr0'))
  for (const [name, owner] of Object.entries(taps)) {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, 'owner'), String(owner))
  }
  return dir
}
const lock = () => mkdtempSync(join(tmpdir(), 'locks-'))
const none: NetworkState = {
  ready: false,
  slots: [],
  reason: 'no gildbr0 bridge',
}

test('network state: ready only with the bridge and taps owned by this user', () => {
  expect(networkState(1000, sys({}, false)).ready).toBe(false)
  expect(networkState(1000, sys({ gildtap0: 1000 }, false)).ready).toBe(false)
  expect(networkState(1000, sys({ gildtap0: 0 })).ready).toBe(false)
  expect(
    networkState(1000, sys({ gildtap1: 1000, gildtap0: 1000, gildtap2: 0 })),
  ).toEqual({
    ready: true,
    slots: [0, 1],
  })
})

test('not set up: auto and block give a VM no network device, allow is an error naming the fix', () => {
  expect(planNetwork('auto', none, lock()).net).toBeUndefined()
  expect(planNetwork('auto', none, lock()).note).toContain(
    'sudo scripts/vm-network-setup.sh',
  )
  expect(planNetwork('block', none, lock()).net).toBeUndefined()
  expect(() => planNetwork('allow', none, lock())).toThrow(
    /Needs Sami: sudo scripts\/vm-network-setup\.sh/,
  )
})

test('set up: auto and allow get a tap, block does not, slots are exclusive and released', () => {
  const ready: NetworkState = { ready: true, slots: [0, 1] }
  const dir = lock()
  const a = planNetwork('auto', ready, dir)
  const b = planNetwork('allow', ready, dir)
  expect([a.net!.tap, b.net!.tap]).toEqual(['gildtap0', 'gildtap1'])
  expect(a.net!.ip).not.toBe(b.net!.ip)
  expect(() => planNetwork('auto', ready, dir)).toThrow(/in use/)
  a.release()
  expect(planNetwork('auto', ready, dir).net!.tap).toBe('gildtap0')
  expect(planNetwork('block', ready, dir).net).toBeUndefined()
})

test('a slot held by a dead process is taken over', () => {
  const dir = lock()
  writeFileSync(join(dir, 'gildtap0.lock'), '999999')
  expect(planNetwork('auto', { ready: true, slots: [0] }, dir).net!.tap).toBe(
    'gildtap0',
  )
})

test('guest addressing the init script consumes', () => {
  const n = guestNetwork(3)
  expect(bootNetArgs(n)).toBe(
    'gild.ip=172.31.255.13/24 gild.gw=172.31.255.1 gild.dns=1.1.1.1',
  )
  expect(n.mac).toBe('06:00:ac:1f:ff:0d')
})

test('container network follows the same rule', () => {
  expect(containerNetwork('auto', false)).toBe('none')
  expect(containerNetwork('block', true)).toBe('none')
  expect(containerNetwork('auto', true)).toBe('gild-egress')
  expect(containerNetwork('allow', true)).toBe('gild-egress')
  expect(() => containerNetwork('allow', false)).toThrow(/Needs Sami/)
})

test('--persist unit runs only a root-owned installed copy, never a path in the checkout', async () => {
  const script = resolve('scripts/vm-network-setup.sh')
  const p = Bun.spawnSync(['sh', script, '--print-unit'])
  const unit = new TextDecoder().decode(p.stdout)
  expect(p.exitCode).toBe(0)
  const exec = /^ExecStart=(\S+)/m.exec(unit)![1]
  expect(exec).toBe('/usr/local/libexec/gild-vm-network-setup')
  expect(exec.startsWith(resolve('.'))).toBe(false)
  expect(unit).not.toContain(script)
  // The installer copies it as root with fixed ownership and mode.
  const text = await Bun.file(script).text()
  expect(text).toContain('install -o root -g root -m 0755 "$0" "$installed"')
  expect(text).not.toContain('readlink -f')
})
