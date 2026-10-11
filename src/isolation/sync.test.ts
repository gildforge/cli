import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { finishVmSync } from '../spawn-vm'
import { hostManifest, syncBack, validPath, type Manifest } from './sync'
import type { Entry, GuestFiles } from './session'

/** A "guest" that is just another directory, listed with the host walker. */
function dirGuest(dir: string): GuestFiles {
  return {
    list: async () => [...(await hostManifest(dir)).values()],
    read: (path) => readFile(join(dir, path.replace(/^\/workspace\/?/, ''))),
  }
}

async function setup() {
  await mkdir('.tmp', { recursive: true })
  const base = await mkdtemp(resolve('.tmp/sync-'))
  const host = join(base, 'host'),
    guest = join(base, 'guest'),
    conflicts = join(base, 'conflicts')
  await mkdir(join(host, 'src/deep'), { recursive: true })
  await writeFile(join(host, 'README.md'), 'readme\n')
  await writeFile(join(host, 'src/a.ts'), 'a\n')
  await writeFile(join(host, 'src/deep/b.ts'), 'b\n')
  await writeFile(join(host, 'gone.txt'), 'delete me\n')
  await writeFile(join(host, 'run.sh'), '#!/bin/sh\n')
  await mkdir(join(host, 'olddir/inner'), { recursive: true })
  await writeFile(join(host, 'olddir/inner/x'), 'x\n')
  const baseline = await hostManifest(host)
  await cp(host, guest, { recursive: true, verbatimSymlinks: true })
  const sync = (b: Manifest = baseline, files = dirGuest(guest)) =>
    syncBack({
      root: host,
      guestRoot: '/workspace',
      files,
      baseline: b,
      conflictDir: conflicts,
    })
  return { base, host, guest, conflicts, baseline, sync }
}

const strip = (m: Manifest) => [...m.values()].map(({ s: _s, ...rest }) => rest)

test('unresolved file, directory, link and deletion conflicts survive repeated sync and retain final recovery', async () => {
  const t = await setup()
  try {
    await symlink('README.md', join(t.host, 'link'))
    await symlink('README.md', join(t.guest, 'link'))
    const baseline = await hostManifest(t.host)
    await rm(join(t.host, 'link'))
    await symlink('run.sh', join(t.host, 'link'))
    await rm(join(t.guest, 'link'))
    await symlink('src/a.ts', join(t.guest, 'link'))
    await writeFile(join(t.host, 'gone.txt'), 'host edit\n')
    await rm(join(t.guest, 'gone.txt'))
    await writeFile(join(t.host, 'src/a.ts'), 'host version\n')
    await writeFile(join(t.guest, 'src/a.ts'), 'guest version\n')
    await chmod(join(t.host, 'src/deep'), 0o700)
    await chmod(join(t.guest, 'src/deep'), 0o750)
    const first = await t.sync(baseline)
    const second = await t.sync(baseline)
    for (const r of [first, second]) {
      expect(r.conflicts.map((c) => c.path).sort()).toEqual([
        'gone.txt',
        'link',
        'src/a.ts',
        'src/deep',
      ])
      const link = r.conflicts.find((c) => c.path === 'link')!
      expect(await Bun.file(link.saved!).json()).toMatchObject({
        path: 'link',
        entry: { k: 'l', t: 'src/a.ts' },
      })
      const removed = r.conflicts.find((c) => c.path === 'gone.txt')!
      expect(await Bun.file(removed.saved!).json()).toMatchObject({
        path: 'gone.txt',
        entry: null,
      })
      expect((await stat(link.saved!)).mode & 0o777).toBe(0o600)
      const directory = r.conflicts.find((c) => c.path === 'src/deep')!
      expect(await Bun.file(directory.saved!).json()).toMatchObject({
        path: 'src/deep',
        entry: { k: 'd', m: 0o750 },
      })
      expect(
        await Bun.file(
          r.conflicts.find((c) => c.path === 'src/a.ts')!.saved!,
        ).text(),
      ).toBe('guest version\n')
    }
    expect(baseline.get('link')!.t).toBe('README.md')
    let retained = false
    const vmDir = join(t.base, 'vm')
    await mkdir(vmDir, { mode: 0o700 })
    const final = await finishVmSync(
      () => t.sync(baseline),
      {
        close: async (options) => {
          retained = !!options?.preserveWorkspace
          if (!retained) await rm(t.guest, { recursive: true })
        },
      },
      vmDir,
      () => {},
    )
    expect(retained).toBe(true)
    expect(final.conflicts).toHaveLength(4)
    expect(
      (await Bun.file(join(vmDir, 'recovery.json')).json()).result.conflicts,
    ).toHaveLength(4)
    expect(readlinkSync(join(t.host, 'link'))).toBe('run.sh')
    // Resolving the copies explicitly advances the baseline and clears conflicts.
    await rm(join(t.guest, 'link'))
    await symlink('run.sh', join(t.guest, 'link'))
    await writeFile(join(t.guest, 'gone.txt'), 'host edit\n')
    await writeFile(join(t.guest, 'src/a.ts'), 'host version\n')
    await chmod(join(t.guest, 'src/deep'), 0o700)
    expect((await t.sync(baseline)).conflicts).toEqual([])
  } finally {
    await rm(t.base, { recursive: true, force: true })
  }
})

