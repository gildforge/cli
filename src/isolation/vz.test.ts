import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  kernelCommandLine,
  planVzNetwork,
  vzAvailable,
  vzNetworkState,
} from './vz'

const filtered = { filtered: true },
  open = { filtered: false, reason: 'the vz pf anchor is not installed' }

describe('vz network: NAT only behind the pf anchor', () => {
  test('block never gets a network device', () => {
    expect(planVzNetwork('block', filtered).net).toBe('none')
    expect(planVzNetwork('block', open).net).toBe('none')
  })
  test('auto: NAT when the LAN is denied, otherwise no network and the fix', () => {
    expect(planVzNetwork('auto', filtered)).toEqual({
      net: 'nat',
      note: expect.stringContaining('LAN/host/metadata denied'),
    })
    const p = planVzNetwork('auto', open)
    expect(p.net).toBe('none')
    expect(p.note).toContain('sudo scripts/vz-network-setup.sh')
  })
  test('allow without the filter is refused, never unfiltered NAT', () => {
    expect(() => planVzNetwork('allow', open)).toThrow(
      /Needs Sami: sudo scripts\/vz-network-setup.sh/,
    )
    expect(planVzNetwork('allow', filtered).net).toBe('nat')
  })
})

describe('vz network marker', () => {
  test('absent marker: not filtered', () => {
    expect(vzNetworkState('/nonexistent/gild/vz-network.json')).toEqual(open)
  })
  test('a marker the runner user could have written is not trusted', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? '.', 'vzm-'))
    const m = join(dir, 'vz-network.json')
    writeFileSync(m, JSON.stringify({ version: 1, network: 'lan-denied' }))
    const s = vzNetworkState(m)
    // Root running the tests owns the file, so only assert for normal users.
    if (process.getuid?.() !== 0) {
      expect(s.filtered).toBe(false)
      expect(s.reason).toContain('not root-owned')
    }
  })
})

test('kernel command line: host time always, DHCP only with NAT', () => {
  const at = new Date('2026-10-09T12:00:00Z')
  const none = kernelCommandLine('none', at)
  expect(none).toContain('console=hvc0')
  expect(none).toContain('init=/init-gild.sh')
  expect(none).toContain(`gild.time=${at.getTime() / 1000}`)
  expect(none).not.toContain('gild.net=')
  expect(kernelCommandLine('nat', at)).toContain('gild.net=dhcp')
})

test('vz is never available off macOS', () => {
  expect(
    vzAvailable({ helper: 'true', kernel: '/', rootfs: '/' }, 'linux'),
  ).toBe(false)
})
