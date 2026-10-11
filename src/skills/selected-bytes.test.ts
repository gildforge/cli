import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalBytes, canonicalDigest } from '../api/agent-profile-canonical'
import {
  skillManifestIdentity,
  type SkillManifest,
} from '../api/agent-profile-contract'
import { SkillByteCache } from './local-bytes'
import {
  cacheSelectedSkillBytes,
  readSelectedSkillBytes,
} from './selected-bytes'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true })),
)
function fixture() {
  mkdirSync('.tmp', { recursive: true })
  const root = mkdtempSync(resolve('.tmp/selected-skill-'))
  roots.push(root)
  const cache = new SkillByteCache(root)
  const manifest = JSON.parse(
    readFileSync(
      'scripts/fixtures/skills/ecc-verification-loop.manifest.json',
      'utf8',
    ),
  ) as SkillManifest
  const files = new Map(
    ['LICENSE', 'SKILL.md'].map((path) => [
      path,
      readFileSync(join('scripts/fixtures/skills/ecc-verification-loop', path)),
    ]),
  )
  return { root, cache, manifest, files }
}
const expectedBundle =
  '8642aec70aefee472151de8b27fc97a08ff9bb85bf927fb69afc53a4ae499d6c'

test('canonical selection still rejects locally unsupported portable paths before writes', async () => {
  const { root, cache, manifest, files } = fixture()
  try {
    const data = Buffer.from('asset')
    manifest.assets = ['CON.txt']
    manifest.files.push({
      path: 'CON.txt',
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    })
    manifest.files.sort((a, b) => (a.path < b.path ? -1 : 1))
    files.set('CON.txt', data)
    const pin = await skillManifestIdentity(manifest)
    const selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
    await expect(
      cacheSelectedSkillBytes(cache, selection, manifest, files),
    ).rejects.toThrow('unsafe skill path')
    expect(readdirSync(root)).toEqual([])
  } finally {
    cache.close()
  }
})

test('generated canonical helper reproduces agreed UTF8 and complete bundle vectors', async () => {
  expect(Buffer.from(canonicalBytes({ b: null, a: 1 })).toString()).toBe(
    '{"a":1,"b":null}',
  )
  expect(await canonicalDigest({ b: null, a: 1 })).toBe(
    '46e0ff59f6164548317489fbea1133a48f7a83c325c3535e44559c9619afb76b',
  )
  expect(canonicalBytes({ text: 'é' }).length).toBe(13)
  expect(await canonicalDigest({ text: 'é' })).toBe(
    '42d3cbf59fdccced04e5dff14433fb52d34d58e385e9770ffd896ff517d63b92',
  )
  const { cache, manifest } = fixture()
  try {
    const identity = await skillManifestIdentity(manifest)
    expect(canonicalBytes(identity.manifest).length).toBe(1069)
    expect(identity.bundleDigest).toBe(expectedBundle)
    expect(identity.pinId).toBe(`ecc.verification-loop@${expectedBundle}`)
    expect(identity.entryDigest).toBe(
      '5b06be54d4852f60e6cf1b04c6e9a4748554334eb3e41af6c0959b544e6464ae',
    )
  } finally {
    cache.close()
  }
})

test('immutable cache selection preserves license and bytes on offline reuse', async () => {
  const { cache, manifest, files } = fixture()
  try {
    const pin = await skillManifestIdentity(manifest)
    const selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
    const stored = await cacheSelectedSkillBytes(
      cache,
      selection,
      manifest,
      files,
    )
    expect(stored.files).toEqual(files)
    stored.files.get('SKILL.md')!.fill(0)
    const read = await readSelectedSkillBytes(cache, selection, manifest)
    expect(read.files).toEqual(files)
    expect(read.manifest.license.originalPath).toBe('pi/core/LICENSE')
  } finally {
    cache.close()
  }
})

test('stale bundle or entry selections fail before cache writes', async () => {
  const { root, cache, manifest, files } = fixture()
  try {
    const pin = await skillManifestIdentity(manifest)
    const selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
    await expect(
      cacheSelectedSkillBytes(
        cache,
        { ...selection, entryDigest: 'a'.repeat(64) },
        manifest,
        files,
      ),
    ).rejects.toThrow('immutable manifest')
    await expect(
      cacheSelectedSkillBytes(
        cache,
        selection,
        {
          ...manifest,
          metadata: { ...manifest.metadata, description: 'changed' },
        },
        files,
      ),
    ).rejects.toThrow('immutable manifest')
    expect(readdirSync(root)).toEqual([])
  } finally {
    cache.close()
  }
})

