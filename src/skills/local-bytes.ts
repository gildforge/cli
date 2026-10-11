// Internal byte/filesystem boundary only, pending generated canonical adapters.
// These inputs are NOT a wire manifest, policy grant, or bundle/snapshot digest.
// Only declared bytes are returned; complete bundle inventory belongs to the
// agreed canonical integration. No network, metadata evaluation or skill execution.
import { createHash } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { AnchoredDirectory } from '../isolation/anchored-fs'

export type LocalSkillByteExpectation = Readonly<{
  path: string
  size: number
  sha256: string
}>
export const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024
const MAX_FILES = 128
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const digestPattern = /^[a-f0-9]{64}$/
export class SkillByteError extends Error {}

/** Conservative portable subset; future canonical validation may narrow it. */
export function validateSkillPath(path: string) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 1024 ||
    !/^[\x20-\x7e]+$/.test(path) ||
    /[\\%<>:"|?*]/.test(path) ||
    path.startsWith('/')
  )
    throw new SkillByteError('unsafe skill path')
  for (const part of path.split('/')) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
      throw new SkillByteError('unsafe skill path component')
  }
  return path
}
function validateExpected(spec: LocalSkillByteExpectation) {
  if (
    typeof spec.sha256 !== 'string' ||
    spec.sha256.length !== 64 ||
    !digestPattern.test(spec.sha256) ||
    !Number.isSafeInteger(spec.size) ||
    spec.size < 0 ||
    spec.size > MAX_SKILL_FILE_BYTES
  )
    throw new SkillByteError('invalid skill byte expectation')
}
export function validateSkillFiles(
  files: readonly LocalSkillByteExpectation[],
) {
  if (!files.length || files.length > MAX_FILES)
    throw new SkillByteError('invalid skill file count')
  const names = new Map<string, { path: string; directory: boolean }>()
  let total = 0
  for (const file of files) {
    validateExpected(file)
    validateSkillPath(file.path)
    total += file.size
    if (total > MAX_TOTAL_BYTES)
      throw new SkillByteError('skill bytes exceed local bound')
    const parts = file.path.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/'),
        key = path.toLowerCase(),
        directory = i < parts.length
      const old = names.get(key)
      if (
        old &&
        (old.path !== path || old.directory !== directory || !directory)
      )
        throw new SkillByteError('skill path collision')
      names.set(key, { path, directory })
    }
  }
  return files.map((file) => Object.freeze({ ...file }))
}
export function verifySkillBytes(
  spec: LocalSkillByteExpectation,
  input: Uint8Array,
) {
  validateExpected(spec)
  // Copy before hashing/writing so callers cannot mutate a validated buffer later.
  if (input.byteLength !== spec.size)
    throw new SkillByteError('skill byte size mismatch')
  const bytes = Buffer.from(input)
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256)
    throw new SkillByteError('skill byte digest mismatch')
  return bytes
}
function openRoot(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0'))
    throw new SkillByteError('skill root must be a normalized absolute path')
  let at = AnchoredDirectory.open('/')
  try {
    // Every ancestor is opened relative to its predecessor without following links.
    for (const part of path.split('/').filter(Boolean)) {
      const next = at.directory(part)
      at.close()
      at = next
    }
    return at
  } catch (error) {
    at.close()
    throw error
  }
}
function readAt(root: AnchoredDirectory, spec: LocalSkillByteExpectation) {
  let parent: AnchoredDirectory | undefined
  try {
    parent = root.parent(spec.path)
    return verifySkillBytes(
      spec,
      parent.readRegular(spec.path.split('/').at(-1)!, spec.size),
    )
  } finally {
    if (parent && parent !== root) parent.close()
  }
}
/** Descriptor-anchored, bounded reads of declared regular files only. */
export function readPinnedSkillFiles(
  path: string,
  files: readonly LocalSkillByteExpectation[],
) {
  const specs = validateSkillFiles(files),
    root = openRoot(path)
  try {
    return new Map(specs.map((spec) => [spec.path, readAt(root, spec)]))
  } finally {
    root.close()
  }
}
/** Local byte-object store; NOT canonical bundle-cache addressing/serialization. */
export class SkillByteCache {
  private readonly root: AnchoredDirectory
  constructor(path: string) {
    const root = openRoot(path),
      info = fstatSync(root.fd)
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      root.close()
      throw new SkillByteError('skill byte cache must be private and owned')
    }
    this.root = root
  }
  close() {
    this.root.close()
  }
  read(spec: LocalSkillByteExpectation) {
    validateExpected(spec)
    // Hash-only leaf names: caller paths never select storage locations.
    return verifySkillBytes(spec, this.root.readRegular(spec.sha256, spec.size))
  }
  store(spec: LocalSkillByteExpectation, input: Uint8Array) {
    const bytes = verifySkillBytes(spec, input)
    // An existing corrupt/unsafe object is an error, never silently repaired.
    try {
      return this.read(spec)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.root.putRegularIfAbsent(spec.sha256, bytes)
    return this.read(spec)
  }
}