test('host manifest skips existing FIFO/socket entries but guest mutations to them fail', async () => {
  const t = await setup()
  const server = createServer()
  try {
    const fifo = Bun.spawnSync(['mkfifo', join(t.host, 'pipe')])
    expect(fifo.exitCode).toBe(0)
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.listen(join(t.host, 'local.sock'), done)
    })
    const manifest = hostManifest(t.host)
    await expect(manifest).resolves.toBeInstanceOf(Map)
    const baseline = await manifest
    expect(baseline.has('pipe')).toBe(false)
    expect(baseline.has('local.sock')).toBe(false)
    await writeFile(join(t.guest, 'pipe'), 'ordinary guest fixture\n')
    await writeFile(join(t.guest, 'local.sock'), 'ordinary guest fixture\n')
    const result = await t.sync(baseline)
    expect(result.conflicts.map((c) => c.path).sort()).toEqual([
      'local.sock',
      'pipe',
    ])
    expect(lstatSync(join(t.host, 'pipe')).isFIFO()).toBe(true)
    expect(lstatSync(join(t.host, 'local.sock')).isSocket()).toBe(true)
    expect(result.written).toEqual([])
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
    await rm(t.base, { recursive: true, force: true })
  }
})

test('an unchanged guest syncs nothing', async () => {
  const t = await setup()
  const r = await t.sync()
  expect(r).toEqual({ written: [], deleted: [], conflicts: [], rejected: [] })
  await rm(t.base, { recursive: true })
})

test('creates, edits, deletes, mode changes, new dirs and symlinks land on the host', async () => {
  const t = await setup()
  await writeFile(join(t.guest, 'src/a.ts'), 'a edited in the guest\n')
  await rm(join(t.guest, 'gone.txt'))
  await chmod(join(t.guest, 'run.sh'), 0o755)
  await mkdir(join(t.guest, 'new/nested'), { recursive: true })
  await writeFile(join(t.guest, 'new/nested/c.ts'), 'c\n')
  await symlink('src/a.ts', join(t.guest, 'link'))
  await rm(join(t.guest, 'olddir'), { recursive: true })
  await writeFile(join(t.guest, 'olddir'), 'a dir became a file\n')
  const r = await t.sync()
  expect(r.conflicts).toEqual([])
  expect(r.deleted.sort()).toEqual(
    ['gone.txt', 'olddir/inner', 'olddir/inner/x'].sort(),
  )
  // The whole host tree now equals the guest tree.
  expect(strip(await hostManifest(t.host))).toEqual(
    strip(await hostManifest(t.guest)),
  )
  expect((await stat(join(t.host, 'run.sh'))).mode & 0o777).toBe(0o755)
  expect(readlinkSync(join(t.host, 'link'))).toBe('src/a.ts')
  // The baseline moved: syncing again is a no-op, and a later edit is carried alone.
  expect((await t.sync()).written).toEqual([])
  await writeFile(join(t.guest, 'README.md'), 'second round\n')
  expect((await t.sync()).written).toEqual(['README.md'])
  expect(await readFile(join(t.host, 'README.md'), 'utf8')).toBe(
    'second round\n',
  )
  await rm(t.base, { recursive: true })
})

test('a file changed on both sides keeps the host copy and saves the guest one; host-only edits are untouched', async () => {
  const t = await setup()
  await writeFile(join(t.host, 'src/a.ts'), 'host edit\n')
  await writeFile(join(t.guest, 'src/a.ts'), 'guest edit\n')
  await writeFile(join(t.host, 'README.md'), 'host-only edit\n')
  await writeFile(join(t.host, 'gone.txt'), 'host edited, guest deleted\n')
  await rm(join(t.guest, 'gone.txt'))
  const r = await t.sync()
  expect(await readFile(join(t.host, 'src/a.ts'), 'utf8')).toBe('host edit\n')
  expect(await readFile(join(t.host, 'README.md'), 'utf8')).toBe(
    'host-only edit\n',
  )
  expect(existsSync(join(t.host, 'gone.txt'))).toBe(true)
  const saved = r.conflicts.find((c) => c.path === 'src/a.ts')!.saved!
  expect(saved.startsWith(t.conflicts)).toBe(true)
  expect(await readFile(saved, 'utf8')).toBe('guest edit\n')
  expect(r.conflicts.map((c) => c.path).sort()).toEqual([
    'gone.txt',
    'src/a.ts',
  ])
  await rm(t.base, { recursive: true })
})

