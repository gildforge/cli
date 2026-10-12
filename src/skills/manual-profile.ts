// Owner-invoked local profile skill delivery. No server grant/claim or OS custody
// promise is implied; native owner-UID and guest-root limitations remain visible.
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { mkdtemp, chmod } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  skillManifestSchema,
  skillSelectionSchema,
} from '../api/agent-profile-contract'
import { resolveSelectedSkill } from './selected-bytes'
import { SkillBundleCache } from './bundle-cache'
import { materializeSkillBundle } from './materialize'
import { openSkillRoot, SkillByteError } from './local-bytes'
import type { AnchoredDirectory } from '../isolation/anchored-fs'

export const manualProfileSkillSchema = z
  .object({
    cacheDirectory: z.string().refine(isAbsolute),
    selection: skillSelectionSchema,
    manifest: skillManifestSchema,
  })
  .strict()
export type ManualProfileSkill = z.infer<typeof manualProfileSkillSchema>
function ownedDirectory(root: AnchoredDirectory) {
  const info = fstatSync(root.fd)
  if (info.uid !== process.getuid?.() || info.mode & 0o022)
    throw new SkillByteError(
      'native skill directory must be owned and not writable by others',
    )
}
function sameDirectory(
  parent: AnchoredDirectory,
  name: string,
  expected: AnchoredDirectory,
) {
  const now = parent.directory(name)
  try {
    const a = fstatSync(now.fd),
      b = fstatSync(expected.fd)
    if (a.dev !== b.dev || a.ino !== b.ino)
      throw new SkillByteError(
        'native skill registration replaced; retained for recovery',
      )
  } finally {
    now.close()
  }
}
export async function prepareManualProfileSkill(
  value: unknown,
  runtime: string,
  cwd: string,
) {
  // Unsupported clients fail before byte delivery or process creation.
  if (runtime !== 'codex')
    throw new SkillByteError(
      'manual pinned skill delivery is currently supported for codex only',
    )
  const spec = manualProfileSkillSchema.parse(value)
  const binding = await resolveSelectedSkill(spec.selection, spec.manifest)
  if (binding.manifest.source.entrypoint !== 'SKILL.md')
    throw new SkillByteError(
      'native Codex skill requires a SKILL.md entrypoint',
    )
  const cache = new SkillBundleCache(spec.cacheDirectory)
  let material: Awaited<ReturnType<typeof materializeSkillBundle>> | undefined
  const opened: AnchoredDirectory[] = []
  try {
    // Private fresh materialization remains descriptor-bound; no trusted pathname
    // is borrowed from the cache for launch. Native discovery receives verified copies.
    const run = await mkdtemp(join(cwd, '.gild-manual-skill-'))
    await chmod(run, 0o700)
    material = await materializeSkillBundle(
      cache,
      spec.selection,
      spec.manifest,
      run,
    )
    const bytes = material.read()
    const root = openSkillRoot(cwd)
    opened.push(root)
    ownedDirectory(root)
    const agents = root.directory('.agents', true)
    opened.push(agents)
    ownedDirectory(agents)
    const skills = agents.directory('skills', true)
    opened.push(skills)
    ownedDirectory(skills)
    const name = 'gild-selected-' + randomBytes(12).toString('hex')
    const slot = skills.privateDirectory(name)
    opened.push(slot)
    for (const [path, data] of bytes.files) {
      const parts = path.split('/')
      let dir = slot
      const nested: AnchoredDirectory[] = []
      try {
        for (const part of parts.slice(0, -1)) {
          dir = dir.directory(part, true)
          nested.push(dir)
        }
        if (!dir.putRegularIfAbsent(parts.at(-1)!, Buffer.from(data)))
          throw new SkillByteError('native skill file already exists')
        if (!dir.readRegular(parts.at(-1)!, data.length).equals(data))
          throw new SkillByteError('native skill copy differs')
      } finally {
        for (const d of nested.reverse()) d.close()
      }
    }
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      try {
        // Do not delete changed/extra data. Every directory is fd-bound and the
        // published name must still resolve to our exact inode before unlinking.
        sameDirectory(skills, name, slot)
        const check = (dir: AnchoredDirectory, prefix: string) => {
          const paths = [...bytes.files.keys()].filter((p) =>
            p.startsWith(prefix),
          )
          const names = [
            ...new Set(paths.map((p) => p.slice(prefix.length).split('/')[0])),
          ].sort()
          if (JSON.stringify(dir.names(256)) !== JSON.stringify(names))
            throw new SkillByteError(
              'native skill registration changed; retained',
            )
          for (const n of names) {
            const path = prefix + n,
              data = bytes.files.get(path)
            if (data) {
              if (!dir.readRegular(n, data.length).equals(data))
                throw new SkillByteError(
                  'native skill registration modified; retained',
                )
            } else {
              const child = dir.directory(n)
              try {
                check(child, path + '/')
              } finally {
                child.close()
              }
            }
          }
        }
        try {
          check(slot, '')
        } catch (error) {
          if (error instanceof SkillByteError) throw error
          throw new SkillByteError(
            'native skill registration changed or unreadable; retained for recovery: ' +
              (error as Error).message,
          )
        }
        const remove = (dir: AnchoredDirectory, prefix: string) => {
          for (const n of dir.names(256)) {
            const path = prefix + n
            if (bytes.files.has(path)) dir.remove(n, false)
            else {
              const child = dir.directory(n)
              try {
                remove(child, path + '/')
              } finally {
                child.close()
              }
              dir.remove(n, true)
            }
          }
        }
        remove(slot, '')
        skills.remove(name, true)
      } finally {
        for (const d of opened.reverse()) d.close()
        material?.close()
        cache.close()
      }
    }
    return {
      selection: { ...binding.selection },
      relativeDirectory: join('.agents', 'skills', name),
      read: () => material!.read(),
      close,
    }
  } catch (e) {
    for (const d of opened.reverse()) d.close()
    material?.close()
    cache.close()
    throw e
  }
}
