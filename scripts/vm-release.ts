// The published microVM guest image (src/isolation/image.ts reads it).
// The release workflow builds each platform on its own runner, gzips the
// files, and the publish job writes the manifest next to them:
//
//   bun scripts/vm-release.ts build linux-x64 <out>     vmlinux, rootfs.ext4 (x86_64 Linux + Docker BuildKit)
//   bun scripts/vm-release.ts build darwin-arm64 <out>  Image, rootfs.ext4 (arm64 Linux + Docker; scripts/build-vm-guest.sh)
//   scripts/build-vz-helper.sh <out>/gild-vz            the signed vz helper (macOS)
//   gzip -n <out>/*                                     what is uploaded
//   bun scripts/vm-release.ts manifest <vm dir>         <vm dir>/manifest.json from <vm dir>/<platform>/*.gz
//
// `bun run vm:image` (scripts/build-vm-image.ts) builds the linux-x64 image
// with the same functions for a local install.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import pkg from '../package.json'
import KERNEL from '../guest-agent/firecracker-kernel.json'
import {
  VM_PLATFORMS,
  vmManifestSchema,
  type VmFileEntry,
  type VmManifest,
  type VmPlatform,
} from '../src/isolation/image'
import { GUEST_PROTOCOL } from '../src/isolation/session'

export { KERNEL }
const ROOT = resolve(import.meta.dir, '..')
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex')

function run(argv: string[], env: Record<string, string> = {}) {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (r.status !== 0)
    throw new Error(`${argv.join(' ')} exited ${r.status ?? r.signal}`)
}

/** Firecracker's CI kernel, checked against the pinned sha256; kept when `to` already matches. */
export async function fetchFirecrackerKernel(to: string) {
  if (existsSync(to) && sha256(await readFile(to)) === KERNEL.sha256) return
  console.error(`vm: kernel ${KERNEL.url}`)
  const res = await fetch(KERNEL.url)
  if (!res.ok) throw new Error(`kernel download: HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (sha256(bytes) !== KERNEL.sha256)
    throw new Error(
      `kernel sha256 ${sha256(bytes)} is not the pinned ${KERNEL.sha256}`,
    )
  await writeFile(`${to}.part`, bytes, { mode: 0o644 })
  await rename(`${to}.part`, to)
}

/** guest-agent/image/Dockerfile (guest agent from this checkout) as `<dir>/rootfs.ext4`. */
export function buildFirecrackerRootfs(dir: string) {
  console.error('vm: building the rootfs (guest-agent/image/Dockerfile)')
  run(
    [
      'docker',
      'buildx',
      'build',
      '--file',
      join(ROOT, 'guest-agent/image/Dockerfile'),
      '--output',
      `type=local,dest=${dir}`,
      ROOT,
    ],
    { DOCKER_BUILDKIT: '1' },
  )
  if (!existsSync(join(dir, 'rootfs.ext4')))
    throw new Error('the build produced no rootfs.ext4')
}

async function build(platform: VmPlatform, out: string) {
  await mkdir(out, { recursive: true })
  if (platform === 'linux-x64') {
    if (process.arch !== 'x64' || process.platform !== 'linux')
      throw new Error('the linux-x64 image builds on x86_64 Linux')
    await fetchFirecrackerKernel(join(out, 'vmlinux'))
    buildFirecrackerRootfs(out)
    return
  }
  // arm64 Linux docker host: build-vm-guest.sh makes rootfs.ext4 and the vz kernel `Image`.
  const work = join(out, '.guest')
  run(['sh', join(ROOT, 'scripts/build-vm-guest.sh'), work])
  for (const name of ['Image', 'rootfs.ext4']) {
    if (!existsSync(join(work, name)))
      throw new Error(`build-vm-guest.sh produced no ${name}`)
    await rename(join(work, name), join(out, name))
  }
}

async function digest(path: string): Promise<VmFileEntry> {
  const packed = createHash('sha256'),
    unpacked = createHash('sha256')
  let unpackedSize = 0
  const tap = (hash: ReturnType<typeof createHash>, count?: true) =>
    new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk)
        if (count) unpackedSize += chunk.length
        done(null, chunk)
      },
    })
  const sink = new Transform({ transform: (_c, _e, done) => done() })
  sink.resume()
  await pipeline(
    createReadStream(path),
    tap(packed),
    createGunzip(),
    tap(unpacked, true),
    sink,
  )
  return {
    file: '',
    sha256: packed.digest('hex'),
    size: (await stat(path)).size,
    unpacked: { sha256: unpacked.digest('hex'), size: unpackedSize },
  }
}

/** `<dir>/manifest.json` for every complete platform under `<dir>`; refuses a partial one. */
export async function writeVmManifest(
  dir: string,
  o: { version?: string; commit?: string; require?: VmPlatform[] } = {},
): Promise<VmManifest> {
  const platforms: Record<string, Record<string, VmFileEntry>> = {}
  for (const [platform, roles] of Object.entries(VM_PLATFORMS)) {
    if (!existsSync(join(dir, platform))) {
      if (o.require?.includes(platform as VmPlatform))
        throw new Error(`no ${platform} image under ${dir}`)
      continue
    }
    platforms[platform] = {}
    for (const [role, name] of Object.entries(roles)) {
      const file = `${platform}/${name}.gz`
      if (!existsSync(join(dir, file)))
        throw new Error(`${platform} image is missing ${file}`)
      platforms[platform][role] = { ...(await digest(join(dir, file))), file }
    }
  }
  const manifest = vmManifestSchema.parse({
    version: o.version ?? pkg.version,
    protocol: GUEST_PROTOCOL,
    commit:
      o.commit ??
      spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).stdout.trim(),
    platforms,
  })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  return manifest
}

if (import.meta.main) {
  const [command, a, b] = process.argv.slice(2)
  try {
    if (command === 'build' && a && b && a in VM_PLATFORMS)
      await build(a as VmPlatform, resolve(b))
    else if (command === 'manifest' && a)
      console.log(
        JSON.stringify(
          await writeVmManifest(resolve(a), {
            require: Object.keys(VM_PLATFORMS) as VmPlatform[],
          }),
          null,
          2,
        ),
      )
    else
      throw new Error(
        'usage: vm-release.ts build <linux-x64|darwin-arm64> <out> | manifest <vm dir>',
      )
  } catch (e) {
    console.error(`vm-release: ${(e as Error).message}`)
    process.exit(1)
  }
}
