// Safe lifecycle fixture: no VM, model, credentials or agent process is started.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  finishVmSync,
  guestEnvironment,
  VmSyncError,
  type VmChild,
} from '../../src/spawn-vm'
import type { RecoveryLocation } from '../../src/isolation/sync'
export { guestEnvironment }

export async function startVmChild(opts: {
  cwd: string
  args: string[]
  log?: (line: string) => void
}): Promise<VmChild> {
  const vmDir = join(opts.cwd, 'retained')
  await mkdir(vmDir, { mode: 0o700 })
  await writeFile(join(vmDir, 'source-fixture'), 'recoverable source\n')
  let exit: (event: { exitCode: number }) => void = () => {}
  let ended = false
  let recovery: RecoveryLocation | undefined
  const sync = async () => {
    await writeFile(join(vmDir, 'sync-started'), '')
    const until = Date.now() + 5000
    while (!existsSync(join(vmDir, 'release-sync'))) {
      if (Date.now() > until) throw Error('fixture final sync was not released')
      await new Promise((done) => setTimeout(done, 10))
    }
    if (opts.args[0] === 'failure') throw Error('guest unavailable fixture')
    return {
      written: [],
      deleted: [],
      rejected: [],
      conflicts:
        opts.args[0] === 'partial'
          ? [{ path: 'fixture', reason: 'both sides changed' }]
          : [],
    }
  }
  return {
    pid: -1,
    write() {},
    resize() {},
    onData() {},
    pause() {},
    resume() {},
    onExit(cb) {
      exit = cb
    },
    kill() {
      if (!ended) {
        ended = true
        exit({ exitCode: 0 })
      }
    },
    sync,
    async dispose() {
      try {
        const result = await finishVmSync(
          sync,
          {
            close: async (o) => {
              if (!o?.preserveWorkspace) await rm(vmDir, { recursive: true })
            },
          },
          vmDir,
          opts.log,
        )
        recovery = result.recovery
        return result
      } catch (error) {
        if (error instanceof VmSyncError) recovery = error.recovery
        throw error
      }
    },
    get recovery() {
      return recovery
    },
  }
}
