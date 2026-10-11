// All sync mutations are relative to opened directories. Pathname checks alone
// cannot protect a later write when a directory is replaced during guest I/O.
import { createRequire } from 'node:module'
const requireNative = createRequire(import.meta.url)
const ffi = () => requireNative('bun:ffi') as typeof import('bun:ffi')
const ptr = (buffer: Buffer) => ffi().ptr(buffer)
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import type { Entry } from './session'

const CLOEXEC = process.platform === 'darwin' ? 0x1000000 : 0x80000

function native() {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('anchored VM sync is supported only on macOS and Linux')
  const errnoSymbol =
    process.platform === 'darwin' ? '__error' : '__errno_location'
  const statSymbol =
    process.platform === 'darwin' && process.arch === 'x64'
      ? 'fstatat$INODE64'
      : 'fstatat'
  const lib = ffi().dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    {
      openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' },
      mkdirat: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
      unlinkat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
      renameat: { args: ['i32', 'ptr', 'i32', 'ptr'], returns: 'i32' },
      linkat: { args: ['i32', 'ptr', 'i32', 'ptr', 'i32'], returns: 'i32' },
      symlinkat: { args: ['ptr', 'i32', 'ptr'], returns: 'i32' },
      readlinkat: { args: ['i32', 'ptr', 'ptr', 'u64'], returns: 'i64' },
      [statSymbol]: { args: ['i32', 'ptr', 'ptr', 'i32'], returns: 'i32' },
      [errnoSymbol]: { args: [], returns: 'ptr' },
    } as const,
  )
  return {
    ...lib.symbols,
    metadata: lib.symbols[statSymbol],
    errno: () =>
      new Int32Array(
        ffi().toArrayBuffer(lib.symbols[errnoSymbol]()! as number, 0, 4),
      )[0],
  }
}
let api: ReturnType<typeof native> | undefined
const sys = () => (api ??= native())
const cstr = (s: string) => Buffer.from(s + '\0')
const check = (n: number | bigint, op: string) => {
  if (n < 0) throw new Error(`${op} failed (errno ${sys().errno()})`)
  return Number(n)
}

