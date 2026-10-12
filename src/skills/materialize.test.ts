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
import {
  skillManifestIdentity,
  type SkillManifest,
} from '../api/agent-profile-contract'
import { canonicalBytes } from '../api/agent-profile-canonical'
import { AnchoredDirectory } from '../isolation/anchored-fs'
import { SkillBundleCache } from './bundle-cache'
import { materializeSkillBundle } from './materialize'
import { readSkillInventory } from './bundle-inventory'

const roots: string[] = []
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)
async function fixture(asset = false) {
  mkdirSync('.tmp', { recursive: true })
  const root = mkdtempSync(resolve('.tmp/materialize-'))
  roots.push(root)
  const source = join(root, 'source'),
    cacheRoot = join(root, 'cache'),
    run = join(root, 'run')
  mkdirSync(source)
  mkdirSync(cacheRoot, { mode: 0o700 })
  mkdirSync(run, { mode: 0o700 })
  const manifest = JSON.parse(
    readFileSync(
      'scripts/fixtures/skills/ecc-verification-loop.manifest.json',
      'utf8',
    ),
  ) as SkillManifest
  for (const name of ['LICENSE', 'SKILL.md'])
    writeFileSync(
      join(source, name),
      readFileSync(join('scripts/fixtures/skills/ecc-verification-loop', name)),
    )
  if (asset) {
    const bytes = Buffer.from('nested asset bytes')
    mkdirSync(join(source, 'assets'))
    writeFileSync(join(source, 'assets', 'data.txt'), bytes)
    manifest.assets = ['assets/data.txt']
    manifest.files.push({
      path: 'assets/data.txt',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    manifest.files.sort((a, b) => (a.path < b.path ? -1 : 1))
  }
  const pin = await skillManifestIdentity(manifest),
    selection = {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    }
  const cache = new SkillBundleCache(cacheRoot)
  await cache.store(selection, manifest, source)
  return {
    root,
    source,
    run,
    cacheRoot,
    cache,
    manifest,
    selection,
    address: join(cacheRoot, 'sha256', pin.bundleDigest),
    selected: join(run, 'selected-skill'),
  }
}
async function child(cache: string, run: string, mode: string) {
  const proc = Bun.spawn(
    [
      process.execPath,
      'run',
      resolve('scripts/fixtures/skill-materialize.ts'),
      cache,
      run,
      mode,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(() => proc.kill('SIGKILL'), 5000)
  try {
    const [exit, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exit, out, err }
  } finally {
    clearTimeout(timer)
  }
}

test('private materialization retains canonical bytes license and nested assets', async () => {
  const f = await fixture(true)
  let handle: Awaited<ReturnType<typeof materializeSkillBundle>> | undefined
  try {
    handle = await materializeSkillBundle(
      f.cache,
      f.selection,
      f.manifest,
      f.run,
    )
    const read = handle.read()
    expect(read.selection).toEqual(f.selection)
    expect(readdirSync(f.selected).sort()).toEqual(['files', 'manifest.json'])
    expect(readFileSync(join(f.selected, 'manifest.json'))).toEqual(
      Buffer.from(canonicalBytes(f.manifest)),
    )
    for (const file of f.manifest.files) {
      const path = join(f.selected, 'files', file.path)
      expect(readFileSync(path)).toEqual(
        readFileSync(join(f.source, file.path)),
      )
      expect(statSync(path).mode & 0o777).toBe(0o400)
      expect(statSync(path).nlink).toBe(1)
    }
    expect(statSync(f.selected).mode & 0o777).toBe(0o700)
    expect(Object.keys(handle).sort()).toEqual(['close', 'read'])
    read.files.get('SKILL.md')!.fill(0)
    read.manifest.metadata.description = 'caller mutation'
    read.selection.entryDigest = 'a'.repeat(64)
    expect(handle.read().files.get('SKILL.md')).toEqual(
      readFileSync(join(f.source, 'SKILL.md')),
    )
    expect(handle.read().manifest.metadata.description).toBe(
      f.manifest.metadata.description,
    )
    expect(handle.read().selection).toEqual(f.selection)
    handle.close()
    handle.close()
    expect(() => handle!.read()).toThrow('handle is closed')
  } finally {
    handle?.close()
    f.cache.close()
  }
})

test('distinct runs use independent inodes and changes to one copy preserve the other and cache', async () => {
  const f = await fixture(),
    second = join(f.root, 'second-run')
  mkdirSync(second, { mode: 0o700 })
  const first = await materializeSkillBundle(
    f.cache,
    f.selection,
    f.manifest,
    f.run,
  )
  const next = await materializeSkillBundle(
    f.cache,
    f.selection,
    f.manifest,
    second,
  )
  try {
    const a = join(f.selected, 'files', 'SKILL.md'),
      b = join(second, 'selected-skill/files/SKILL.md'),
      cached = join(f.address, 'files/SKILL.md')
    expect(statSync(a).ino).not.toBe(statSync(b).ino)
    expect(statSync(a).ino).not.toBe(statSync(cached).ino)
    const original = readFileSync(a),
      bad = Buffer.from(original)
    bad[0] ^= 1
    chmodSync(a, 0o600)
    writeFileSync(a, bad)
    expect(() => first.read()).toThrow('digest mismatch')
    expect(next.read().files.get('SKILL.md')).toEqual(original)
    expect(
      (await f.cache.read(f.selection, f.manifest)).files.get('SKILL.md'),
    ).toEqual(original)
  } finally {
    first.close()
    next.close()
    f.cache.close()
  }
})

test('existing or case-aliased selected roots are never shared adopted or overwritten', async () => {
  const f = await fixture()
  try {
    writeFileSync(join(f.run, 'SELECTED-SKILL'), 'foreign')
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
    ).rejects.toThrow('already has selected')
    expect(readdirSync(f.run)).toEqual(['SELECTED-SKILL'])
    rmSync(join(f.run, 'SELECTED-SKILL'))
    const handle = await materializeSkillBundle(
      f.cache,
      f.selection,
      f.manifest,
      f.run,
    )
    try {
      await expect(
        materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
      ).rejects.toThrow('already has selected')
      expect(handle.read().selection).toEqual(f.selection)
      expect(readdirSync(f.run)).toEqual(['selected-skill'])
    } finally {
      handle.close()
    }
  } finally {
    f.cache.close()
  }
})

test('invalid selection and corrupt missing unexpected cache objects never write a run', async () => {
  const f = await fixture()
  try {
    await expect(
      materializeSkillBundle(
        f.cache,
        { ...f.selection, entryDigest: 'a'.repeat(64) },
        f.manifest,
        f.run,
      ),
    ).rejects.toThrow('immutable manifest')
    const path = join(f.address, 'files', 'LICENSE'),
      bytes = readFileSync(path)
    writeFileSync(path, Buffer.alloc(bytes.length))
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
    ).rejects.toThrow('digest mismatch')
    rmSync(path)
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
    ).rejects.toThrow('inventory')
    writeFileSync(path, bytes)
    writeFileSync(join(f.address, 'files', 'unexpected'), 'extra')
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
    ).rejects.toThrow('inventory')
    expect(readdirSync(f.run)).toEqual([])
  } finally {
    f.cache.close()
  }
})

