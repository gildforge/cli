// Working-directory sync for `gild spawn --vm`. Stock Firecracker has no
// virtio-fs, so the guest works on a copy of the directory (an ext4 drive) and
// its changes come back to the host at exit and on demand (`gild sync <id>`).
//
// The rule, per path, three-way against the baseline (the tree as it was copied
// into the guest, or as of the last sync):
// - the guest changed it and the host still matches the baseline: applied;
// - the host changed it too: the host copy is kept and the guest's version is
//   saved under `conflictDir`, never merged and never silently dropped;
// - only the host changed it: untouched.
// The guest is untrusted: its paths are validated, nothing is written through a
// symlink or outside the root, and file bytes must match the hash it listed.
import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Entry, GuestFiles } from './session'

export type Manifest = Map<string, Entry>

export interface SyncResult {
  written: string[]
  deleted: string[]
  conflicts: { path: string; reason: string; saved?: string }[]
  rejected: { path: string; reason: string }[]
}

async function sha256(path: string) {
  const h = createHash('sha256')
  const f = await open(path, 'r')
  try {
    for await (const chunk of f.createReadStream()) h.update(chunk)
  } finally {
    await f.close().catch(() => {})
  }
  return h.digest('hex')
}

/** The entry at `path`, or undefined; never follows a symlink. */
async function entryAt(path: string, rel: string): Promise<Entry | undefined> {
  const st = await lstat(path).catch(() => null)
  if (!st) return undefined
  if (st.isSymbolicLink())
    return { p: rel, k: 'l', m: 0, t: await readlink(path) }
  if (st.isDirectory()) return { p: rel, k: 'd', m: st.mode & 0o7777 }
  if (st.isFile())
    return {
      p: rel,
      k: 'f',
      m: st.mode & 0o7777,
      s: st.size,
      h: await sha256(path),
    }
  return undefined // sockets, fifos and devices are not synced
}

/** The host side of the guest agent's `list` op: same walk, same fields. */
export async function hostManifest(root: string): Promise<Manifest> {
  const out: Manifest = new Map()
  const walk = async (dir: string, prefix: string) => {
    const names = (await readdir(dir)).sort()
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name
      const e = await entryAt(join(dir, name), rel)
      if (!e) continue
      out.set(rel, e)
      if (e.k === 'd') await walk(join(dir, name), rel)
    }
  }
  await walk(root, '')
  return out
}

/** Equal for sync purposes: kind, content or link target, and permission bits. */
export function sameEntry(a?: Entry, b?: Entry) {
  if (!a || !b) return a === b
  if (a.k !== b.k) return false
  if (a.k === 'l') return a.t === b.t
  if ((a.m & 0o777) !== (b.m & 0o777)) return false
  return a.k === 'd' || a.h === b.h
}

export function validPath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length < 4096 &&
    !p.startsWith('/') &&
    !p.includes('\0') &&
    p.split('/').every((c) => c !== '' && c !== '.' && c !== '..')
  )
}

function validEntry(e: Entry) {
  if (!validPath(e.p) || typeof e.m !== 'number') return false
  if (e.k === 'f') return typeof e.h === 'string' && /^[0-9a-f]{64}$/.test(e.h)
  if (e.k === 'l')
    return typeof e.t === 'string' && e.t.length > 0 && !e.t.includes('\0')
  return e.k === 'd'
}

/** Every ancestor of `rel` under root is a real directory (not a symlink). */
async function ancestorsAreDirectories(root: string, rel: string) {
  const parts = rel.split('/').slice(0, -1)
  let at = root
  for (const part of parts) {
    at = join(at, part)
    const st = await lstat(at).catch(() => null)
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return false
  }
  return true
}

const temp = (target: string) =>
  join(dirname(target), `.gild-sync-${randomBytes(6).toString('hex')}`)

export interface SyncOptions {
  /** Host directory the guest's copy came from. */
  root: string
  /** Where the guest sees it. */
  guestRoot: string
  files: GuestFiles
  /** Updated in place, so the next sync only carries newer changes. */
  baseline: Manifest
  /** Guest versions of conflicting files are saved here (outside the root). */
  conflictDir: string
  /** Refuse a sync that would copy more than this many bytes. */
  maxBytes?: number
}

