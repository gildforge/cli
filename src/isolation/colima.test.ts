import { expect, test } from 'bun:test'
import {
  colimaMountFor,
  colimaMounts,
  detectColima,
  type ColimaProbe,
} from './colima'

// `colima status --json` from colima 0.10.3 on the Intel iMac (vz, virtiofs).
const RUNNING = JSON.stringify({
  display_name: 'colima',
  driver: 'macOS Virtualization.Framework',
  arch: 'x86_64',
  runtime: 'docker',
  mount_type: 'virtiofs',
  docker_socket: 'unix:///Users/sami/.colima/default/docker.sock',
  containerd_socket: 'unix:///Users/sami/.colima/default/containerd.sock',
  kubernetes: false,
  cpu: 4,
})

const probe = (o: Partial<ColimaProbe>): ColimaProbe => ({
  installed: () => true,
  status: () => RUNNING,
  config: () => 'vmType: vz\nmounts: []\n',
  home: '/Users/sami',
  exists: () => true,
  ...o,
})

test('not installed: says what Sami has to install', () => {
  const s = detectColima(probe({ installed: () => false }))
  expect(s).toMatchObject({ running: false, reason: 'Colima is not installed' })
  expect(!s.running && s.fix).toBe(
    'Needs Sami: brew install colima docker && colima start --vm-type vz --mount-type virtiofs',
  )
})

test('installed but stopped (status fails)', () => {
  expect(detectColima(probe({ status: () => undefined }))).toMatchObject({
    running: false,
    reason: 'Colima is not running',
  })
})

test('containerd runtime is not usable as the docker backend', () => {
  const s = detectColima(
    probe({ status: () => RUNNING.replace('"docker"', '"containerd"') }),
  )
  expect(s.running).toBe(false)
})

test('a missing socket file is not running', () => {
  expect(detectColima(probe({ exists: () => false })).running).toBe(false)
})

test('running vz with the default mounts: $HOME, writable', () => {
  expect(detectColima(probe({}))).toEqual({
    running: true,
    socket: 'unix:///Users/sami/.colima/default/docker.sock',
    vmType: 'vz',
    arch: 'x86_64',
    mountType: 'virtiofs',
    mounts: [{ location: '/Users/sami', writable: true }],
  })
})

test('explicit mounts replace the default; ~ expands; writable defaults to false', () => {
  const yaml =
    'mounts:\n  - location: ~/projects\n    writable: true\n  - location: /Volumes/Projects\n  - location: ~/secrets\n    writable: false\n'
  const mounts = colimaMounts(yaml, '/Users/sami')
  expect(mounts).toEqual([
    { location: '/Users/sami/projects', writable: true },
    { location: '/Volumes/Projects', writable: false },
    { location: '/Users/sami/secrets', writable: false },
  ])
  expect(colimaMountFor('/Users/sami/projects/a/b', mounts, true)).toEqual(
    mounts[0],
  )
  expect(colimaMountFor('/Volumes/Projects/x', mounts, true)).toBeUndefined()
  expect(colimaMountFor('/Volumes/Projects/x', mounts, false)).toEqual(
    mounts[1],
  )
  // A sibling with a common prefix is not inside the mount.
  expect(colimaMountFor('/Users/sami/projects2', mounts, false)).toBeUndefined()
})