test('complete copied byte preflight precedes any materialization directory write', async () => {
  const f = await fixture(),
    actual = f.cache.read.bind(f.cache)
  f.cache.read = async (...args) => {
    const contents = await actual(...args)
    contents.files.get('SKILL.md')![0] ^= 1
    return contents
  }
  try {
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
    ).rejects.toThrow('digest mismatch')
    expect(readdirSync(f.run)).toEqual([])
  } finally {
    f.cache.close()
  }
})

test('unexpected cached response files cannot reach a materialized selection', async () => {
  const f = await fixture(),
    actual = f.cache.read.bind(f.cache)
  f.cache.read = async (...args) => {
    const result = await actual(...args)
    result.files.set('unexpected', Buffer.from('extra'))
    return result
  }
  try {
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
    ).rejects.toThrow('exactly match')
    expect(readdirSync(f.run)).toEqual([])
  } finally {
    f.cache.close()
  }
})

test('unsafe run roots and symlinked selected destinations are refused without escapes', async () => {
  const f = await fixture(),
    outside = join(f.root, 'outside')
  mkdirSync(outside, { mode: 0o700 })
  try {
    const alias = join(f.root, 'run-link')
    symlinkSync(f.run, alias)
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, alias),
    ).rejects.toThrow()
    chmodSync(f.run, 0o755)
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
    ).rejects.toThrow('private and owned')
    chmodSync(f.run, 0o700)
    symlinkSync(outside, f.selected)
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
    ).rejects.toThrow('already has selected')
    expect(readdirSync(outside)).toEqual([])
  } finally {
    f.cache.close()
  }
})

