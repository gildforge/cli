import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { canonicalBytes } from '../api/agent-profile-canonical'
import {
  skillManifestIdentity,
  type SkillManifest,
} from '../api/agent-profile-contract'
import { AnchoredDirectory } from '../isolation/anchored-fs'
import { readSkillInventory } from './bundle-inventory'
import { SkillBundleCache } from './bundle-cache'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true })),
)
async function fixture() {
  mkdirSync('.tmp', { recursive: true })
  const root = mkdtempSync(resolve('.tmp/physical-bundle-'))
  roots.push(root)
  const source = join(root, 'source'),
    cacheRoot = join(root, 'cache')
  mkdirSync(source)
  mkdirSync(cacheRoot, { mode: 0o700 })
  const manifest = JSON.parse(
    readFileSync(
      'scripts/fixtures/skills/ecc-verification-loop.manifest.json',
      'utf8',
    ),
  ) as SkillManifest
  for (const name of ['SKILL.md', 'LICENSE'])
    writeFileSync(
      join(source, name),
      readFileSync(join('scripts/fixtures/skills/ecc-verification-loop', name)),
    )
  const pin = await skillManifestIdentity(manifest)
  const selection = {
    pinId: pin.pinId,
    bundleDigest: pin.bundleDigest,
    entryDigest: pin.entryDigest,
  }
  const specs = manifest.files.map((file) => ({
    path: file.path,
    size: file.bytes,
    sha256: file.sha256,
  }))
  return {
    root,
    source,
    cacheRoot,
    manifest,
    selection,
    specs,
    address: join(cacheRoot, 'sha256', pin.bundleDigest),
  }
}
async function child(cacheRoot: string, source: string, mode: string) {
  const process = Bun.spawn(
    [
      globalThis.process.execPath,
      'run',
      resolve('scripts/fixtures/skill-bundle-publish.ts'),
      cacheRoot,
      source,
      mode,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(() => process.kill('SIGKILL'), 8000)
  try {
    const [exit, out, err] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    return { exit, out, err }
  } finally {
    clearTimeout(timer)
  }
}

test('complete physical inventory retains every nested asset and license', async () => {
  const f = await fixture(),
    data = Buffer.from('nested reference')
  mkdirSync(join(f.source, 'assets'))
  writeFileSync(join(f.source, 'assets', 'notes.txt'), data)
  f.specs.push({
    path: 'assets/notes.txt',
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  })
  const files = readSkillInventory(f.source, f.specs)
  expect([...files.keys()].sort()).toEqual([
    'LICENSE',
    'SKILL.md',
    'assets/notes.txt',
  ])
  expect(files.get('assets/notes.txt')).toEqual(data)
  expect(files.get('LICENSE')).toEqual(readFileSync(join(f.source, 'LICENSE')))
  const root = AnchoredDirectory.open(f.source)
  try {
    expect(root.names(4)).toEqual(root.names(4))
  } finally {
    root.close()
  }
})

test('undeclared files directories and special entries fail complete inventory without reads', async () => {
  const f = await fixture()
  writeFileSync(join(f.source, 'extra.txt'), 'extra')
  expect(() => readSkillInventory(f.source, f.specs)).toThrow('inventory')
  rmSync(join(f.source, 'extra.txt'))
  mkdirSync(join(f.source, 'extra'))
  expect(() => readSkillInventory(f.source, f.specs)).toThrow('inventory')
  rmSync(join(f.source, 'extra'), { recursive: true })
  expect(spawnSync('mkfifo', [join(f.source, 'fifo')]).status).toBe(0)
  expect(() => readSkillInventory(f.source, f.specs)).toThrow('inventory')
})

test('physical inventory rejects missing and corrupt license before cache writes', async () => {
  const f = await fixture(),
    cache = new SkillBundleCache(f.cacheRoot)
  try {
    rmSync(join(f.source, 'LICENSE'))
    await expect(
      cache.store(f.selection, f.manifest, f.source),
    ).rejects.toThrow('inventory')
    writeFileSync(join(f.source, 'LICENSE'), Buffer.alloc(f.specs[0].size))
    await expect(
      cache.store(f.selection, f.manifest, f.source),
    ).rejects.toThrow('digest mismatch')
    expect(readdirSync(f.cacheRoot)).toEqual([])
  } finally {
    cache.close()
  }
})

test('inventory refuses escaping root leaf and directory symlinks and hard links', async () => {
  const f = await fixture(),
    outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(
    join(outside, 'SKILL.md'),
    readFileSync(join(f.source, 'SKILL.md')),
  )
  const link = join(f.root, 'source-link')
  symlinkSync(f.source, link)
  expect(() => readSkillInventory(link, f.specs)).toThrow()
  rmSync(join(f.source, 'SKILL.md'))
  symlinkSync(join(outside, 'SKILL.md'), join(f.source, 'SKILL.md'))
  expect(() => readSkillInventory(f.source, f.specs)).toThrow('regular file')
  rmSync(join(f.source, 'SKILL.md'))
  linkSync(join(outside, 'SKILL.md'), join(f.source, 'SKILL.md'))
  expect(() => readSkillInventory(f.source, f.specs)).toThrow('link count')
  rmSync(join(f.source, 'SKILL.md'))
  writeFileSync(
    join(f.source, 'SKILL.md'),
    readFileSync(join(outside, 'SKILL.md')),
  )
  symlinkSync(outside, join(f.source, 'assets'))
  const data = readFileSync(join(outside, 'SKILL.md'))
  expect(() =>
    readSkillInventory(f.source, [
      ...f.specs,
      {
        path: 'assets/SKILL.md',
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      },
    ]),
  ).toThrow()
  expect(readFileSync(join(outside, 'SKILL.md'))).toEqual(data)
})

test('case and normalized physical aliases never satisfy the declared manifest', async () => {
  const f = await fixture()
  renameSync(join(f.source, 'SKILL.md'), join(f.source, 'skill.md'))
  expect(() => readSkillInventory(f.source, f.specs)).toThrow('inventory')
  renameSync(join(f.source, 'skill.md'), join(f.source, 'SKILL.md'))
  writeFileSync(join(f.source, 'e\u0301.txt'), 'extra')
  expect(() => readSkillInventory(f.source, f.specs)).toThrow(
    'unsafe skill path',
  )
  const hash = 'a'.repeat(64)
  expect(() =>
    readSkillInventory(f.source, [
      { path: 'A/x', size: 1, sha256: hash },
      { path: 'a/y', size: 1, sha256: hash },
    ]),
  ).toThrow('collision')
})

test('bundle publication uses canonical address bytes and exact private layout', async () => {
  const f = await fixture(),
    cache = new SkillBundleCache(f.cacheRoot)
  try {
    const stored = await cache.store(f.selection, f.manifest, f.source)
    expect(readdirSync(join(f.cacheRoot, 'sha256'))).toEqual([
      f.selection.bundleDigest,
    ])
    expect(readdirSync(f.address).sort()).toEqual(['files', 'manifest.json'])
    expect(readFileSync(join(f.address, 'manifest.json'))).toEqual(
      Buffer.from(canonicalBytes(f.manifest)),
    )
    expect(readFileSync(join(f.address, 'files', 'LICENSE'))).toEqual(
      Buffer.from(stored.files.get('LICENSE')!),
    )
    expect(statSync(f.address).mode & 0o777).toBe(0o700)
    expect(statSync(join(f.address, 'files', 'SKILL.md')).mode & 0o777).toBe(
      0o600,
    )
    stored.files.get('SKILL.md')!.fill(0)
    rmSync(f.source, { recursive: true })
    expect(
      (await cache.read(f.selection, f.manifest)).files.get('SKILL.md'),
    ).toEqual(
      readFileSync('scripts/fixtures/skills/ecc-verification-loop/SKILL.md'),
    )
    await expect(
      cache.read({ ...f.selection, entryDigest: 'a'.repeat(64) }, f.manifest),
    ).rejects.toThrow('immutable manifest')
  } finally {
    cache.close()
  }
})

test('nested manifest assets are preserved and verified in the published bundle', async () => {
  const f = await fixture(),
    bytes = Buffer.from('asset bytes')
  mkdirSync(join(f.source, 'assets'))
  writeFileSync(join(f.source, 'assets', 'data.txt'), bytes)
  f.manifest.assets = ['assets/data.txt']
  f.manifest.files.push({
    path: 'assets/data.txt',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
  f.manifest.files.sort((a, b) => (a.path < b.path ? -1 : 1))
  const pin = await skillManifestIdentity(f.manifest),
    selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
  const cache = new SkillBundleCache(f.cacheRoot)
  try {
    expect(
      (await cache.store(selection, f.manifest, f.source)).files.get(
        'assets/data.txt',
      ),
    ).toEqual(bytes)
    const path = join(
      f.cacheRoot,
      'sha256',
      pin.bundleDigest,
      'files',
      'assets',
      'data.txt',
    )
    writeFileSync(path, Buffer.alloc(bytes.length))
    await expect(cache.read(selection, f.manifest)).rejects.toThrow(
      'digest mismatch',
    )
  } finally {
    cache.close()
  }
})

test('existing incomplete corrupt or extra cache entries are rejected without repair or staging', async () => {
  const f = await fixture(),
    cache = new SkillBundleCache(f.cacheRoot)
  try {
    await cache.store(f.selection, f.manifest, f.source)
    const license = join(f.address, 'files', 'LICENSE'),
      bytes = readFileSync(license)
    rmSync(license)
    await expect(
      cache.store(f.selection, f.manifest, f.source),
    ).rejects.toThrow('inventory')
    writeFileSync(license, bytes)
    writeFileSync(join(f.address, 'extra'), 'extra')
    await expect(cache.read(f.selection, f.manifest)).rejects.toThrow(
      'metadata inventory',
    )
    await expect(
      cache.store(f.selection, f.manifest, f.source),
    ).rejects.toThrow('metadata inventory')
    rmSync(join(f.address, 'extra'))
    writeFileSync(
      join(f.address, 'manifest.json'),
      Buffer.concat([
        Buffer.from(canonicalBytes(f.manifest)),
        Buffer.from('\n'),
      ]),
    )
    await expect(
      cache.store(f.selection, f.manifest, f.source),
    ).rejects.toThrow('canonical manifest differs')
    expect(readdirSync(join(f.cacheRoot, 'sha256'))).toEqual([
      f.selection.bundleDigest,
    ])
  } finally {
    cache.close()
  }
})

test('cache namespace bundle and files symlinks cannot escape opened private root', async () => {
  const f = await fixture(),
    outside = join(f.root, 'outside')
  mkdirSync(outside, { mode: 0o700 })
  symlinkSync(outside, join(f.cacheRoot, 'sha256'))
  const cache = new SkillBundleCache(f.cacheRoot)
  try {
    await expect(
      cache.store(f.selection, f.manifest, f.source),
    ).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
    rmSync(join(f.cacheRoot, 'sha256'))
    mkdirSync(join(f.cacheRoot, 'sha256'), { mode: 0o700 })
    symlinkSync(outside, f.address)
    await expect(
      cache.store(f.selection, f.manifest, f.source),
    ).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
    rmSync(f.address)
    await cache.store(f.selection, f.manifest, f.source)
    rmSync(join(f.address, 'files'), { recursive: true })
    symlinkSync(outside, join(f.address, 'files'))
    await expect(cache.read(f.selection, f.manifest)).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
  } finally {
    cache.close()
  }
})

test('private cache mode checks and root replacement fail closed without redirected writes', async () => {
  const f = await fixture()
  chmodSync(f.cacheRoot, 0o755)
  expect(() => new SkillBundleCache(f.cacheRoot)).toThrow('private and owned')
  chmodSync(f.cacheRoot, 0o700)
  const cache = new SkillBundleCache(f.cacheRoot),
    old = join(f.root, 'old-cache'),
    outside = join(f.root, 'outside')
  mkdirSync(outside, { mode: 0o700 })
  renameSync(f.cacheRoot, old)
  symlinkSync(outside, f.cacheRoot)
  try {
    await cache.store(f.selection, f.manifest, f.source)
    expect(readdirSync(outside)).toEqual([])
    expect(readdirSync(join(old, 'sha256'))).toEqual([f.selection.bundleDigest])
    chmodSync(join(old, 'sha256', f.selection.bundleDigest, 'files'), 0o755)
    await expect(cache.read(f.selection, f.manifest)).rejects.toThrow(
      'private and owned',
    )
  } finally {
    cache.close()
  }
})

test('atomic directory publication never replaces an existing destination', async () => {
  const f = await fixture(),
    directory = AnchoredDirectory.open(f.cacheRoot)
  const first = directory.privateDirectory('first'),
    second = directory.privateDirectory('second')
  try {
    first.putRegularIfAbsent('marker', Buffer.from('first'))
    second.putRegularIfAbsent('marker', Buffer.from('second'))
    expect(directory.publishDirectory('first', 'object')).toBe(true)
    expect(readFileSync(join(f.cacheRoot, 'object', 'marker')).toString()).toBe(
      'first',
    )
    rmSync(join(f.cacheRoot, 'object', 'marker'))
    expect(directory.publishDirectory('second', 'object')).toBe(false)
    expect(readdirSync(join(f.cacheRoot, 'object'))).toEqual([])
    expect(readFileSync(join(f.cacheRoot, 'second', 'marker')).toString()).toBe(
      'second',
    )
  } finally {
    first.close()
    second.close()
    directory.close()
  }
})

test('interruption before directory publication leaves no usable digest and safe retry', async () => {
  const f = await fixture()
  const result = await child(f.cacheRoot, f.source, 'before')
  expect(result).toEqual({ exit: 137, out: '', err: '' })
  const cache = new SkillBundleCache(f.cacheRoot)
  try {
    const names = readdirSync(join(f.cacheRoot, 'sha256'))
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^\.gild-bundle-[a-f0-9]{24}$/)
    await expect(cache.read(f.selection, f.manifest)).rejects.toThrow('errno 2')
    expect(
      (await cache.store(f.selection, f.manifest, f.source)).files.size,
    ).toBe(2)
    expect(readdirSync(join(f.cacheRoot, 'sha256'))).toContain(names[0])
  } finally {
    cache.close()
  }
}, 15000)

test('staged bytes are reverified before a corrupt bundle can be published', async () => {
  const f = await fixture(),
    result = await child(f.cacheRoot, f.source, 'corrupt')
  expect(result.exit).toBe(1)
  expect(result.err).toContain('skill byte digest mismatch')
  expect(readdirSync(join(f.cacheRoot, 'sha256'))).not.toContain(
    f.selection.bundleDigest,
  )
  const cache = new SkillBundleCache(f.cacheRoot)
  try {
    await expect(cache.read(f.selection, f.manifest)).rejects.toThrow('errno 2')
  } finally {
    cache.close()
  }
}, 15000)

test('interruption after native directory publication leaves a complete readable bundle', async () => {
  const f = await fixture()
  expect(await child(f.cacheRoot, f.source, 'after')).toEqual({
    exit: 137,
    out: '',
    err: '',
  })
  const cache = new SkillBundleCache(f.cacheRoot)
  try {
    expect(readdirSync(join(f.cacheRoot, 'sha256'))).toEqual([
      f.selection.bundleDigest,
    ])
    const read = await cache.read(f.selection, f.manifest)
    expect(read.files.get('LICENSE')).toEqual(
      readFileSync(join(f.source, 'LICENSE')),
    )
    expect(read.files.get('SKILL.md')).toEqual(
      readFileSync(join(f.source, 'SKILL.md')),
    )
  } finally {
    cache.close()
  }
}, 15000)

test('two owned publishers converge on the same complete bundle without overwrite', async () => {
  const f = await fixture()
  const results = await Promise.all([
    child(f.cacheRoot, f.source, 'normal'),
    child(f.cacheRoot, f.source, 'normal'),
  ])
  expect(results).toEqual([
    { exit: 0, out: f.selection.bundleDigest + '\n', err: '' },
    { exit: 0, out: f.selection.bundleDigest + '\n', err: '' },
  ])
  const cache = new SkillBundleCache(f.cacheRoot)
  try {
    expect((await cache.read(f.selection, f.manifest)).files.size).toBe(2)
  } finally {
    cache.close()
  }
}, 15000)
