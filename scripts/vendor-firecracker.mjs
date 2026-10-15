// Firecracker (Apache-2.0) ships inside @gildforge/cli-linux-x64 as
// bin/firecracker, next to gild, with its LICENSE, NOTICE and THIRD-PARTY in
// vendor/firecracker/. Only pinned upstream bytes are shipped: the release
// tarball must match both the pin and the sha256 Firecracker publishes for it.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import pin from './firecracker.json' with { type: 'json' }
import { sha256 } from './vendor-pty.mjs'

/** Packaged path -> pinned upstream file in the release tarball. */
export const firecrackerFiles = {
  'bin/firecracker': `firecracker-v${pin.version}-x86_64`,
  'vendor/firecracker/LICENSE': 'LICENSE',
  'vendor/firecracker/NOTICE': 'NOTICE',
  'vendor/firecracker/THIRD-PARTY': 'THIRD-PARTY',
}
export const firecrackerHash = (packaged) =>
  pin.files[firecrackerFiles[packaged]]

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

export async function vendorFirecracker(root, packageDir) {
  const cache = join(root, '.tmp', `firecracker-${pin.version}`)
  mkdirSync(cache, { recursive: true })
  const bytes = await download(pin.tarball)
  const published = (await download(pin.tarball + '.sha256.txt'))
    .toString()
    .trim()
    .split(/\s+/)[0]
  if (published !== pin.sha256)
    throw new Error(
      `firecracker ${pin.version}: published sha256 ${published} is not the pin`,
    )
  if (sha256(bytes) !== pin.sha256)
    throw new Error(`firecracker ${pin.version}: tarball sha256 mismatch`)
  const archive = join(cache, 'release.tgz')
  writeFileSync(archive, bytes)
  const dir = `release-v${pin.version}-x86_64`
  execFileSync('tar', [
    '-xzf',
    archive,
    '-C',
    cache,
    ...Object.keys(pin.files).map((file) => `${dir}/${file}`),
  ])
  for (const [packaged, file] of Object.entries(firecrackerFiles)) {
    const content = readFileSync(join(cache, dir, file))
    if (sha256(content) !== pin.files[file])
      throw new Error(`firecracker ${pin.version}: ${file} hash mismatch`)
    const dest = join(packageDir, packaged)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, content)
    if (packaged === 'bin/firecracker') chmodSync(dest, 0o755)
  }
  console.log(`verified firecracker ${pin.version}: linux-x64`)
}
