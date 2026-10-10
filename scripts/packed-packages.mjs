import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import pin from './node-pty.json' with { type: 'json' }
import { ptyFiles, sha256 } from './vendor-pty.mjs'

export const root = resolve(new URL('..', import.meta.url).pathname)
export const npm = process.env.TEST_NPM_CLI
  ? [process.execPath, process.env.TEST_NPM_CLI]
  : ['npm']
export const runNpm = (args, options = {}) =>
  execFileSync(npm[0], [...npm.slice(1), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  })
export function noInstallScripts(pkg, label) {
  for (const hook of ['preinstall', 'install', 'postinstall'])
    if (Object.hasOwn(pkg.scripts ?? {}, hook))
      throw new Error(`${label} declares ${hook}: ${pkg.scripts[hook]}`)
  for (const deps of [
    pkg.dependencies,
    pkg.optionalDependencies,
    pkg.peerDependencies,
  ])
    if (deps && Object.hasOwn(deps, 'node-pty'))
      throw new Error(`${label} still depends on node-pty`)
}
export function packPackages() {
  const dest = join(root, '.tmp', 'packed')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const packages = new Map()
  for (const name of [
    'gildforge',
    'cli-darwin-arm64',
    'cli-darwin-x64',
    'cli-linux-x64',
  ]) {
    const output = runNpm([
      'pack',
      join(root, 'packages', name),
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      dest,
    ])
    const result = JSON.parse(output)
    if (result.error)
      throw new Error(`npm pack failed: ${JSON.stringify(result.error)}`)
    const [packed] = Array.isArray(result) ? result : Object.values(result)
    const tarball = join(dest, packed.filename)
    const read = (file) =>
      execFileSync('tar', ['-xOf', tarball, `package/${file}`])
    for (const { path } of packed.files) {
      if (path.endsWith('package.json'))
        noInstallScripts(JSON.parse(read(path)), `${packed.name}/${path}`)
      // npm implicitly runs node-gyp for a package containing binding.gyp.
      if (path.endsWith('binding.gyp'))
        throw new Error(`${packed.name} includes binding.gyp`)
    }
    const pkg = JSON.parse(read('package.json'))
    if (name.startsWith('cli-')) {
      for (const file of ptyFiles(name.slice(4))) {
        if (sha256(read(`vendor/node-pty/${file}`)) !== pin.files[file])
          throw new Error(`${name}: packed node-pty hash mismatch: ${file}`)
      }
      const helper = packed.files.find((file) =>
        file.path.endsWith('/spawn-helper'),
      )
      if (
        name.startsWith('cli-darwin-') &&
        (!helper || (helper.mode & 0o111) !== 0o111)
      )
        throw new Error(`${name}: packed spawn-helper is not executable`)
    }
    packages.set(pkg.name, { pkg, tarball, integrity: packed.integrity })
    console.log(
      `verified npm pack: ${pkg.name}@${pkg.version} (${packed.files.length} files)`,
    )
  }
  return packages
}
// Serve the actual candidate tarballs so npm resolves their optionalDependencies
// exactly as after publication. Other packages come from the public npm registry.
export async function packedRegistry(packages) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`)
      if (url.pathname.startsWith('/tarballs/')) {
        const name = decodeURIComponent(url.pathname.slice('/tarballs/'.length))
        const entry = packages.get(name)
        if (!entry) {
          response.writeHead(404).end()
          return
        }
        response.end(readFileSync(entry.tarball))
        return
      }
      const entry = packages.get(decodeURIComponent(url.pathname.slice(1)))
      if (entry) {
        const pkg = {
          ...entry.pkg,
          dist: {
            tarball: `${url.origin}/tarballs/${encodeURIComponent(entry.pkg.name)}`,
            integrity: entry.integrity,
          },
        }
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            name: pkg.name,
            'dist-tags': { latest: pkg.version },
            versions: { [pkg.version]: pkg },
          }),
        )
        return
      }
      const upstream = await fetch(
        `https://registry.npmjs.org${url.pathname}${url.search}`,
      )
      response.writeHead(upstream.status, {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/json',
      })
      response.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