test('descriptor-held selection survives run pathname replacement without redirected writes', async () => {
  const f = await fixture(),
    outside = join(f.root, 'outside'),
    old = join(f.root, 'old-run')
  mkdirSync(outside, { mode: 0o700 })
  const actual = AnchoredDirectory.prototype.publishDirectory
  let handle: Awaited<ReturnType<typeof materializeSkillBundle>> | undefined
  AnchoredDirectory.prototype.publishDirectory = function (stage, name) {
    if (name === 'selected-skill') {
      renameSync(f.run, old)
      symlinkSync(outside, f.run)
    }
    return actual.call(this, stage, name)
  }
  try {
    handle = await materializeSkillBundle(
      f.cache,
      f.selection,
      f.manifest,
      f.run,
    )
    expect(readdirSync(outside)).toEqual([])
    expect(readdirSync(old)).toEqual(['selected-skill'])
    expect(handle.read().selection).toEqual(f.selection)
    expect(handle.read().files.get('LICENSE')).toEqual(
      readFileSync(join(f.source, 'LICENSE')),
    )
  } finally {
    AnchoredDirectory.prototype.publishDirectory = actual
    handle?.close()
    f.cache.close()
  }
})

test('selected tree revalidation refuses manifest tampering extras aliases and hard links', async () => {
  const f = await fixture(),
    handle = await materializeSkillBundle(
      f.cache,
      f.selection,
      f.manifest,
      f.run,
    )
  try {
    const path = join(f.selected, 'files', 'LICENSE'),
      bytes = readFileSync(path)
    writeFileSync(join(f.selected, 'files', 'extra'), 'extra')
    expect(() => handle.read()).toThrow('inventory')
    rmSync(join(f.selected, 'files', 'extra'))
    const outside = join(f.root, 'outside-license')
    writeFileSync(outside, bytes)
    rmSync(path)
    linkSync(outside, path)
    expect(() => handle.read()).toThrow('link count')
    rmSync(path)
    symlinkSync(outside, path)
    expect(() => handle.read()).toThrow('regular file')
    rmSync(path)
    writeFileSync(path, bytes, { mode: 0o400 })
    const metadata = join(f.selected, 'manifest.json')
    chmodSync(metadata, 0o600)
    writeFileSync(
      metadata,
      JSON.stringify({
        ...f.manifest,
        metadata: { ...f.manifest.metadata, description: 'changed' },
      }),
    )
    expect(() => handle.read()).toThrow('canonical manifest differs')
  } finally {
    handle.close()
    f.cache.close()
  }
})

test('corrupt staged materialization is refused before publishing selected output', async () => {
  const f = await fixture()
  try {
    const result = await child(f.cacheRoot, f.run, 'corrupt')
    expect(result.exit).toBe(1)
    expect(result.err).toContain('digest mismatch')
    expect(readdirSync(f.run)).not.toContain('selected-skill')
  } finally {
    f.cache.close()
  }
}, 10000)