export class AnchoredDirectory {
  constructor(readonly fd: number) {}
  static open(path: string) {
    return new AnchoredDirectory(
      openSync(
        path,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          CLOEXEC,
      ),
    )
  }
  close() {
    closeSync(this.fd)
  }
  directory(name: string, create = false) {
    const p = cstr(name)
    if (create) {
      const r = sys().mkdirat(this.fd, ptr(p), 0o700)
      if (r < 0 && sys().errno() !== 17) check(r, 'mkdirat') // EEXIST
    }
    const fd = check(
      sys().openat(
        this.fd,
        ptr(p),
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          CLOEXEC,
        0,
      ),
      'openat directory',
    )
    return new AnchoredDirectory(fd)
  }
  parent(rel: string, create = false) {
    let at: AnchoredDirectory = this
    try {
      for (const part of rel.split('/').slice(0, -1)) {
        const next = at.directory(part, create)
        if (at !== this) at.close()
        at = next
      }
      return at
    } catch (e) {
      if (at !== this) at.close()
      throw e
    }
  }
  private entryMode(name: string): number | undefined {
    const p = cstr(name)
    // Inspect without opening a FIFO/device/socket. The stat ABI is fixed for
    // the supported 64-bit platforms; only mode is read from an oversized buffer.
    if (!['x64', 'arm64'].includes(process.arch))
      throw new Error('anchored sync metadata requires x64 or arm64')
    const info = Buffer.alloc(256)
    const status = Number(
      sys().metadata(
        this.fd,
        ptr(p),
        ptr(info),
        process.platform === 'darwin' ? 0x20 : 0x100, // AT_SYMLINK_NOFOLLOW
      ),
    )
    if (status < 0 && sys().errno() === 2) return undefined
    check(status, 'fstatat entry')
    return process.platform === 'darwin'
      ? info.readUInt16LE(4)
      : info.readUInt32LE(process.arch === 'x64' ? 24 : 16)
  }
  /** Bounded bytes from a regular, unlinked-to-other-paths file, never a symlink. */
  readRegular(name: string, maxBytes: number): Buffer {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error('invalid anchored file read bound')
    const mode = this.entryMode(name)
    if (mode === undefined)
      throw Object.assign(new Error('anchored file is missing'), {
        code: 'ENOENT',
      })
    if ((mode & constants.S_IFMT) !== constants.S_IFREG)
      throw new Error('anchored entry is not a regular file')
    const p = cstr(name)
    const fd = check(
      sys().openat(
        this.fd,
        ptr(p),
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          CLOEXEC,
        0,
      ),
      'openat read',
    )
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.nlink !== 1)
        throw new Error('anchored file type or link count is unsafe')
      if (st.size > maxBytes)
        throw new Error('anchored file exceeds read bound')
      const data = Buffer.alloc(maxBytes + 1)
      let length = 0,
        n: number
      while (
        length <= maxBytes &&
        (n = readSync(fd, data, length, data.length - length, null)) > 0
      )
        length += n
      if (length > maxBytes)
        throw new Error('anchored file grew beyond read bound')
      return Buffer.from(data.subarray(0, length))
    } finally {
      closeSync(fd)
    }
  }
  /** Publish complete private bytes without replacing any existing destination. */
  putRegularIfAbsent(name: string, data: Buffer): boolean {
    const temp = cstr(`.gild-bytes-${randomBytes(12).toString('hex')}`),
      dest = cstr(name)
    const fd = check(
      sys().openat(
        this.fd,
        ptr(temp),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          CLOEXEC,
        0o600,
      ),
      'openat bytes',
    )
    try {
      try {
        writeFileSync(fd, data)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const status = sys().linkat(this.fd, ptr(temp), this.fd, ptr(dest), 0)
      if (status < 0 && sys().errno() === 17) return false
      check(status, 'linkat bytes')
      fsyncSync(this.fd)
      return true
    } finally {
      check(sys().unlinkat(this.fd, ptr(temp), 0), 'unlinkat bytes')
    }
  }
  entry(name: string, rel: string, skipUnsupported = false): Entry | undefined {
    const p = cstr(name),
      link = Buffer.alloc(4096)
    const mode = this.entryMode(name)
    if (mode === undefined) return undefined
    if (
      ![constants.S_IFREG, constants.S_IFDIR, constants.S_IFLNK].includes(
        mode & constants.S_IFMT,
      )
    ) {
      if (skipUnsupported) return undefined
      throw new Error('unsupported host file type')
    }
    const n = Number(sys().readlinkat(this.fd, ptr(p), ptr(link), link.length))
    if (n >= 0) {
      if (n === link.length) throw new Error('link target exceeds sync limit')
      return { p: rel, k: 'l', m: 0, t: link.subarray(0, n).toString() }
    }
    const fd = sys().openat(
      this.fd,
      ptr(p),
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        CLOEXEC,
      0,
    )
    if (fd < 0 && sys().errno() === 2) return undefined // ENOENT only
    check(fd, 'openat entry')
    try {
      const st = fstatSync(fd)
      if (st.isDirectory()) return { p: rel, k: 'd', m: st.mode & 0o7777 }
      if (!st.isFile()) throw new Error('unsupported host file type')
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(64 * 1024)
      let n: number
      while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, n))
      return {
        p: rel,
        k: 'f',
        m: st.mode & 0o7777,
        s: st.size,
        h: hash.digest('hex'),
      }
    } finally {
      closeSync(fd)
    }
  }
  remove(name: string, directory: boolean) {
    const p = cstr(name)
    check(
      sys().unlinkat(
        this.fd,
        ptr(p),
        directory ? (process.platform === 'darwin' ? 0x80 : 0x200) : 0,
      ),
      'unlinkat',
    )
  }
  mode(name: string, mode: number, directory: boolean) {
    const p = cstr(name)
    const fd = check(
      sys().openat(
        this.fd,
        ptr(p),
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          CLOEXEC |
          (directory ? constants.O_DIRECTORY : constants.O_NONBLOCK),
        0,
      ),
      'openat mode',
    )
    try {
      if (!(directory ? fstatSync(fd).isDirectory() : fstatSync(fd).isFile()))
        throw new Error('host file type changed')
      fchmodSync(fd, mode)
    } finally {
      closeSync(fd)
    }
  }
  put(name: string, e: Entry, data?: Buffer, replaceDirectory = false) {
    const temp = cstr(`.gild-sync-${randomBytes(12).toString('hex')}`),
      dest = cstr(name)
    let made = false
    try {
      if (e.k === 'f') {
        const fd = check(
          sys().openat(
            this.fd,
            ptr(temp),
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW |
              CLOEXEC,
            0o600,
          ),
          'openat temp',
        )
        made = true
        try {
          writeFileSync(fd, data!)
          fchmodSync(fd, e.m & 0o777)
        } finally {
          closeSync(fd)
        }
      } else {
        const target = cstr(e.t!)
        check(sys().symlinkat(ptr(target), this.fd, ptr(temp)), 'symlinkat')
        made = true
      }
      if (replaceDirectory) this.remove(name, true)
      check(sys().renameat(this.fd, ptr(temp), this.fd, ptr(dest)), 'renameat')
      made = false
    } finally {
      if (made) sys().unlinkat(this.fd, ptr(temp), 0)
    }
  }
}
