// First VM use fetches the published guest image from the release bucket.
// A fake bucket (Bun.serve) holds a release laid out exactly as the release
// workflow uploads it, with the manifest written by the same function.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { writeVmManifest } from '../../scripts/vm-release'
import {
  ensureVmImage,
  GILD_VERSION,
  VM_PLATFORMS,
  vmImagePaths,
  vmPlatform,
  type VmPlatform,
} from './image'
import {
  assertCanIsolate,
  describe as describeIsolation,
  prepareVm,
  resolveForHost,
  type HostConfig,
  type Probes,
} from './index'
import { GUEST_PROTOCOL } from './session'

const platform: VmPlatform = vmPlatform() ?? 'linux-x64'
const roles = VM_PLATFORMS[platform] as Record<string, string>
const contents: Record<string, Buffer> = Object.fromEntries(
  Object.keys(roles).map((role) => [
    role,
    Buffer.from(`${role} bytes for ${platform} `.repeat(40_000)),
  ]),
)

let root: string
/** Releases on the fake bucket, by tag; each is `<tag>/vm/...`. */
const releases = new Map<string, Map<string, Buffer>>()
let requests: string[] = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname.slice(1)
    requests.push(path)
    const [tag, ...rest] = path.split('/')
    const body = releases.get(tag!)?.get(rest.join('/'))
    return body
      ? new Response(new Blob([new Uint8Array(body)]))
      : new Response('no', { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`
const offline = 'http://127.0.0.1:9' // discard port: connection refused

/** Lay a release out like the workflow does, then let the test tamper with it. */
async function publish(
  tag: string,
  tamper: (dir: string) => Promise<void> = async () => {},
  manifest: { version?: string } = {},
) {
  const dir = join(root, 'bucket', tag)
  await mkdir(join(dir, platform), { recursive: true })
  for (const [role, name] of Object.entries(roles))
    await writeFile(
      join(dir, platform, `${name}.gz`),
      gzipSync(contents[role]!),
    )
  await writeVmManifest(dir, { commit: 'abc123', ...manifest })
  await tamper(dir)
  const files = new Map<string, Buffer>()
  files.set('vm/manifest.json', await readFile(join(dir, 'manifest.json')))
  for (const name of Object.values(roles))
    files.set(
      `vm/${platform}/${name}.gz`,
      await readFile(join(dir, platform, `${name}.gz`)),
    )
  releases.set(tag, files)
}

const configDir = async () => {
  await mkdir(join(root, 'config'), { recursive: true })
  return mkdtemp(join(root, 'config', 'c-'))
}

beforeAll(async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  root = await mkdtemp(resolve('.tmp/vm-image-'))
})
afterAll(() => server.stop(true))

describe('published VM image', () => {
  test('first use downloads, verifies and installs it; later uses stay offline', async () => {
    await publish(`v${GILD_VERSION}`)
    const dir = await configDir()
    const lines: string[] = []
    requests = []
    expect(
      await ensureVmImage({
        configDir: dir,
        base,
        platform,
        log: (l) => lines.push(l),
      }),
    ).toBe('downloaded')
    const paths = vmImagePaths(dir)
    for (const role of Object.keys(roles))
      expect(
        (await readFile(paths[role as 'kernel' | 'rootfs' | 'vz'])).equals(
          contents[role]!,
        ),
      ).toBe(true)
    expect(requests[0]).toBe(`v${GILD_VERSION}/vm/manifest.json`)
    expect(lines.join('\n')).toMatch(/downloading the VM image .*%/s)
    const record = JSON.parse(await readFile(paths.record, 'utf8'))
    expect(record).toMatchObject({
      source: 'release',
      version: GILD_VERSION,
      platform,
      protocol: GUEST_PROTOCOL,
    })
    // Cached: no request at all, even with the bucket unreachable.
    requests = []
    expect(
      await ensureVmImage({ configDir: dir, base: offline, platform }),
    ).toBe('installed')
    expect(requests).toEqual([])
  })

  test('works offline when cached: --vm gets the installed image with no network', async () => {
    await publish(`v${GILD_VERSION}`)
    const dir = await configDir()
    await ensureVmImage({ configDir: dir, base, platform })
    const { host, vmUnavailable } = await prepareVm(dir, {
      want: true,
      base: offline,
      platform,
      backendReady: () => true,
    })
    expect(vmUnavailable).toBeUndefined()
    expect(host.vm).toMatchObject({
      kernel: vmImagePaths(dir).kernel,
      rootfs: vmImagePaths(dir).rootfs,
    })
    if (platform === 'darwin-arm64')
      expect(host.vm!.vz).toBe(vmImagePaths(dir).vz)
  })

  test('a file whose sha256 is not the manifest one is refused and nothing is installed', async () => {
    // Same unpacked bytes, different gzip stream: only the published sha256 can tell.
    await publish(`v${GILD_VERSION}`, async (dir) => {
      const name = roles.rootfs
      await writeFile(
        join(dir, platform, `${name}.gz`),
        gzipSync(contents.rootfs!, { level: 1 }),
      )
    })
    const dir = await configDir()
    await expect(
      ensureVmImage({ configDir: dir, base, platform }),
    ).rejects.toThrow(/refusing .*rootfs\.ext4\.gz: sha256/)
    expect(existsSync(vmImagePaths(dir).rootfs)).toBe(false)
    expect(existsSync(vmImagePaths(dir).record)).toBe(false)
  })

  test('different unpacked bytes are refused too (the gunzipped file is checked as well)', async () => {
    await publish(`v${GILD_VERSION}`, async (dir) => {
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
      m.platforms[platform].kernel.unpacked.sha256 = '0'.repeat(64)
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(m))
    })
    const dir = await configDir()
    await expect(
      ensureVmImage({ configDir: dir, base, platform }),
    ).rejects.toThrow(/refusing .*unpacked sha256/)
    expect(existsSync(vmImagePaths(dir).kernel)).toBe(false)
  })

  test('a manifest for another gild version is refused', async () => {
    await publish(`v${GILD_VERSION}`, undefined, { version: '0.0.1' })
    const dir = await configDir()
    await expect(
      ensureVmImage({ configDir: dir, base, platform }),
    ).rejects.toThrow(/is for gild 0\.0\.1, this is gild/)
    expect(existsSync(vmImagePaths(dir).record)).toBe(false)
  })

  test('a manifest for another guest protocol is refused', async () => {
    await publish(`v${GILD_VERSION}`, async (dir) => {
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
      m.protocol = GUEST_PROTOCOL + 1
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(m))
    })
    const dir = await configDir()
    await expect(
      ensureVmImage({ configDir: dir, base, platform }),
    ).rejects.toThrow(/speaks protocol \d+, this gild speaks/)
  })

  test('an installed image for an older gild is replaced by this version', async () => {
    await publish('v0.0.1', undefined, { version: '0.0.1' })
    await publish(`v${GILD_VERSION}`)
    const dir = await configDir()
    await ensureVmImage({ configDir: dir, base, platform, version: '0.0.1' })
    expect(await ensureVmImage({ configDir: dir, base, platform })).toBe(
      'downloaded',
    )
  })

  test('a hand-built image (bun run vm:image) is never overwritten', async () => {
    const dir = await configDir()
    await mkdir(join(dir, 'vm'), { recursive: true })
    await writeFile(vmImagePaths(dir).record, '{"protocol":2,"commit":"x"}')
    requests = []
    expect(await ensureVmImage({ configDir: dir, base, platform })).toBe(
      'local',
    )
    expect(requests).toEqual([])
  })
})

describe('no image can be fetched', () => {
  const containerHost: HostConfig = {
    container: {
      engine: 'docker',
      image: 'ubuntu:24.04',
      agent: '/a',
      memory: '2g',
      cpus: '2',
      pids: 512,
      egress: 'auto',
    },
  }
  const machine = (oci: boolean): Probes => ({
    platform: 'linux',
    vm: () => false,
    oci: () => oci,
    colima: () => ({ running: false, reason: 'off', fix: 'colima start' }),
    hostUser: () => ({ ok: false, reason: 'no', fix: 'no' }),
  })

  test('offline with nothing cached: a clear error with the fallback', async () => {
    const dir = await configDir()
    const { host, vmUnavailable } = await prepareVm(dir, {
      want: true,
      base: offline,
      platform,
      backendReady: () => true,
    })
    expect(host.vm).toBeUndefined()
    expect(vmUnavailable).toMatch(
      /could not fetch the VM image for gild .* connect and retry, build the image yourself \(docs\/VM\.md\), or use --isolation container\|host/,
    )
  })

  test('--isolation vm falls to the next tier, and says so', async () => {
    const dir = await configDir()
    const { vmUnavailable } = await prepareVm(dir, {
      want: true,
      base: offline,
      platform,
      backendReady: () => true,
    })
    const r = resolveForHost(
      containerHost,
      { flag: 'vm' },
      machine(true),
      vmUnavailable,
    )
    expect(r).toMatchObject({ level: 'container', source: 'flag' })
    expect(describeIsolation(r, 'oci')).toMatch(
      /isolation: container \(oci\), requested by flag \(vm image unavailable, fell back to container: could not fetch/,
    )
    expect(
      assertCanIsolate(containerHost, 'vm', machine(true), vmUnavailable),
    ).toMatchObject({ level: 'container' })
  })

  test('the fallback never reaches none, and keeps the floor', () => {
    expect(() =>
      resolveForHost({}, { flag: 'vm' }, machine(false), 'offline'),
    ).toThrow(/isolation "vm" is unavailable: offline; and no other tier/)
    expect(() =>
      resolveForHost(
        { ...containerHost, floor: 'vm' },
        { flag: 'vm' },
        machine(true),
        'offline',
      ),
    ).toThrow(/no other tier/)
  })

  test('without a fetch failure, an unavailable vm is still refused', () => {
    expect(() =>
      resolveForHost(containerHost, { flag: 'vm' }, machine(true)),
    ).toThrow(/isolation "vm" \(from flag\) is not available/)
  })
})
