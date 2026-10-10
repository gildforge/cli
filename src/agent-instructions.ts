import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { GildClient } from './api/client'
export type InstructionsTarget = {
  owner: string
  repo: string
  sponsor: string
  label: string
}
export type InstructionStatus = {
  state: 'synced' | 'conflict' | 'error'
  revision?: string
  warning?: string
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export function instructionPath(directory: string, runtime: string) {
  const name = runtime.split('/').at(-1)
  if (name !== 'claude' && name !== 'codex')
    throw Error('Instructions sync requires claude or codex')
  return join(directory, name === 'claude' ? 'CLAUDE.md' : 'AGENTS.md')
}
async function localText(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (!file) return null
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 65536)
      throw Error('Instructions must be a file of at most 64 KB')
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}
async function atomic(path: string, text: string) {
  const partial = path + '.' + randomBytes(8).toString('hex') + '.tmp'
  try {
    const file = await open(partial, 'wx', 0o600)
    try {
      await file.writeFile(text)
    } finally {
      await file.close()
    }
    await rename(partial, path)
  } finally {
    await unlink(partial).catch(() => {})
  }
}
type Stamp = { source: string; local: string; remote: string }
/** Never treat an existing user file as a prior successful sync. */
export async function pullInstructions(
  directory: string,
  runtime: string,
  source: string,
  remote: { text: string; revision: string },
  overwrite = false,
): Promise<InstructionStatus> {
  const path = instructionPath(directory, runtime),
    record = path + '.gild-sync.json'
  let stamp: Stamp | undefined
  try {
    stamp = JSON.parse(await readFile(record, 'utf8'))
  } catch {}
  const local = await localText(path)
  if (hash(remote.text) !== remote.revision)
    throw Error('Instructions revision does not match the text')
  if (
    local !== null &&
    local !== remote.text &&
    !overwrite &&
    (!stamp || stamp.source !== source || stamp.local !== hash(local))
  )
    return {
      state: 'conflict',
      revision: remote.revision,
      warning: `Kept locally edited ${path}; run gild agent instructions <name> --pull to resolve the conflict`,
    }
  if (local !== remote.text) await atomic(path, remote.text)
  await atomic(
    record,
    JSON.stringify({
      source,
      local: hash(remote.text),
      remote: remote.revision,
    } satisfies Stamp) + '\n',
  )
  return { state: 'synced', revision: remote.revision }
}
export class InstructionsSync {
  status?: InstructionStatus
  private serial = Promise.resolve()
  private revision?: string
  constructor(
    private readonly options: {
      client: Pick<GildClient, 'request'>
      target: InstructionsTarget
      directory: string
      runtime: string
      enqueue: (prompt: string) => void
      apply?: (text: string) => Promise<string | void>
    },
  ) {}
  check() {
    const result = this.serial.then(async () => {
      try {
        const remote = await this.options.client.request(
          'agentInstructions',
          this.options.target,
        )
        const source = JSON.stringify(this.options.target)
        const status = await pullInstructions(
          this.options.directory,
          this.options.runtime,
          source,
          remote,
        )
        this.status = status
        if (status.state === 'synced') {
          const warning = await this.options.apply?.(remote.text)
          if (warning)
            return (this.status = { ...status, state: 'conflict', warning })
          if (this.revision && this.revision !== remote.revision)
            this.options.enqueue(
              '[gild] your instructions changed. Re-read ' +
                instructionPath(this.options.directory, this.options.runtime),
            )
          this.revision = remote.revision
        }
        return status
      } catch (e) {
        this.status = { state: 'error', warning: (e as Error).message }
        return this.status
      }
    })
    this.serial = result.then(() => {})
    return result
  }
}