test('a hostile guest cannot write through a symlink or outside the root', async () => {
  const t = await setup()
  const outside = join(t.base, 'outside')
  await mkdir(outside)
  const body = Buffer.from('pwned\n')
  const h = createHash('sha256').update(body).digest('hex')
  const file = (p: string): Entry => ({ p, k: 'f', m: 0o644, s: 6, h })
  // The guest claims: a symlink to a host directory, then files "inside" it,
  // and a dir that already exists on the host replaced by a link with a file under it.
  const listing: Entry[] = [...(await hostManifest(t.host)).values()].filter(
    (e) => !e.p.startsWith('src'),
  )
  listing.push(
    { p: 'evil', k: 'l', m: 0, t: outside },
    file('evil/pwned'),
    { p: 'src', k: 'l', m: 0, t: outside },
    file('src/pwned2'),
    file('../escape'),
    file('/abs'),
    file('a/./b'),
  )
  const hostile: GuestFiles = {
    list: async () => listing,
    read: async () => body,
  }
  const r = await t.sync(t.baseline, hostile)
  expect(existsSync(join(outside, 'pwned'))).toBe(false)
  expect(existsSync(join(outside, 'pwned2'))).toBe(false)
  expect(existsSync(join(t.base, 'escape'))).toBe(false)
  expect(r.rejected.map((x) => x.path).sort()).toEqual(
    ['../escape', '/abs', 'a/./b'].sort(),
  )
  // The link itself may land (it is just a link), but nothing went through it.
  expect(lstatSync(join(t.host, 'evil')).isSymbolicLink()).toBe(true)
  for (const p of ['evil/pwned', 'src/pwned2'])
    expect(r.conflicts.some((c) => c.path === p)).toBe(true)
  await rm(t.base, { recursive: true })
})

test('bytes that do not match the listed hash are not applied', async () => {
  const t = await setup()
  await writeFile(join(t.guest, 'src/a.ts'), 'listed content\n')
  const real = dirGuest(t.guest)
  const r = await t.sync(t.baseline, {
    list: real.list,
    read: async () => Buffer.from('different bytes\n'),
  })
  expect(await readFile(join(t.host, 'src/a.ts'), 'utf8')).toBe('a\n')
  expect(r.conflicts[0].reason).toMatch(/changed while syncing/)
  await rm(t.base, { recursive: true })
})

test('path validation', () => {
  for (const ok of ['a', 'a/b', '.git/HEAD', 'a..b'])
    expect(validPath(ok)).toBe(true)
  for (const bad of ['', '/a', 'a//b', '../a', 'a/..', './a', 'a\0b', 7])
    expect(validPath(bad)).toBe(false)
})

test('automatic sync preserves host Git metadata and applies ordinary source edits', async () => {
  const t = await setup()
  try {
    await mkdir(join(t.host, '.git/hooks'), { recursive: true })
    await writeFile(join(t.host, '.git/config'), 'host configuration fixture\n')
    await writeFile(join(t.host, '.git/hooks/fixture'), 'host hook fixture\n')
    const baseline = await hostManifest(t.host)
    await cp(join(t.host, '.git'), join(t.guest, '.git'), { recursive: true })
    await writeFile(
      join(t.guest, '.git/config'),
      'guest configuration fixture\n',
    )
    await rm(join(t.guest, '.git/hooks/fixture'))
    await writeFile(join(t.guest, '.git/HEAD'), 'guest reference fixture\n')
    await writeFile(join(t.guest, 'src/a.ts'), 'source edit\n')
    const r = await t.sync(baseline)
    expect(r.written).toEqual(['src/a.ts'])
    expect(r.deleted).toEqual([])
    expect(r.rejected.map((e) => e.path).sort()).toEqual([
      '.git/HEAD',
      '.git/config',
      '.git/hooks/fixture',
    ])
    expect(await readFile(join(t.host, '.git/config'), 'utf8')).toBe(
      'host configuration fixture\n',
    )
    expect(await readFile(join(t.host, '.git/hooks/fixture'), 'utf8')).toBe(
      'host hook fixture\n',
    )
    expect(existsSync(join(t.host, '.git/HEAD'))).toBe(false)
    expect(await readFile(join(t.host, 'src/a.ts'), 'utf8')).toBe(
      'source edit\n',
    )
  } finally {
    await rm(t.base, { recursive: true })
  }
})

test('host changes during asynchronous guest retrieval are checked after retrieval', async () => {
  const t = await setup()
  try {
    await writeFile(join(t.guest, 'src/a.ts'), 'guest edit\n')
    const files = dirGuest(t.guest)
    const r = await t.sync(t.baseline, {
      list: files.list,
      read: async (path) => {
        const data = await files.read(path)
        await rename(join(t.host, 'src'), join(t.host, 'previous-src'))
        await mkdir(join(t.host, 'src'))
        await writeFile(
          join(t.host, 'src/a.ts'),
          'new host directory fixture\n',
        )
        return data
      },
    })
    expect(r.written).toEqual([])
    expect(await readFile(join(t.host, 'src/a.ts'), 'utf8')).toBe(
      'new host directory fixture\n',
    )
    expect(await readFile(join(t.host, 'previous-src/a.ts'), 'utf8')).toBe(
      'a\n',
    )
    expect(await readFile(r.conflicts[0].saved!, 'utf8')).toBe('guest edit\n')
  } finally {
    await rm(t.base, { recursive: true })
  }
})
