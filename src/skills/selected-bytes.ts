// Preparatory byte-cache reads only. This grants no execution or delivery authority
// and does not implement the canonical on-disk bundle layout or live API routes.
import {
  skillManifestIdentity,
  verifySkillSelection,
} from '../api/agent-profile-contract'
import {
  SkillByteCache,
  SkillByteError,
  validateSkillFiles,
  verifySkillBytes,
  type LocalSkillByteExpectation,
} from './local-bytes'

export async function resolveSelectedSkill(selection: unknown, value: unknown) {
  const identity = await skillManifestIdentity(value)
  const pin = await verifySkillSelection(selection, identity.manifest)
  const specs = validateSkillFiles(
    identity.manifest.files.map((file) => ({
      path: file.path,
      size: file.bytes,
      sha256: file.sha256,
    })),
  )
  return { ...identity, selection: pin, specs }
}

/** Recheck full immutable selection and every declared byte on offline reuse. */
export async function readSelectedSkillBytes(
  cache: SkillByteCache,
  selection: unknown,
  manifest: unknown,
) {
  const binding = await resolveSelectedSkill(selection, manifest)
  const files = new Map(
    binding.specs.map((spec) => [spec.path, cache.read(spec)]),
  )
  return { manifest: binding.manifest, selection: binding.selection, files }
}

/** Complete copied-byte preflight shared by cache writes and materialization. */
export function prepareSelectedSkillBytes(
  specs: readonly LocalSkillByteExpectation[],
  input: ReadonlyMap<string, Uint8Array>,
) {
  const provided = new Map(input)
  if (
    provided.size !== specs.length ||
    [...provided.keys()].some(
      (path) => !specs.some((spec) => spec.path === path),
    )
  )
    throw new SkillByteError('skill byte set must exactly match manifest')
  return new Map(
    specs.map((spec) => {
      const bytes = provided.get(spec.path)
      if (!bytes) throw new SkillByteError('declared skill bytes are missing')
      return [spec.path, verifySkillBytes(spec, bytes)] as const
    }),
  )
}
/** Verify the complete supplied byte set before writing any cache object. */
export async function cacheSelectedSkillBytes(
  cache: SkillByteCache,
  selection: unknown,
  manifest: unknown,
  input: ReadonlyMap<string, Uint8Array>,
) {
  const binding = await resolveSelectedSkill(selection, manifest)
  const verified = prepareSelectedSkillBytes(binding.specs, input)
  for (const spec of binding.specs) cache.store(spec, verified.get(spec.path)!)
  return readSelectedSkillBytes(cache, binding.selection, binding.manifest)
}