test('undeclared or missing supplied bytes are rejected before any cache write', async () => {
  const { root, cache, manifest, files } = fixture()
  try {
    const pin = await skillManifestIdentity(manifest)
    const selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
    const extra = new Map(files).set('undeclared.sh', Buffer.from('extra'))
    await expect(
      cacheSelectedSkillBytes(cache, selection, manifest, extra),
    ).rejects.toThrow('exactly match')
    const missing = new Map(files)
    missing.delete('LICENSE')
    await expect(
      cacheSelectedSkillBytes(cache, selection, manifest, missing),
    ).rejects.toThrow('exactly match')
    expect(readdirSync(root)).toEqual([])
  } finally {
    cache.close()
  }
})

test('all supplied bytes are verified before a valid first file can be published', async () => {
  const { root, cache, manifest, files } = fixture()
  try {
    const pin = await skillManifestIdentity(manifest)
    const selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
    files.get('SKILL.md')![0] ^= 1
    await expect(
      cacheSelectedSkillBytes(cache, selection, manifest, files),
    ).rejects.toThrow('digest mismatch')
    expect(readdirSync(root)).toEqual([])
  } finally {
    cache.close()
  }
})

test('offline cache corruption and misses fail without repairing or substituting content', async () => {
  const { root, cache, manifest, files } = fixture()
  try {
    const pin = await skillManifestIdentity(manifest)
    const selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
    await expect(
      readSelectedSkillBytes(cache, selection, manifest),
    ).rejects.toThrow('missing')
    await cacheSelectedSkillBytes(cache, selection, manifest, files)
    const corrupt = Buffer.from(files.get('LICENSE')!)
    corrupt[0] ^= 1
    const path = join(root, manifest.license.sha256)
    writeFileSync(path, corrupt)
    await expect(
      readSelectedSkillBytes(cache, selection, manifest),
    ).rejects.toThrow('digest mismatch')
    await expect(
      cacheSelectedSkillBytes(cache, selection, manifest, files),
    ).rejects.toThrow('digest mismatch')
    expect(readFileSync(path)).toEqual(corrupt)
  } finally {
    cache.close()
  }
})

test('asset content participates in full selection and byte verification', async () => {
  const { cache, manifest, files } = fixture()
  try {
    const asset = Buffer.from('reference data')
    manifest.assets = ['reference.txt']
    manifest.files.push({
      path: 'reference.txt',
      bytes: asset.length,
      sha256: createHash('sha256').update(asset).digest('hex'),
    })
    manifest.files.sort((a, b) => (a.path < b.path ? -1 : 1))
    files.set('reference.txt', asset)
    const pin = await skillManifestIdentity(manifest)
    const selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
    expect(pin.bundleDigest).not.toBe(expectedBundle)
    const read = await cacheSelectedSkillBytes(
      cache,
      selection,
      manifest,
      files,
    )
    expect(read.files.get('reference.txt')).toEqual(asset)
    files.get('reference.txt')![0] ^= 1
    await expect(
      cacheSelectedSkillBytes(cache, selection, manifest, files),
    ).rejects.toThrow('digest mismatch')
  } finally {
    cache.close()
  }
})

test('authority-shaped unknown fields and accessors fail without evaluation', async () => {
  const { root, cache, manifest, files } = fixture()
  try {
    const pin = await skillManifestIdentity(manifest)
    const selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
    await expect(
      cacheSelectedSkillBytes(
        cache,
        { ...selection, token: 'forbidden' },
        manifest,
        files,
      ),
    ).rejects.toThrow()
    await expect(
      cacheSelectedSkillBytes(
        cache,
        selection,
        { ...manifest, credential: 'forbidden' },
        files,
      ),
    ).rejects.toThrow()
    let calls = 0
    const accessor = { ...manifest }
    Object.defineProperty(accessor, 'skillId', {
      enumerable: true,
      get() {
        calls++
        return 'evil'
      },
    })
    await expect(
      cacheSelectedSkillBytes(cache, selection, accessor, files),
    ).rejects.toThrow('accessors')
    expect(calls).toBe(0)
    expect(readdirSync(root)).toEqual([])
  } finally {
    cache.close()
  }
})
