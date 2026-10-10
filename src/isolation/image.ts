// The published microVM guest image: built by the release workflow for each
// VM platform, uploaded next to the CLI binaries on releases.gild.gg, and
// fetched here on first VM use into <config dir>/vm/, so `gild spawn --vm` and
// `gild runner start --isolation vm` work right after `npm i -g gildforge`.
//
// Layout of one release (scripts/vm-release.ts writes it):
//   cli/v<version>/vm/manifest.json            VmManifest (sha256 of every file)
//   cli/v<version>/vm/<platform>/<name>.gz     one gzip per role
// Every file is checked against the manifest's sha256 (compressed and
// unpacked) before it replaces anything; the manifest itself must name this
// CLI's version and guest protocol. At boot the guest agent handshake
// (session.ts checkGuestProtocol) checks the protocol once more.
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { z } from 'zod'
import pkg from '../../package.json'
import { GUEST_PROTOCOL } from './session'

/** Where release binaries and guest images live. */
export const RELEASES = 'https://releases.gild.gg/cli'
export const GILD_VERSION: string = pkg.version

/** Where the guest kernel, rootfs and (macOS) vz helper live, published or
 *  built by `bun run vm:image`; `vm` uses them when isolation.json names no
 *  other files. */
export function vmImagePaths(configDir: string) {
  const dir = join(configDir, 'vm')
  return {
    dir,
    kernel: join(dir, 'vmlinux'),
    rootfs: join(dir, 'rootfs.ext4'),
    vz: join(dir, 'gild-vz'),
    record: join(dir, 'image.json'),
  }
}

/** The VM platforms a release publishes, and the file each role is built as. */
export const VM_PLATFORMS = {
  'linux-x64': { kernel: 'vmlinux', rootfs: 'rootfs.ext4' },
  'darwin-arm64': { kernel: 'Image', rootfs: 'rootfs.ext4', vz: 'gild-vz' },
} as const
export type VmPlatform = keyof typeof VM_PLATFORMS
export type VmRole = 'kernel' | 'rootfs' | 'vz'

export const vmPlatform = (
  platform: string = process.platform,
  arch: string = process.arch,
): VmPlatform | undefined =>
  `${platform}-${arch}` in VM_PLATFORMS
    ? (`${platform}-${arch}` as VmPlatform)
    : undefined

const hex = z.string().regex(/^[0-9a-f]{64}$/)
const size = z.number().int().nonnegative()
const entry = z.object({
  /** Relative to the manifest: `<platform>/<name>.gz`. */
  file: z.string().regex(/^(linux-x64|darwin-arm64)\/[A-Za-z0-9._-]+\.gz$/),
  sha256: hex,
  size,
  unpacked: z.object({ sha256: hex, size }),
})
export type VmFileEntry = z.infer<typeof entry>
export const vmManifestSchema = z.object({
  version: z.string(),
  protocol: z.number().int(),
  commit: z.string(),
  platforms: z.object({
    'linux-x64': z.object({ kernel: entry, rootfs: entry }).optional(),
    'darwin-arm64': z
      .object({ kernel: entry, rootfs: entry, vz: entry })
      .optional(),
  }),
})
export type VmManifest = z.infer<typeof vmManifestSchema>

/** <config dir>/vm/image.json for a published image (`bun run vm:image` writes its own shape). */
const recordSchema = z.object({
  source: z.literal('release'),
  version: z.string(),
  platform: z.string(),
  protocol: z.number().int(),
  commit: z.string(),
  files: z.record(z.string(), z.object({ sha256: hex, size })),
})
type ImageRecord = z.infer<typeof recordSchema>

export class VmImageError extends Error {}

/** What the next tier hint says when no image could be fetched. */
export const VM_IMAGE_FALLBACK_HINT =
  'connect and retry, build the image yourself (docs/VM.md), or use --isolation container|host'

function readRecord(configDir: string): ImageRecord | 'local' | undefined {
  const path = vmImagePaths(configDir).record
  if (!existsSync(path)) return undefined
  try {
    const parsed = recordSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')),
    )
    return parsed.success ? parsed.data : 'local'
  } catch {
    return 'local'
  }
}

const rolesOf = (platform: VmPlatform) =>
  Object.keys(VM_PLATFORMS[platform]) as VmRole[]

/** The published image for this CLI version and platform is installed and intact (cheap: sizes). */
export function releaseImageInstalled(
  configDir: string,
  version = GILD_VERSION,
  platform = vmPlatform(),
): boolean {
  const record = readRecord(configDir)
  if (!platform || !record || record === 'local') return false
  if (
    record.version !== version ||
    record.platform !== platform ||
    record.protocol !== GUEST_PROTOCOL
  )
    return false
  const paths = vmImagePaths(configDir)
  return rolesOf(platform).every((role) => {
    try {
      return statSync(paths[role]).size === record.files[role]?.size
    } catch {
      return false
    }
  })
}

/** `bun run vm:image` (or another hand build) owns <config dir>/vm: never overwrite it. */
export const localImageInstalled = (configDir: string) =>
  readRecord(configDir) === 'local'

export interface EnsureOptions {
  configDir: string
  version?: string
  platform?: VmPlatform
  /** The release root (cli/ on the bucket); tests point it at a fake. */
  base?: string
  log?: (line: string) => void
}

