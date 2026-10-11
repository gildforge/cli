import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { AnchoredDirectory } from '../isolation/anchored-fs'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  renameSync,
  rmSync,
  statSync,
  readdirSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { ECC_CANDIDATE, readEccCandidate } from './ecc-candidate'
import {
  SkillByteCache,
  readPinnedSkillFiles,
  validateSkillFiles,
  validateSkillPath,
  verifySkillBytes,
  MAX_SKILL_FILE_BYTES,
  type LocalSkillByteExpectation,
} from './local-bytes'
const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true })
})
function fixture() {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const root = mkdtempSync(resolve('.tmp/skill-bytes-'))
  roots.push(root)
  return root
}
function pin(
  path = 'SKILL.md',
  bytes = Buffer.from('verified instruction data'),
): LocalSkillByteExpectation {
  return {
    path,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
function source(root: string) {
  const dir = join(root, 'source')
  mkdirSync(dir)
  for (const name of ['SKILL.md', 'LICENSE'])
    writeFileSync(
      join(dir, name),
      readFileSync(
        resolve('scripts/fixtures/skills/ecc-verification-loop', name),
      ),
    )
  return dir
}
test('verified ECC pin returns exact skill and original MIT notice with immutable provenance', () => {
  const dir = source(fixture()),
    files = readEccCandidate(dir)
  expect(ECC_CANDIDATE.commit).toBe('d4a44ded8c150aac89b37c1f665b5a749fe52b02')
  expect(ECC_CANDIDATE.originalLicensePath).toBe('pi/core/LICENSE')
  expect(files.get('SKILL.md')?.length).toBe(3064)
  expect(files.get('LICENSE')?.toString()).toContain(
    'Copyright (c) 2026 Affaan Mustafa',
  )
  expect(files.size).toBe(2)
})
test('candidate fails without the original license or with corrupted instruction bytes', () => {
  const dir = source(fixture())
  rmSync(join(dir, 'LICENSE'))
  expect(() => readEccCandidate(dir)).toThrow('missing')
  writeFileSync(
    join(dir, 'LICENSE'),
    readFileSync(
      resolve('scripts/fixtures/skills/ecc-verification-loop/LICENSE'),
    ),
  )
  const original = readFileSync(join(dir, 'SKILL.md'))
  original[original.length - 1] ^= 1
  writeFileSync(join(dir, 'SKILL.md'), original)
  expect(() => readEccCandidate(dir)).toThrow('digest mismatch')
})
test('traversal never reads the matching outside bytes', () => {
  const root = fixture(),
    dir = join(root, 'source')
  mkdirSync(dir)
  const bytes = Buffer.from('outside fixture data')
  writeFileSync(join(root, 'outside.md'), bytes)
  expect(() =>
    readPinnedSkillFiles(dir, [pin('../outside.md', bytes)]),
  ).toThrow('unsafe skill path')
})
for (const path of [
  '',
  '/SKILL.md',
  'a//b',
  'a/./b',
  'a/../b',
  'C:\\SKILL.md',
  'a\0b',
  'a\nb',
  '%2e%2e/outside',
  'refs/é.md',
  'NUL.md',
  'refs/a.',
  'refs/a ',
])
  test(`reject nonportable/path-ambiguous input ${JSON.stringify(path)}`, () => {
    expect(() => validateSkillPath(path)).toThrow('unsafe skill path')
  })
for (const paths of [
  ['SKILL.md', 'skill.md'],
  ['refs/a', 'Refs/b'],
  ['refs', 'refs/a'],
  ['LICENSE', 'LICENSE'],
])
  test(`reject file/directory/case collision ${paths.join(',')}`, () => {
    expect(() => validateSkillFiles(paths.map((p) => pin(p)))).toThrow(
      'collision',
    )
  })
test('valid shared parent is accepted without mutating input pins', () => {
  const files = [pin('refs/a'), pin('refs/b')],
    checked = validateSkillFiles(files)
  files[0] = pin('../changed')
  expect(checked[0].path).toBe('refs/a')
})
test('escaping leaf and directory symlinks are refused even when their bytes match', () => {
  const root = fixture(),
    dir = join(root, 'source'),
    outside = join(root, 'outside')
  mkdirSync(dir)
  mkdirSync(outside)
  const bytes = Buffer.from('outside fixture data')
  writeFileSync(join(outside, 'SKILL.md'), bytes)
  symlinkSync(join(outside, 'SKILL.md'), join(dir, 'SKILL.md'))
  expect(() => readPinnedSkillFiles(dir, [pin('SKILL.md', bytes)])).toThrow(
    'not a regular file',
  )
  symlinkSync(outside, join(dir, 'refs'))
  expect(() =>
    readPinnedSkillFiles(dir, [pin('refs/SKILL.md', bytes)]),
  ).toThrow()
})
test('symlinked root/ancestor and hard-linked file are refused', () => {
  const root = fixture(),
    actual = join(root, 'actual')
  mkdirSync(actual)
  const bytes = Buffer.from('outside fixture data')
  writeFileSync(join(actual, 'SKILL.md'), bytes)
  symlinkSync(actual, join(root, 'alias'))
  expect(() =>
    readPinnedSkillFiles(join(root, 'alias'), [pin('SKILL.md', bytes)]),
  ).toThrow()
  mkdirSync(join(actual, 'nested'))
  writeFileSync(join(actual, 'nested/SKILL.md'), bytes)
  expect(() =>
    readPinnedSkillFiles(join(root, 'alias/nested'), [pin('SKILL.md', bytes)]),
  ).toThrow()
  const dir = join(root, 'source')
  mkdirSync(dir)
  linkSync(join(actual, 'SKILL.md'), join(dir, 'SKILL.md'))
  expect(() => readPinnedSkillFiles(dir, [pin('SKILL.md', bytes)])).toThrow(
    'link count',
  )
})
test('wrong sizes/digests and resource bounds fail without returning raw data', () => {
  const bytes = Buffer.from('opaque payload'),
    good = pin('SKILL.md', bytes)
  expect(() =>
    verifySkillBytes({ ...good, size: bytes.length + 1 }, bytes),
  ).toThrow('size mismatch')
  expect(() =>
    verifySkillBytes({ ...good, sha256: '0'.repeat(64) }, bytes),
  ).toThrow('digest mismatch')
  for (const size of [
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    MAX_SKILL_FILE_BYTES + 1,
  ])
    expect(() => verifySkillBytes({ ...good, size }, bytes)).toThrow(
      'invalid skill byte expectation',
    )
  expect(() =>
    verifySkillBytes({ ...good, sha256: '../outside' }, bytes),
  ).toThrow('invalid skill byte expectation')
})
test('filesystem reads are bounded before allocating or returning excessive bytes', () => {
  const dir = fixture(),
    bytes = Buffer.from('larger than expected')
  writeFileSync(join(dir, 'SKILL.md'), bytes)
  expect(() =>
    readPinnedSkillFiles(dir, [pin('SKILL.md', bytes.subarray(0, 3))]),
  ).toThrow('read bound')
})
test('opaque shell-looking content is bytes, never executed or registered', () => {
  const root = fixture(),
    marker = join(root, 'must-not-exist'),
    bytes = Buffer.from(
      `description: $(touch ${marker})\nMCP_REGISTER=anything\n`,
    )
  writeFileSync(join(root, 'SKILL.md'), bytes)
  expect(
    readPinnedSkillFiles(root, [pin('SKILL.md', bytes)]).get('SKILL.md'),
  ).toEqual(bytes)
  expect(readdirSync(root)).toEqual(['SKILL.md'])
})
test('private byte cache preserves offline verified bytes and caller buffer changes do not affect it', () => {
  const root = fixture(),
    cache = new SkillByteCache(root),
    bytes = Buffer.from('offline locked bytes'),
    expected = pin('SKILL.md', bytes)
  try {
    const returned = cache.store(expected, bytes)
    bytes.fill(0)
    returned.fill(1)
    expect(cache.read(expected).toString()).toBe('offline locked bytes')
    expect(statSync(join(root, expected.sha256)).mode & 0o777).toBe(0o600)
    expect(
      cache.store(expected, Buffer.from('offline locked bytes')).toString(),
    ).toBe('offline locked bytes')
    expect(readdirSync(root)).toEqual([expected.sha256])
    expect(() => cache.read(pin('missing', Buffer.from('not cached')))).toThrow(
      'missing',
    )
  } finally {
    cache.close()
  }
})
test('corrupt offline object fails; storing valid bytes does not silently repair it', () => {
  const root = fixture(),
    cache = new SkillByteCache(root),
    bytes = Buffer.from('verified bytes'),
    expected = pin('SKILL.md', bytes)
  try {
    cache.store(expected, bytes)
    const bad = Buffer.from(bytes)
    bad[0] ^= 1
    writeFileSync(join(root, expected.sha256), bad)
    expect(() => cache.read(expected)).toThrow('digest mismatch')
    expect(() => cache.store(expected, bytes)).toThrow('digest mismatch')
    expect(readFileSync(join(root, expected.sha256))).toEqual(bad)
  } finally {
    cache.close()
  }
})
test('unsafe cache object is never overwritten or followed', () => {
  const root = fixture(),
    directory = join(root, 'cache')
  mkdirSync(directory, { mode: 0o700 })
  const bytes = Buffer.from('outside bytes'),
    expected = pin('SKILL.md', bytes),
    victim = join(root, 'victim')
  writeFileSync(victim, bytes)
  symlinkSync(victim, join(directory, expected.sha256))
  const cache = new SkillByteCache(directory)
  try {
    expect(() => cache.store(expected, bytes)).toThrow('not a regular file')
    expect(readFileSync(victim)).toEqual(bytes)
  } finally {
    cache.close()
  }
})
test('cache uses the opened root if its pathname is replaced with an escaping link', () => {
  const root = fixture(),
    path = join(root, 'cache'),
    moved = join(root, 'moved'),
    outside = join(root, 'outside')
  mkdirSync(path, { mode: 0o700 })
  mkdirSync(outside)
  const cache = new SkillByteCache(path),
    bytes = Buffer.from('verified bytes'),
    expected = pin('SKILL.md', bytes)
  try {
    renameSync(path, moved)
    symlinkSync(outside, path)
    cache.store(expected, bytes)
    expect(readdirSync(outside)).toEqual([])
    expect(readFileSync(join(moved, expected.sha256))).toEqual(bytes)
  } finally {
    cache.close()
  }
})
test('non-private cache roots and invalid bytes are refused without filesystem writes', () => {
  const root = fixture(),
    publicDir = join(root, 'public')
  mkdirSync(publicDir, { mode: 0o755 })
  expect(() => new SkillByteCache(publicDir)).toThrow('private and owned')
  const cache = new SkillByteCache(root),
    bytes = Buffer.from('verified'),
    expected = pin('SKILL.md', bytes)
  try {
    expect(() => cache.store(expected, Buffer.from('wrong'))).toThrow(
      'size mismatch',
    )
    expect(readdirSync(root)).toEqual(['public'])
  } finally {
    cache.close()
  }
})

test('digest whitespace is rejected before it can select a cache object', () => {
  const bytes = Buffer.from('verified instruction data'),
    spec = pin()
  expect(() =>
    verifySkillBytes({ ...spec, sha256: spec.sha256 + '\n' }, bytes),
  ).toThrow('invalid skill byte expectation')
})
test('case aliases are rejected at the filesystem reader boundary', () => {
  const root = fixture(),
    bytes = Buffer.from('matching bytes')
  writeFileSync(join(root, 'SKILL.md'), bytes)
  expect(() =>
    readPinnedSkillFiles(root, [
      pin('SKILL.md', bytes),
      pin('skill.md', bytes),
    ]),
  ).toThrow('collision')
})
test('special entries are rejected without waiting on FIFO content', () => {
  const root = fixture(),
    result = spawnSync('mkfifo', [join(root, 'SKILL.md')])
  expect(result.status).toBe(0)
  expect(() => readPinnedSkillFiles(root, [pin()])).toThrow(
    'not a regular file',
  )
})
test('nonstring metadata is rejected without executing coercion', () => {
  let invoked = false
  const value = {
    toString() {
      invoked = true
      return 'SKILL.md'
    },
  }
  expect(() => validateSkillPath(value as unknown as string)).toThrow(
    'unsafe skill path',
  )
  expect(() =>
    verifySkillBytes(
      { ...pin(), sha256: value as unknown as string },
      Buffer.from('verified instruction data'),
    ),
  ).toThrow('invalid skill byte expectation')
  expect(invoked).toBe(false)
})
test('atomic complete-byte publication never replaces an existing destination', () => {
  const root = fixture(),
    directory = AnchoredDirectory.open(root)
  try {
    expect(
      directory.putRegularIfAbsent(
        'object',
        Buffer.from('first complete bytes'),
      ),
    ).toBe(true)
    expect(
      directory.putRegularIfAbsent('object', Buffer.from('replacement bytes')),
    ).toBe(false)
    expect(readFileSync(join(root, 'object')).toString()).toBe(
      'first complete bytes',
    )
    expect(readdirSync(root)).toEqual(['object'])
  } finally {
    directory.close()
  }
})

test('byte publication establishes private permissions despite restrictive creation mask', () => {
  const root = fixture(),
    directory = AnchoredDirectory.open(root),
    bytes = Buffer.from('private published bytes')
  const before = process.umask(0o777)
  let failure: unknown, published: boolean | undefined
  try {
    published = directory.putRegularIfAbsent('object', bytes)
  } catch (error) {
    failure = error
  } finally {
    process.umask(before)
    directory.close()
  }
  expect(failure).toBeUndefined()
  expect(published).toBe(true)
  expect(statSync(join(root, 'object')).mode & 0o777).toBe(0o600)
  expect(readFileSync(join(root, 'object'))).toEqual(bytes)
})

test('interruption immediately after publication leaves a readable single-link object', async () => {
  const root = fixture(),
    bytes = Buffer.from('interruption fixture bytes'),
    expected = pin('SKILL.md', bytes)
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      resolve('scripts/fixtures/skill-cache-interruption.ts'),
      root,
      expected.sha256,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    const [exit, err] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    expect({ exit, err }).toEqual({ exit: 137, err: '' })
    expect(statSync(join(root, expected.sha256)).nlink).toBe(1)
    expect(readdirSync(root)).toEqual([expected.sha256])
    const cache = new SkillByteCache(root)
    try {
      expect(cache.read(expected)).toEqual(bytes)
      expect(cache.store(expected, bytes)).toEqual(bytes)
    } finally {
      cache.close()
    }
  } finally {
    clearTimeout(timer)
  }
}, 10000)

test('removal evidence rejects a setup exception whose source excerpt mentions expect', async () => {
  const root = fixture(),
    source = join(root, 'false-proof.test.ts'),
    runner = join(root, 'runner.mjs')
  writeFileSync(
    source,
    "import {test,expect} from 'bun:test';\nconst changeMe=1;\ntest('setup exception',()=>{\n const misleading='expect(';\n throw new Error('ENOENT fixture setup failed');\n expect(changeMe).toBe(2);\n});\n",
  )
  writeFileSync(
    runner,
    `import { prove } from ${JSON.stringify(resolve('scripts/review-revert.mjs'))};\ntry { prove('false-proof-guard',${JSON.stringify(source)},s=>s.replace('changeMe=1','changeMe=2'),${JSON.stringify(source)},'setup exception'); process.exitCode=2 } catch(e) { if(!e.message.includes('Expected assertion failure')) throw e; console.log('setup-error-rejected') }\n`,
  )
  const child = Bun.spawn(['node', runner], { stdout: 'pipe', stderr: 'pipe' })
  const [exit, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exit, out, err }).toEqual({
    exit: 0,
    out: 'setup-error-rejected\n',
    err: '',
  })
  expect(readFileSync(source, 'utf8')).toContain('changeMe=1')
})

test('foreign and internal-looking hard-link remnants stay rejected without automatic repair', () => {
  const root = fixture(),
    dir = join(root, 'cache'),
    outside = join(root, 'outside')
  mkdirSync(dir, { mode: 0o700 })
  const bytes = Buffer.from('verified foreign bytes'),
    spec = pin('SKILL.md', bytes)
  writeFileSync(outside, bytes)
  linkSync(outside, join(dir, spec.sha256))
  const cache = new SkillByteCache(dir)
  try {
    expect(() => cache.read(spec)).toThrow('link count')
    expect(() => cache.store(spec, bytes)).toThrow('link count')
    expect(readFileSync(outside)).toEqual(bytes)
    rmSync(join(dir, spec.sha256))
    const remnant = join(dir, '.gild-bytes-' + 'a'.repeat(24))
    writeFileSync(remnant, bytes)
    linkSync(remnant, join(dir, spec.sha256))
    expect(() => cache.read(spec)).toThrow('link count')
    expect(() => cache.store(spec, bytes)).toThrow('link count')
    expect(statSync(remnant).nlink).toBe(2)
  } finally {
    cache.close()
  }
})