test('pre-publication interruption retains an unselected private stage and permits preparation retry', async () => {
  const f = await fixture()
  try {
    expect(await child(f.cacheRoot, f.run, 'before')).toEqual({
      exit: 137,
      out: '',
      err: '',
    })
    const names = readdirSync(f.run)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^\.gild-selected-[a-f0-9]{24}$/)
    const handle = await materializeSkillBundle(
      f.cache,
      f.selection,
      f.manifest,
      f.run,
    )
    try {
      expect(handle.read().selection).toEqual(f.selection)
      expect(readdirSync(f.run)).toContain(names[0])
    } finally {
      handle.close()
    }
  } finally {
    f.cache.close()
  }
}, 10000)

test('post-publication interruption leaves complete content but no automatic selected-root adoption', async () => {
  const f = await fixture()
  try {
    expect(await child(f.cacheRoot, f.run, 'after')).toEqual({
      exit: 137,
      out: '',
      err: '',
    })
    expect(readdirSync(f.run)).toEqual(['selected-skill'])
    const files = readSkillInventory(
      join(f.selected, 'files'),
      f.manifest.files.map((file) => ({
        path: file.path,
        size: file.bytes,
        sha256: file.sha256,
      })),
    )
    expect(files.get('LICENSE')).toEqual(
      readFileSync(join(f.source, 'LICENSE')),
    )
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.run),
    ).rejects.toThrow('already has selected')
  } finally {
    f.cache.close()
  }
}, 10000)

test('competing materializers cannot share or adopt the same selected run root', async () => {
  const f = await fixture()
  try {
    const result = await Promise.all([
      child(f.cacheRoot, f.run, 'normal'),
      child(f.cacheRoot, f.run, 'normal'),
    ])
    expect(result.map((row) => row.exit).sort()).toEqual([0, 1])
    expect(result.find((row) => row.exit === 0)?.out).toBe(
      f.selection.bundleDigest + '\n',
    )
    expect(result.find((row) => row.exit === 1)?.err).toContain(
      'already has selected',
    )
    expect(
      readdirSync(f.run).filter((name) => name === 'selected-skill'),
    ).toEqual(['selected-skill'])
  } finally {
    f.cache.close()
  }
}, 10000)

test('a publication collision never adopts even a valid competing selected tree', async () => {
  const f = await fixture(),
    actual = AnchoredDirectory.prototype.publishDirectory
  let received: Awaited<ReturnType<typeof materializeSkillBundle>> | undefined
  AnchoredDirectory.prototype.publishDirectory = function (stage, name) {
    const published = actual.call(this, stage, name)
    return name === 'selected-skill' ? false : published
  }
  try {
    const failure = await materializeSkillBundle(
      f.cache,
      f.selection,
      f.manifest,
      f.run,
    ).then(
      (handle) => {
        received = handle
        return null
      },
      (error) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('already has selected')
    expect(received).toBeUndefined()
  } finally {
    AnchoredDirectory.prototype.publishDirectory = actual
    received?.close()
    f.cache.close()
  }
})

test('materialization cannot write into its cache or immutable cached files tree', async () => {
  const f = await fixture(),
    before = readdirSync(join(f.address, 'files')).sort()
  try {
    await expect(
      materializeSkillBundle(f.cache, f.selection, f.manifest, f.cacheRoot),
    ).rejects.toThrow('overlaps cache')
    await expect(
      materializeSkillBundle(
        f.cache,
        f.selection,
        f.manifest,
        join(f.address, 'files'),
      ),
    ).rejects.toThrow('overlaps cache')
    expect(readdirSync(join(f.address, 'files')).sort()).toEqual(before)
    expect((await f.cache.read(f.selection, f.manifest)).selection).toEqual(
      f.selection,
    )
  } finally {
    f.cache.close()
  }
})
