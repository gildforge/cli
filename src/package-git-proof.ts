// Minimal ordinary Git objects retained at explicit install; all parsing is Git plumbing.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fstatSync } from 'node:fs'
import { AnchoredDirectory } from './isolation/anchored-fs'
import type { AgentPackageLockedDependency } from './api/agent-package-contract'
export const PACKAGE_OBJECTS = '.gild-package-objects'
export type GitRead = (args: string[], input?: Buffer) => Buffer
export function proofGit(directory: string): GitRead {
  return (args, input) =>
    execFileSync(
      'git',
      [
        '--no-replace-objects',
        '--literal-pathspecs',
        '--git-dir=' + directory,
        ...args,
      ],
      {
        input,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith('GIT_'),
            ),
          ),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
}
/** Verify each exact commit/tree/blob hash before asking Git to follow its links. */
export function pinnedSourceLock(
  entry: AgentPackageLockedDependency,
  git: GitRead,
  retain?: (type: string, data: Buffer, id: string) => void,
) {
  const object = (type: string, id: string) => {
    if (!/^[a-f0-9]{40}$/.test(id)) throw Error('Invalid Git proof object id')
    const data = git(['cat-file', type, id])
    if (
      git(['hash-object', '-t', type, '--stdin'], data).toString().trim() !== id
    )
      throw Error('Git proof object integrity mismatch')
    retain?.(type, data, id)
    return data
  }
  object('commit', entry.commit)
  let tree = git(['rev-parse', entry.commit + '^{tree}'])
    .toString()
    .trim()
  for (const name of entry.bundlePath?.split('/') ?? []) {
    object('tree', tree)
    tree = git(['rev-parse', tree + ':' + name])
      .toString()
      .trim()
  }
  object('tree', tree)
  const listing = git(['ls-tree', '-z', tree, '--', 'gild.lock']).toString()
  if (!/^(100644|100755) blob [a-f0-9]{40}\tgild.lock\0$/.test(listing))
    throw Error('Missing or non-plain pinned source lock proof')
  const id = git(['rev-parse', tree + ':gild.lock'])
    .toString()
    .trim()
  return object('blob', id)
}
export function readPinnedSourceLock(
  directory: string,
  entry: AgentPackageLockedDependency,
) {
  const root = AnchoredDirectory.open(directory)
  let cache: AnchoredDirectory | undefined
  try {
    cache = root.directory(PACKAGE_OBJECTS)
    const info = fstatSync(cache.fd)
    if (info.uid !== process.getuid!() || info.mode & 0o022)
      throw Error('Unsafe local Git proof cache')
    return pinnedSourceLock(entry, proofGit(join(directory, PACKAGE_OBJECTS)))
  } finally {
    cache?.close()
    root.close()
  }
}
