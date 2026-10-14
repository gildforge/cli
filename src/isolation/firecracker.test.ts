import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defaultFirecracker, workImageBytes } from './firecracker'
import { hostConfigSchema } from './index'

test('workspace image sizing stays positive across the signed 32-bit boundary', () => {
  expect(workImageBytes(0)).toBe(256 * 1024 ** 2)
  expect(workImageBytes(1024 ** 2)).toBe(2176 * 1024 ** 2)
  expect(workImageBytes(2 * 1024 ** 2)).toBe(4224 * 1024 ** 2)
  expect(workImageBytes(4032 * 1024)).toBe(8 * 1024 ** 3)
  expect(() => workImageBytes(4032 * 1024 + 1)).toThrow('8 GiB limit')
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    expect(() => workImageBytes(n)).toThrow()
})

test('Firecracker: isolation.json first, then the one shipped next to gild, then PATH', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const dir = await mkdtemp(resolve('.tmp/fc-bundled-'))
  try {
    const gild = join(dir, 'gild')
    // Nothing next to gild: PATH.
    expect(defaultFirecracker(gild)).toBe('firecracker')
    // Present but not executable: still PATH.
    await writeFile(join(dir, 'firecracker'), '', { mode: 0o644 })
    expect(defaultFirecracker(gild)).toBe('firecracker')
    // The npm package's layout: bin/gild and bin/firecracker.
    await chmod(join(dir, 'firecracker'), 0o755)
    expect(defaultFirecracker(gild)).toBe(join(dir, 'firecracker'))
    // isolation.json's own choice wins over the default.
    const { vm } = hostConfigSchema(dir).parse({
      vm: { firecracker: '/opt/fc/firecracker' },
    })
    expect(vm!.firecracker).toBe('/opt/fc/firecracker')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
