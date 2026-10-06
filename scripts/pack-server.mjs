// Placeholder npm packages for the Rust server: claims the names now,
// binaries land when gildforge/server exists.
//   packages/server                 — @gildforge/server umbrella (stub launcher)
//   packages/server-<os>-<cpu>      — platform packages (empty bin for now)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../package.json'

const ROOT = new URL('..', import.meta.url).pathname
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64']

for (const t of TARGETS) {
  const dir = join(ROOT, 'packages', `server-${t}`)
  mkdirSync(dir, { recursive: true })
  const [os, cpu] = t.split('-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@gildforge/server-${t}`,
    version: pkg.version,
    description: `gild server binary (${os} ${cpu}) — placeholder, binary lands with gildforge/server`,
    os: [os],
    cpu: [cpu],
    publishConfig: { access: 'public' },
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'README.md'), `# @gildforge/server-${t}\n\nPlaceholder. The self-hosted gild forge server (Rust) ships here.\n`)
  console.log(`placeholder @gildforge/server-${t}`)
}

const main = join(ROOT, 'packages', 'server')
mkdirSync(main, { recursive: true })
writeFileSync(join(main, 'package.json'), JSON.stringify({
  name: '@gildforge/server',
  version: pkg.version,
  description: 'gild server — the self-hosted forge backend (Rust). Placeholder until gildforge/server lands.',
  license: 'MIT',
  publishConfig: { access: 'public' },
  optionalDependencies: Object.fromEntries(TARGETS.map((t) => [`@gildforge/server-${t}`, pkg.version])),
}, null, 2) + '\n')
writeFileSync(join(main, 'README.md'), `# @gildforge/server\n\n\`gild server init\` — the self-hosted forge backend. Rust binary, mined from linkhash's git-facade. Placeholder for now.\n`)
console.log('placeholder @gildforge/server')
