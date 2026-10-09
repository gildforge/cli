// Builds the platform matrix and assembles the npm packages:
//   packages/gildforge               — the umbrella (bin launcher + optionalDependencies)
//   packages/gild-darwin-arm64       — the compiled binary per platform
//   packages/gild-darwin-x64
//   packages/gild-linux-x64
// No postinstall anywhere: npm's optionalDependencies + os/cpu fields pick the
// right package, and the launcher just execs the binary it finds.
import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import pkg from '../package.json'

const ROOT = new URL('..', import.meta.url).pathname
const TARGETS = [
  {
    name: 'cli-darwin-arm64',
    bun: 'bun-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
  },
  { name: 'cli-darwin-x64', bun: 'bun-darwin-x64', os: 'darwin', cpu: 'x64' },
  { name: 'cli-linux-x64', bun: 'bun-linux-x64', os: 'linux', cpu: 'x64' },
]

rmSync(join(ROOT, 'packages'), { recursive: true, force: true })

for (const t of TARGETS) {
  const dir = join(ROOT, 'packages', t.name)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const out = join(dir, 'bin', 'gild')
  const build = Bun.spawnSync(
    [
      'bun',
      'build',
      '--compile',
      '--minify',
      `--target=${t.bun}`,
      'src/gild.ts',
      '--outfile',
      out,
    ],
    { cwd: ROOT },
  )
  if (build.exitCode !== 0) {
    console.error(t.name, 'build failed:', build.stderr.toString())
    process.exit(1)
  }
  chmodSync(out, 0o755)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@gildforge/${t.name}`,
        version: pkg.version,
        description: `gild CLI binary (${t.os} ${t.cpu})`,
        type: 'module',
        os: [t.os],
        cpu: [t.cpu],
        files: ['bin'],
        repository: {
          type: 'git',
          url: 'git+https://github.com/gildforge/cli.git',
        },
        publishConfig: { access: 'public' },
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`built ${t.name}`)
}

const launcher = (family, bin) => `#!/usr/bin/env node
// Picks the platform binary installed via optionalDependencies and execs it.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const require = createRequire(import.meta.url)
const pkg = \`@gildforge/${family}-\${process.platform}-\${process.arch}\`
let binPath
try { binPath = join(dirname(require.resolve(pkg + '/package.json')), 'bin', '${bin}') }
catch { console.error(\`${bin}: no build for \${process.platform}-\${process.arch} (tried \${pkg})\`); process.exit(1) }
if (!existsSync(binPath)) { console.error(\`${bin}: \${pkg} is installed but has no binary yet — it ships with the next server release.\`); process.exit(1) }
${
  family === 'cli'
    ? `const child = spawn(binPath, process.argv.slice(2), { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGWINCH']) process.on(signal, () => child.kill(signal))
child.on('error', (error) => { console.error(error.message); process.exit(1) })
child.on('exit', (code, signal) => process.exit(code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] ?? 1)))`
    : `const { status } = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' })
process.exit(status ?? 1)`
}
`

const main = join(ROOT, 'packages', 'gildforge')
mkdirSync(join(main, 'bin'), { recursive: true })
// One install, both tools: `gild` (identity + forge client) and `gild-server`
// (the self-hosted backend). The server binaries come from gildforge/server's
// own releases; the umbrella tracks them loosely so either can ship alone.
writeFileSync(join(main, 'bin', 'gild.js'), launcher('cli', 'gild'))
writeFileSync(
  join(main, 'bin', 'gild-server.js'),
  launcher('server', 'gild-server'),
)
chmodSync(join(main, 'bin', 'gild.js'), 0o755)
chmodSync(join(main, 'bin', 'gild-server.js'), 0o755)
writeFileSync(
  join(main, 'package.json'),
  JSON.stringify(
    {
      name: 'gildforge',
      version: pkg.version,
      description:
        'gildforge — key-first identity for the gild forge (installs gild and gild-server)',
      type: 'module',
      bin: { gild: 'bin/gild.js', 'gild-server': 'bin/gild-server.js' },
      files: ['bin'],
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/gildforge/cli.git',
      },
      publishConfig: { access: 'public' },
      optionalDependencies: {
        'node-pty': pkg.optionalDependencies['node-pty'],
        ...Object.fromEntries(
          TARGETS.map((t) => [`@gildforge/${t.name}`, pkg.version]),
        ),
        ...Object.fromEntries(
          TARGETS.map((t) => [
            `@gildforge/server-${t.name.replace('cli-', '')}`,
            '*',
          ]),
        ),
      },
    },
    null,
    2,
  ) + '\n',
)
console.log('assembled packages/gildforge')
