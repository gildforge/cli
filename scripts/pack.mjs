// Builds the platform matrix and assembles the npm packages:
//   packages/gild                    — the umbrella (bin launcher + optionalDependencies)
//   packages/gild-darwin-arm64       — the compiled binary per platform
//   packages/gild-darwin-x64
//   packages/gild-linux-x64
// No postinstall anywhere: npm's optionalDependencies + os/cpu fields pick the
// right package, and the launcher just execs the binary it finds.
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../package.json'

const ROOT = new URL('..', import.meta.url).pathname
const TARGETS = [
  { name: 'gild-darwin-arm64', bun: 'bun-darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { name: 'gild-darwin-x64', bun: 'bun-darwin-x64', os: 'darwin', cpu: 'x64' },
  { name: 'gild-linux-x64', bun: 'bun-linux-x64', os: 'linux', cpu: 'x64' },
]

rmSync(join(ROOT, 'packages'), { recursive: true, force: true })

for (const t of TARGETS) {
  const dir = join(ROOT, 'packages', t.name)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const out = join(dir, 'bin', 'gild')
  const build = Bun.spawnSync(['bun', 'build', '--compile', '--minify', `--target=${t.bun}`, 'src/gild.ts', '--outfile', out], { cwd: ROOT })
  if (build.exitCode !== 0) { console.error(t.name, 'build failed:', build.stderr.toString()); process.exit(1) }
  chmodSync(out, 0o755)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@gildforge/${t.name}`,
    version: pkg.version,
    description: `gild CLI binary (${t.os} ${t.cpu})`,
    type: 'module',
    os: [t.os],
    cpu: [t.cpu],
    files: ['bin'],
    publishConfig: { access: 'public' },
  }, null, 2) + '\n')
  console.log(`built ${t.name}`)
}

const launcher = `#!/usr/bin/env node
// Picks the platform binary installed via optionalDependencies and execs it.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const require = createRequire(import.meta.url)
const pkg = \`@gildforge/gild-\${process.platform}-\${process.arch}\`
let bin
try { bin = join(dirname(require.resolve(pkg + '/package.json')), 'bin', 'gild') }
catch { console.error(\`gild: no binary for \${process.platform}-\${process.arch} (tried \${pkg})\`); process.exit(1) }
const { status } = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' })
process.exit(status ?? 1)
`

const main = join(ROOT, 'packages', 'gild')
mkdirSync(join(main, 'bin'), { recursive: true })
writeFileSync(join(main, 'bin', 'gild.js'), launcher)
chmodSync(join(main, 'bin', 'gild.js'), 0o755)
writeFileSync(join(main, 'package.json'), JSON.stringify({
  name: 'gild',
  version: pkg.version,
  description: 'gild — key-first identity for the forge',
  type: 'module',
  bin: { gild: 'bin/gild.js' },
  files: ['bin'],
  license: 'MIT',
  publishConfig: { access: 'public' },
  optionalDependencies: Object.fromEntries(TARGETS.map((t) => [`@gildforge/${t.name}`, pkg.version])),
}, null, 2) + '\n')
console.log('assembled packages/gild')
