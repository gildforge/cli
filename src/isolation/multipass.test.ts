import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  guestProgram,
  noRoute,
  noRouteError,
  readiness,
  retryNoRoute,
} from './multipass'

const NO_ROUTE =
  "exec failed: ssh connection failed: 'Failed to connect: No route to host'\n"

describe('guestProgram', () => {
  const cwd = '/Users/me/work'
  test('a script inside the working directory runs by its relative path', () => {
    expect(guestProgram(join(cwd, 'agent.sh'), cwd)).toBe('./agent.sh')
    expect(guestProgram(join(cwd, 'bin', 'run'), cwd)).toBe('./bin/run')
  })
  test('a program from PATH runs by name from the VM PATH', () => {
    expect(guestProgram('/opt/homebrew/bin/claude', cwd)).toBe('claude')
    expect(guestProgram('/bin/sh', cwd)).toBe('sh')
  })
  test('a sibling directory with the same prefix is not inside', () => {
    expect(guestProgram('/Users/me/work2/agent.sh', cwd)).toBe('agent.sh')
    expect(guestProgram('/Users/me/agent.sh', cwd)).toBe('agent.sh')
  })
})

describe('No route to host', () => {
  test('is recognised in Multipass output', () => {
    expect(noRoute(NO_ROUTE)).toBe(true)
    expect(noRoute('exec failed: instance "gild" is not running')).toBe(false)
  })
  test('on macOS the error names the Local Network setting', () => {
    const message = noRouteError('darwin').message
    expect(message).toContain('No route to host')
    expect(message).toContain(
      'System Settings → Privacy & Security → Local Network',
    )
  })
  test('is retried, then returned when it persists', () => {
    let calls = 0
    const slept: number[] = []
    const r = retryNoRoute(
      () => (calls++, { status: 2, stdout: '', stderr: NO_ROUTE }),
      { tries: 3, delayMs: 7, sleep: (ms) => slept.push(ms) },
    )
    expect(calls).toBe(3)
    expect(slept).toEqual([7, 7])
    expect(r.status).toBe(2)
  })
  test('a retry that connects returns its result', () => {
    const results = [
      { status: 2, stdout: '', stderr: NO_ROUTE },
      { status: 0, stdout: 'ready\n', stderr: '' },
    ]
    let calls = 0
    const r = retryNoRoute(() => results[calls++], { sleep: () => {} })
    expect(calls).toBe(2)
    expect(r.stdout).toBe('ready\n')
  })
  test('other failures are not retried', () => {
    let calls = 0
    retryNoRoute(() => (calls++, { status: 1, stdout: '', stderr: 'nope' }), {
      sleep: () => {},
    })
    expect(calls).toBe(1)
  })
})

describe('readiness', () => {
  test('only the marker answer decides set up or not', () => {
    expect(readiness({ status: 0, stdout: 'ready\n', stderr: '' })).toBe(true)
    expect(readiness({ status: 0, stdout: 'missing\n', stderr: '' })).toBe(
      false,
    )
  })
  test('an unreachable VM is an error, not "not set up yet"', () => {
    expect(() =>
      readiness({ status: 2, stdout: '', stderr: NO_ROUTE }),
    ).toThrow('No route to host')
    expect(() =>
      readiness({ status: 2, stdout: '', stderr: 'exec failed: boom' }),
    ).toThrow('checking the gild VM: exec failed: boom')
  })
})
