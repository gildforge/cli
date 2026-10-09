import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const base = await mkdtemp(join(tmpdir(), 'sync-'))
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