/**
 * Make sure <config dir>/vm holds the published guest image for this gild
 * version and platform: nothing to do when it is already there (offline is
 * fine), otherwise download, verify and install it. Throws VmImageError with
 * the reason and the fallback when it cannot.
 */
export async function ensureVmImage(
  o: EnsureOptions,
): Promise<'installed' | 'downloaded' | 'local'> {
  const version = o.version ?? GILD_VERSION,
    platform = o.platform ?? vmPlatform(),
    base = o.base ?? RELEASES,
    log = o.log ?? (() => {})
  if (!platform)
    throw new VmImageError(
      `no VM image is published for ${process.platform}-${process.arch} (published: ${Object.keys(VM_PLATFORMS).join(', ')})`,
    )
  if (localImageInstalled(o.configDir)) return 'local'
  if (releaseImageInstalled(o.configDir, version, platform)) return 'installed'

  const url = `${base}/v${version}/vm/manifest.json`
  const offline = (why: string) =>
    new VmImageError(
      `could not fetch the VM image for gild ${version} (${platform}) from ${url}: ${why}; ${VM_IMAGE_FALLBACK_HINT}`,
    )
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw offline((e as Error).message)
  }
  if (!res.ok)
    throw offline(
      res.status === 404
        ? `HTTP 404, no image was published for this version`
        : `HTTP ${res.status}`,
    )
  let manifest: VmManifest
  try {
    manifest = vmManifestSchema.parse(await res.json())
  } catch (e) {
    throw new VmImageError(
      `the VM image manifest ${url} is malformed: ${(e as Error).message}`,
    )
  }
  if (manifest.version !== version)
    throw new VmImageError(
      `refusing the VM image manifest ${url}: it is for gild ${manifest.version}, this is gild ${version}`,
    )
  if (manifest.protocol !== GUEST_PROTOCOL)
    throw new VmImageError(
      `refusing the VM image manifest ${url}: its guest agent speaks protocol ${manifest.protocol}, this gild speaks ${GUEST_PROTOCOL}`,
    )
  const files = manifest.platforms[platform] as
    Partial<Record<VmRole, VmFileEntry>> | undefined
  const roles = rolesOf(platform)
  if (!files || roles.some((r) => !files[r]))
    throw new VmImageError(
      `the VM image manifest ${url} has no complete ${platform} image`,
    )

  const paths = vmImagePaths(o.configDir)
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  const stage = await mkdtemp(join(paths.dir, '.download-'))
  try {
    const total = roles.reduce((n, r) => n + files[r]!.size, 0)
    log(
      `downloading the VM image for gild ${version} (${platform}, ${mb(total)}) into ${paths.dir}`,
    )
    for (const role of roles)
      await download(
        `${base}/v${version}/vm/${files[role]!.file}`,
        files[role]!,
        join(stage, role),
        role,
        log,
      )
    for (const role of roles) {
      await chmod(join(stage, role), role === 'vz' ? 0o755 : 0o644)
      await rename(join(stage, role), paths[role])
    }
    const record: ImageRecord = {
      source: 'release',
      version,
      platform,
      protocol: manifest.protocol,
      commit: manifest.commit,
      files: Object.fromEntries(roles.map((r) => [r, files[r]!.unpacked])),
    }
    // Written last: an interrupted download leaves no record, so it is retried.
    await writeFile(paths.record, JSON.stringify(record, null, 2) + '\n')
    log(`VM image for gild ${version} verified and installed`)
    return 'downloaded'
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`

function hashing(onBytes?: (n: number) => void) {
  const hash = createHash('sha256')
  let bytes = 0
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk)
      bytes += chunk.length
      onBytes?.(bytes)
      done(null, chunk)
    },
  })
  return { tap, digest: () => hash.digest('hex'), bytes: () => bytes }
}

async function download(
  url: string,
  want: VmFileEntry,
  to: string,
  role: VmRole,
  log: (line: string) => void,
) {
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw new VmImageError(
      `could not fetch ${url}: ${(e as Error).message}; ${VM_IMAGE_FALLBACK_HINT}`,
    )
  }
  if (!res.ok || !res.body)
    throw new VmImageError(`could not fetch ${url}: HTTP ${res.status}`)
  let shown = -1
  const packed = hashing((n) => {
    const pct = Math.floor((n / Math.max(want.size, 1)) * 10) * 10
    if (pct > shown && want.size > 0) {
      shown = pct
      log(`  ${role}: ${mb(n)} / ${mb(want.size)} (${Math.min(pct, 100)}%)`)
    }
  })
  const unpacked = hashing()
  try {
    await pipeline(
      Readable.fromWeb(res.body as never),
      packed.tap,
      createGunzip(),
      unpacked.tap,
      createWriteStream(to, { mode: 0o600 }),
    )
  } catch (e) {
    throw new VmImageError(`${url}: ${(e as Error).message}`)
  }
  const got = packed.digest()
  if (got !== want.sha256 || packed.bytes() !== want.size)
    throw new VmImageError(
      `refusing ${url}: sha256 ${got} (${packed.bytes()} bytes) is not the manifest's ${want.sha256} (${want.size} bytes)`,
    )
  const gotUnpacked = unpacked.digest()
  if (
    gotUnpacked !== want.unpacked.sha256 ||
    unpacked.bytes() !== want.unpacked.size
  )
    throw new VmImageError(
      `refusing ${url}: unpacked sha256 ${gotUnpacked} is not the manifest's ${want.unpacked.sha256}`,
    )
}
