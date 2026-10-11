import { expect, test } from 'bun:test'
import { workImageBytes } from './firecracker'

test('workspace image sizing stays positive across the signed 32-bit boundary', () => {
  expect(workImageBytes(0)).toBe(256 * 1024 ** 2)
  expect(workImageBytes(1024 ** 2)).toBe(2176 * 1024 ** 2)
  expect(workImageBytes(2 * 1024 ** 2)).toBe(4224 * 1024 ** 2)
  expect(workImageBytes(4032 * 1024)).toBe(8 * 1024 ** 3)
  expect(() => workImageBytes(4032 * 1024 + 1)).toThrow('8 GiB limit')
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    expect(() => workImageBytes(n)).toThrow()
})
