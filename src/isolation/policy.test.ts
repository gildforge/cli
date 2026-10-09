import { describe, expect, test } from 'bun:test'
import {
  IsolationRefused,
  resolveIsolation,
  type Level,
  type PolicyInput,
} from './policy'

const all: Level[] = ['vm', 'container', 'host', 'none']
const run = (i: Partial<PolicyInput>) =>
  resolveIsolation({ available: all, ...i })

describe('isolation policy', () => {
  test('most specific request wins: flag, job, profile, host default', () => {
    expect(
      run({ flag: 'host', job: 'vm', profile: 'container', hostDefault: 'vm' }),
    ).toEqual({ level: 'host', source: 'flag' })
    expect(run({ job: 'container', profile: 'vm', hostDefault: 'vm' })).toEqual(
      { level: 'container', source: 'job' },
    )
    expect(run({ profile: 'container', hostDefault: 'vm' })).toEqual({
      level: 'container',
      source: 'profile',
    })
    expect(run({ hostDefault: 'container' })).toEqual({
      level: 'container',
      source: 'host-default',
    })
  })

  test('with no request the strongest available level is chosen, never none', () => {
    expect(run({})).toEqual({ level: 'vm', source: 'auto' })
    expect(run({ available: ['container', 'host', 'none'] })).toEqual({
      level: 'container',
      source: 'auto',
    })
    expect(run({ available: ['host', 'none'] })).toEqual({
      level: 'host',
      source: 'auto',
    })
  })

  test('nothing available and no explicit none refuses, even with nothing else set', () => {
    expect(() => run({ available: ['none'] })).toThrow(/no isolation backend/)
    expect(() => run({ available: ['none'], floor: 'host' })).toThrow(
      IsolationRefused,
    )
  })

  test('explicit none is allowed without a floor and refused under one', () => {
    expect(run({ flag: 'none' })).toEqual({ level: 'none', source: 'flag' })
    expect(() => run({ flag: 'none', floor: 'host' })).toThrow(
      /below this host's floor "host"/,
    )
  })

  test('a request below the floor is refused, not changed, whichever source asked', () => {
    for (const key of ['flag', 'job', 'profile', 'hostDefault'] as const)
      expect(() => run({ [key]: 'container', floor: 'vm' })).toThrow(
        /below this host's floor "vm"/,
      )
  })

  test('a request at or above the floor is honoured', () => {
    expect(run({ flag: 'vm', floor: 'container' }).level).toBe('vm')
    expect(run({ job: 'container', floor: 'container' }).level).toBe(
      'container',
    )
  })

  test('auto respects the floor: container-only host with a vm floor refuses', () => {
    expect(() =>
      run({ available: ['container', 'host', 'none'], floor: 'vm' }),
    ).toThrow(/requires isolation "vm"/)
    expect(
      run({ available: ['container', 'none'], floor: 'container' }).level,
    ).toBe('container')
  })

  test('an unavailable requested level is refused, never downgraded', () => {
    expect(() => run({ flag: 'vm', available: ['container', 'none'] })).toThrow(
      /not available/,
    )
    expect(() => run({ job: 'container', available: ['vm', 'none'] })).toThrow(
      /not available/,
    )
  })

  test('a more specific weaker request does not hide the floor', () => {
    expect(() => run({ flag: 'host', hostDefault: 'vm', floor: 'vm' })).toThrow(
      IsolationRefused,
    )
  })
})
