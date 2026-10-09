import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCanIsolate, loadHostConfig, statusLines } from './index'

test('a host with no backend refuses to start a runner and says how to fix it', () => {
  expect(() => assertCanIsolate({})).toThrow(
    /isolation\.json.*--isolation none/s,
  )
})

test('explicit none starts, labelled unisolated', () => {
  const r = assertCanIsolate({}, 'none')
  expect(r).toEqual({ level: 'none', source: 'flag' })
  expect(statusLines({}, { flag: 'none' }).join('\n')).toContain('unisolated')
})

test('backends configured but unusable are not offered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iso-'))
  await writeFile(
    join(dir, 'isolation.json'),
    JSON.stringify({
      vm: { kernel: '/nope', rootfs: '/nope' },
      floor: 'container',
    }),
  )
  const host = await loadHostConfig(dir)
  expect(() => assertCanIsolate(host)).toThrow(/requires isolation "container"/)
  expect(statusLines(host).join('\n')).toContain('refused')
})

test('malformed isolation.json is an error, not silently ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iso-'))
  await writeFile(join(dir, 'isolation.json'), '{"floor":"bogus"}')
  await expect(loadHostConfig(dir)).rejects.toThrow(/isolation\.json/)
})
