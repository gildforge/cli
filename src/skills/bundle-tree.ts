// One private tree reader/writer for the cache and per-run local copies.
import { fsyncSync } from 'node:fs'
import { canonicalBytes } from '../api/agent-profile-canonical'
import { parseSkillManifest } from '../api/agent-profile-contract'
import { AnchoredDirectory } from '../isolation/anchored-fs'
import {
  prepareSelectedSkillBytes,
  type resolveSelectedSkill,
} from './selected-bytes'
import { assertPrivateSkillDirectory, SkillByteError } from './local-bytes'
import { readSkillInventoryAt } from './bundle-inventory'
export type BundleBinding = Awaited<ReturnType<typeof resolveSelectedSkill>>
const MAX_MANIFEST_BYTES = 1024 * 1024
function metadataInventory(root: AnchoredDirectory) {
  const names = root.names(3)
  if (
    names.length !== 2 ||
    names[0] !== 'files' ||
    names[1] !== 'manifest.json'
  )
    throw new SkillByteError('bundle cache metadata inventory differs')
}
export function readBundleDirectory(
  root: AnchoredDirectory,
  binding: BundleBinding,
) {
  assertPrivateSkillDirectory(root)
  metadataInventory(root)
  const raw = root.readRegular('manifest.json', MAX_MANIFEST_BYTES)
  if (!raw.equals(Buffer.from(canonicalBytes(binding.manifest))))
    throw new SkillByteError(
      'cached canonical manifest differs from locked selection',
    )
  const directory = root.directory('files')
  let files: Map<string, Buffer>
  try {
    files = readSkillInventoryAt(directory, binding.specs, true)
  } finally {
    directory.close()
  }
  metadataInventory(root)
  // Do not expose a long-lived materialization handle's internal binding.
  return {
    manifest: parseSkillManifest(binding.manifest),
    selection: { ...binding.selection },
    files,
  }
}
export function readBundleAt(
  namespace: AnchoredDirectory,
  name: string,
  binding: BundleBinding,
) {
  const root = namespace.directory(name)
  try {
    return readBundleDirectory(root, binding)
  } finally {
    root.close()
  }
}
export function writeBundleDirectory(
  root: AnchoredDirectory,
  binding: BundleBinding,
  input: ReadonlyMap<string, Uint8Array>,
  readOnlyFiles = false,
) {
  const files = prepareSelectedSkillBytes(binding.specs, input)
  assertPrivateSkillDirectory(root)
  if (
    !root.putRegularIfAbsent(
      'manifest.json',
      Buffer.from(canonicalBytes(binding.manifest)),
    )
  )
    throw new SkillByteError('unexpected staged manifest collision')
  if (readOnlyFiles) root.mode('manifest.json', 0o400, false)
  const directory = root.privateDirectory('files')
  try {
    for (const [path, bytes] of files) {
      const parent = directory.parent(path, true),
        name = path.split('/').at(-1)!
      try {
        assertPrivateSkillDirectory(parent)
        if (!parent.putRegularIfAbsent(name, bytes))
          throw new SkillByteError('unexpected staged file collision')
        if (readOnlyFiles) parent.mode(name, 0o400, false)
      } finally {
        if (parent !== directory) parent.close()
      }
    }
    fsyncSync(directory.fd)
  } finally {
    directory.close()
  }
  fsyncSync(root.fd)
}
