// Private CLI disk layout only, not a shared VM/container protocol. Verified
// content is preparation, never a policy grant or permission to deliver/run.
import { randomBytes } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { AnchoredDirectory } from '../isolation/anchored-fs'
import { resolveSelectedSkill } from './selected-bytes'
import {
  assertPrivateSkillDirectory,
  openSkillRoot,
  SkillByteError,
} from './local-bytes'
import { readSkillInventory } from './bundle-inventory'
import { readBundleAt, writeBundleDirectory } from './bundle-tree'

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
  /** A run destination cannot be this cache or anywhere inside it. Compare
   * opened filesystem identities, not path prefixes or followed symlinks. */
  assertSeparateDirectory(directory: AnchoredDirectory) {
    const cache = fstatSync(this.root.fd, { bigint: true })
    let at = directory.directory('.')
    try {
      for (let depth = 0; depth < 1024; depth++) {
        const current = fstatSync(at.fd, { bigint: true })
        if (current.dev === cache.dev && current.ino === cache.ino)
          throw new SkillByteError('materialization destination overlaps cache')
        const parent = at.directory('..')
        let info: import('node:fs').BigIntStats
        try {
          info = fstatSync(parent.fd, { bigint: true })
        } catch (error) {
          parent.close()
          throw error
        }
        at.close()
        at = parent
        if (info.dev === current.dev && info.ino === current.ino) return
      }
      throw new SkillByteError('materialization ancestry exceeds local bound')
    } finally {
      at.close()
    }
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
        writeBundleDirectory(stage, binding, files)
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
