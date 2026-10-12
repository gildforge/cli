// Private CLI disk layout only, not a shared VM/container protocol. Verified
// content is preparation, never a policy grant or permission to deliver/run.
import { randomBytes } from 'node:crypto'
import { fsyncSync } from 'node:fs'
import { canonicalBytes } from '../api/agent-profile-canonical'
import { AnchoredDirectory } from '../isolation/anchored-fs'
import { resolveSelectedSkill } from './selected-bytes'
import {
  assertPrivateSkillDirectory,
  openSkillRoot,
  SkillByteError,
} from './local-bytes'
import { readSkillInventory, readSkillInventoryAt } from './bundle-inventory'

type Binding = Awaited<ReturnType<typeof resolveSelectedSkill>>
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
function readBundleAt(
  namespace: AnchoredDirectory,
  name: string,
  binding: Binding,
) {
  const bundle = namespace.directory(name)
  try {
    assertPrivateSkillDirectory(bundle)
    metadataInventory(bundle)
    const raw = bundle.readRegular('manifest.json', MAX_MANIFEST_BYTES)
    // Exact generated canonical bytes exclude duplicate keys, alternate encodings,
    // trailing whitespace and substituted manifest metadata before any file read.
    if (!raw.equals(Buffer.from(canonicalBytes(binding.manifest))))
      throw new SkillByteError(
        'cached canonical manifest differs from locked selection',
      )
    const directory = bundle.directory('files')
    let files: Map<string, Buffer>
    try {
      files = readSkillInventoryAt(directory, binding.specs, true)
    } finally {
      directory.close()
    }
    metadataInventory(bundle)
    return { manifest: binding.manifest, selection: binding.selection, files }
  } finally {
    bundle.close()
  }
}
function writeFiles(
  root: AnchoredDirectory,
  files: ReadonlyMap<string, Buffer>,
) {
  for (const [path, bytes] of files) {
    const parent = root.parent(path, true)
    try {
      assertPrivateSkillDirectory(parent)
      if (!parent.putRegularIfAbsent(path.split('/').at(-1)!, bytes))
        throw new SkillByteError('unexpected staged file collision')
    } finally {
      if (parent !== root) parent.close()
    }
  }
  fsyncSync(root.fd)
}
export class SkillBundleCache {
  private readonly root: AnchoredDirectory
  constructor(path: string) {
    const root = openSkillRoot(path)
    try {
      assertPrivateSkillDirectory(root)
      this.root = root
    } catch (error) {
      root.close()
      throw error
    }
  }
  close() {
    this.root.close()
  }
  private namespace(create: boolean) {
    const at = this.root.directory('sha256', create)
    try {
      assertPrivateSkillDirectory(at)
      return at
    } catch (error) {
      at.close()
      throw error
    }
  }
  /** Offline locked content: exact selection/manifest required, no network fallback. */
  async read(selection: unknown, manifest: unknown) {
    const binding = await resolveSelectedSkill(selection, manifest)
    const namespace = this.namespace(false)
    try {
      return readBundleAt(namespace, binding.bundleDigest, binding)
    } finally {
      namespace.close()
    }
  }
  /** Inventory and copy the entire source before staging; publish as one object. */
  async store(selection: unknown, manifest: unknown, source: string) {
    const binding = await resolveSelectedSkill(selection, manifest)
    const files = readSkillInventory(source, binding.specs)
    const namespace = this.namespace(true)
    try {
      if (namespace.hasEntry(binding.bundleDigest))
        return readBundleAt(namespace, binding.bundleDigest, binding)
      const name = '.gild-bundle-' + randomBytes(12).toString('hex')
      const stage = namespace.privateDirectory(name)
      try {
        if (
          !stage.putRegularIfAbsent(
            'manifest.json',
            Buffer.from(canonicalBytes(binding.manifest)),
          )
        )
          throw new SkillByteError('unexpected staged manifest collision')
        const directory = stage.privateDirectory('files')
        try {
          writeFiles(directory, files)
        } finally {
          directory.close()
        }
        fsyncSync(stage.fd)
      } finally {
        stage.close()
      }
      // Recheck exactly what will be published, not just the earlier source map.
      readBundleAt(namespace, name, binding)
      namespace.publishDirectory(name, binding.bundleDigest)
      // A competing complete object is reverified, never overwritten/repaired.
      // An unpublished private stage is retained; its name never authorizes use.
      return readBundleAt(namespace, binding.bundleDigest, binding)
    } finally {
      namespace.close()
    }
  }
}
