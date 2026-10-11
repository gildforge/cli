import { expect, test } from 'bun:test'
import { actionSupport } from './support'

test('generated Actions contract rejects artifact upload and dependency cache backends', () => {
  for (const values of [{}, { name: 'build', path: 'dist' }])
    expect(actionSupport('Actions/Upload-Artifact@v4', values).error).toBe(
      'actions/upload-artifact is unsupported: this runner has no artifact upload backend',
    )
  for (const values of [{}, { path: 'deps', key: 'fixture' }])
    expect(actionSupport('actions/cache@v4', values).error).toBe(
      'actions/cache is unsupported: this runner has no dependency cache backend',
    )
  for (const action of ['actions/setup-node', 'actions/setup-go']) {
    for (const cache of [true, 'true', 'npm'])
      expect(actionSupport(`${action}@v6`, { cache }).error).toBe(
        `${action} dependency caching is unsupported: remove the cache input to run without caching`,
      )
    for (const values of [
      {},
      { cache: false },
      { cache: 'false' },
      { cache: '' },
    ]) {
      const result = actionSupport(`${action}@v6`, values)
      expect(result.error).toBeUndefined()
      expect(result.warnings.join('\n')).not.toContain('no-op')
    }
  }
})
