// Builds the microVM guest image from this checkout and installs it where the
// CLI looks (<config dir>/vm/, see vmImagePaths). One command, no root:
//   bun run vm:image [--config-dir <dir>]
// Needs Docker with BuildKit (rootfs) and network access (pinned downloads).
// The kernel is Firecracker's CI build, pinned by sha256; the rootfs is
// guest-agent/image/Dockerfile, which compiles the guest agent from this
// checkout, so the image always speaks this checkout's protocol.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { vmImagePaths } from '../src/isolation'
import { GUEST_PROTOCOL } from '../src/isolation/session'
import {
  buildFirecrackerRootfs,
  fetchFirecrackerKernel,
  KERNEL,
} from './vm-release'

const ROOT = resolve(import.meta.dir, '..')

function arg(name: string) {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const configDir = resolve(
  arg('--config-dir') ?? join(homedir(), '.config', 'gild'),
)
const paths = vmImagePaths(configDir)
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex')
function fail(message: string): never {
  console.error(`vm:image: ${message}`)
  process.exit(1)
}

if (process.platform !== 'linux' || process.arch !== 'x64')
  fail('the Firecracker guest image is x86_64 Linux; build it on that host')
await mkdir(join(configDir, 'vm'), { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(configDir, 'vm', '.build-'))
try {
  // Kernel: download once, verify every time; the same functions build the published image.
  await fetchFirecrackerKernel(paths.kernel)
  // Rootfs: docker build straight to a file, then swap it in atomically.
  try {
    buildFirecrackerRootfs(work)
  } catch (e) {
    fail((e as Error).message)
  }
  await rename(join(work, 'rootfs.ext4'), paths.rootfs)

  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim()
  const manifest = {
    protocol: GUEST_PROTOCOL,
    agent: /^version = "(.+)"$/m.exec(
      readFileSync(join(ROOT, 'guest-agent/Cargo.toml'), 'utf8'),
    )?.[1],
    commit,
    kernel: { path: paths.kernel, sha256: KERNEL.sha256, url: KERNEL.url },
    rootfs: {
      path: paths.rootfs,
      sha256: sha256(await readFile(paths.rootfs)),
    },
    built: new Date().toISOString(),
  }
  await writeFile(
    join(configDir, 'vm', 'image.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )

  // isolation.json: enable `vm` with the default paths unless the owner set it up already.
  const isolation = join(configDir, 'isolation.json')
  const current = existsSync(isolation)
    ? JSON.parse(await readFile(isolation, 'utf8'))
    : {}
  if (!current.vm) {
    current.vm = {}
    await writeFile(isolation, JSON.stringify(current, null, 2) + '\n')
    console.error(`vm:image: enabled vm in ${isolation}`)
  } else
    for (const key of ['kernel', 'rootfs'] as const)
      if (current.vm[key] && resolve(current.vm[key]) !== paths[key])
        console.error(
          `vm:image: note: ${isolation} sets vm.${key} to ${current.vm[key]}; remove it to use ${paths[key]}`,
        )
  console.log(JSON.stringify(manifest, null, 2))
} finally {
  await rm(work, { recursive: true, force: true })
}