export async function syncBack(o: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = {
    written: [],
    deleted: [],
    conflicts: [],
    rejected: [],
  }
  const guest: Manifest = new Map()
  for (const e of await o.files.list(o.guestRoot)) {
    // mke2fs puts lost+found at the root of the copy; it was never the user's.
    if (
      !o.baseline.has('lost+found') &&
      (e.p === 'lost+found' || e.p?.startsWith?.('lost+found/'))
    )
      continue
    if (!validEntry(e)) {
      result.rejected.push({
        path: String(e.p),
        reason: 'invalid entry from the guest',
      })
      continue
    }
    guest.set(e.p, e)
  }
  const changed = [...new Set([...o.baseline.keys(), ...guest.keys()])].filter(
    (p) => !sameEntry(o.baseline.get(p), guest.get(p)),
  )
  const bytes = changed.reduce((n, p) => {
    const e = guest.get(p)
    return n + (e?.k === 'f' ? (e.s ?? 0) : 0)
  }, 0)
  if (bytes > (o.maxBytes ?? 2 * 1024 ** 3))
    throw new Error(`sync would copy ${bytes} bytes; refusing`)
  // Deletions deepest first, then creations and updates parents first.
  const deletions = changed
    .filter((p) => !guest.has(p))
    .sort()
    .reverse()
  const updates = changed.filter((p) => guest.has(p)).sort()

  const conflict = async (rel: string, reason: string, after?: Entry) => {
    let saved: string | undefined
    if (after?.k === 'f') {
      saved = join(o.conflictDir, rel)
      await mkdir(dirname(saved), { recursive: true, mode: 0o700 })
      await writeFile(saved, await fetch(rel, after), { mode: 0o600 })
    }
    result.conflicts.push({ path: rel, reason, ...(saved ? { saved } : {}) })
  }
  const fetch = async (rel: string, after: Entry) => {
    const data = await o.files.read(`${o.guestRoot}/${rel}`)
    if (createHash('sha256').update(data).digest('hex') !== after.h)
      throw new Error('guest file changed while syncing')
    return data
  }
  const remove = async (path: string, e: Entry) =>
    e.k === 'd' ? rmdir(path) : unlink(path)

  for (const rel of [...deletions, ...updates]) {
    const before = o.baseline.get(rel),
      after = guest.get(rel),
      target = join(o.root, rel)
    try {
      if (!(await ancestorsAreDirectories(o.root, rel))) {
        await conflict(rel, 'a parent is not a directory on the host', after)
        setBaseline(o.baseline, rel, after)
        continue
      }
      const current = await entryAt(target, rel)
      if (sameEntry(current, after)) {
        setBaseline(o.baseline, rel, after)
        continue
      }
      if (!sameEntry(current, before)) {
        await conflict(rel, 'changed on the host and in the guest', after)
        setBaseline(o.baseline, rel, after)
        continue
      }
      if (!after) {
        await remove(target, current!)
        result.deleted.push(rel)
      } else if (after.k === 'd') {
        if (current?.k === 'd') await chmod(target, after.m & 0o777)
        else {
          if (current) await remove(target, current)
          await mkdir(target, { mode: after.m & 0o777 })
          await chmod(target, after.m & 0o777)
        }
        result.written.push(rel)
      } else if (
        after.k === 'f' &&
        current?.k === 'f' &&
        current.h === after.h
      ) {
        await chmod(target, after.m & 0o777) // mode-only change
        result.written.push(rel)
      } else {
        // Write a fresh name next to the target, then rename over it: rename
        // replaces a symlink itself, never what it points to.
        const t = temp(target)
        if (after.k === 'f') {
          await writeFile(t, await fetch(rel, after), {
            flag: 'wx',
            mode: 0o600,
          })
          await chmod(t, after.m & 0o777)
        } else await symlink(after.t!, t)
        if (current?.k === 'd') await rmdir(target)
        await rename(t, target)
        result.written.push(rel)
      }
      setBaseline(o.baseline, rel, after)
    } catch (e) {
      result.conflicts.push({
        path: rel,
        reason: `not applied: ${(e as Error).message}`,
      })
    }
  }
  return result
}

function setBaseline(m: Manifest, rel: string, e?: Entry) {
  if (e) m.set(rel, e)
  else m.delete(rel)
}

export function describeSync(r: SyncResult) {
  const parts = [
    `${r.written.length} written`,
    `${r.deleted.length} deleted`,
    `${r.conflicts.length} conflicts`,
  ]
  if (r.rejected.length) parts.push(`${r.rejected.length} rejected`)
  return parts.join(', ')
}
