// Worker-only owned lifecycle fixture: deterministic host cleanup rejection.
// The actual worker/finalizer/listener/socket logic remains production source.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DetachedHost as ActualDetachedHost } from '../../src/spawn-detach'
export * from '../../src/spawn-detach'
export class DetachedHost extends ActualDetachedHost {
  override cleanup() {
    const marker = join(process.env.HOME!, 'retirement-failed')
    const attempts = existsSync(marker)
      ? Number(readFileSync(marker, 'utf8'))
      : 0
    writeFileSync(marker, String(attempts + 1))
    throw Object.assign(new Error('retirement failure fixture'), {
      code: 'EACCES',
    })
  }
}
