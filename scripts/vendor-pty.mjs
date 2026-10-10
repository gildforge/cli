// Only verified upstream bytes are shipped; no native build or install hook.
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import pin from './node-pty.json' with { type: 'json' }

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex')
export const ptyFiles = (platform) =>
  Object.keys(pin.files).filter(
    (file) =>
      !file.startsWith('prebuilds/') ||
      file.startsWith(`prebuilds/${platform}/`),
  )
export async function vendorPty(root, targets) {
  const cache = join(root, '.tmp', `node-pty-${pin.version}`)
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, 'upstream.tgz')
  const response = await fetch(pin.tarball)
  if (!response.ok) throw new Error(`node-pty download: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (
    sha256(bytes) !== pin.sha256 ||
    `sha512-${createHash('sha512').update(bytes).digest('base64')}` !==
      pin.integrity
  )
    throw new Error('node-pty npm tarball integrity mismatch')
  writeFileSync(archive, bytes)
  execFileSync('tar', [
    '-xzf',
    archive,
    '-C',
    cache,
    ...Object.keys(pin.files).map((file) => `package/${file}`),
  ])
  for (const target of targets) {
    const platform = `${target.os}-${target.cpu}`
    const dest = join(root, 'packages', target.name, 'vendor', 'node-pty')
    for (const file of ptyFiles(platform)) {
      const source = join(cache, 'package', file)
      if (sha256(readFileSync(source)) !== pin.files[file])
        throw new Error(`node-pty upstream hash mismatch: ${file}`)
      mkdirSync(join(dest, file, '..'), { recursive: true })
      copyFileSync(source, join(dest, file))
      if (sha256(readFileSync(join(dest, file))) !== pin.files[file])
        throw new Error(`node-pty vendored hash mismatch: ${platform}/${file}`)
      if (file.endsWith('spawn-helper')) chmodSync(join(dest, file), 0o755)
    }
    writeFileSync(
      join(dest, 'package.json'),
      JSON.stringify(
        {
          name: 'node-pty',
          version: pin.version,
          private: true,
          type: 'commonjs',
          main: 'lib/index.js',
          license: 'MIT',
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`verified node-pty ${pin.version}: ${platform}`)
  }
}
