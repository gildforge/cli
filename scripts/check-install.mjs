// Fresh global install, all-platform dependency audit, and real detached PTY.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  root,
  npm,
  packPackages,
  packedRegistry,
  noInstallScripts,
} from './packed-packages.mjs'

const dest = join(root, '.tmp', 'install')
rmSync(dest, { recursive: true, force: true })
for (const dir of ['home', 'prefix', 'graph', 'cache'])
  mkdirSync(join(dest, dir), { recursive: true })
const env = {
  ...process.env,
  HOME: join(dest, 'home'),
  npm_config_cache: join(dest, 'cache'),
  npm_config_userconfig: join(dest, 'user.npmrc'),
  npm_config_globalconfig: join(dest, 'global.npmrc'),
  npm_config_update_notifier: 'false',
}
function run(command, args, label, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      writeFileSync(join(dest, `${label}.stdout`), stdout)
      writeFileSync(join(dest, `${label}.stderr`), stderr)
      if (code !== 0)
        reject(new Error(`${label} exited ${code}\n${stdout}\n${stderr}`))
      else resolve({ stdout, stderr })
    })
  })
}
const runNpm = (args, label, cwd) =>
  run(npm[0], [...npm.slice(1), ...args], label, cwd)
const packages = packPackages()
const registry = await packedRegistry(packages)
try {
  const installed = await runNpm(
    [
      'i',
      '-g',
      'gildforge',
      '--prefix',
      join(dest, 'prefix'),
      '--registry',
      registry.url,
      '--no-audit',
      '--no-fund',
    ],
    'npm-install',
  )
  console.log(
    `npm ${(await runNpm(['--version'], 'npm-version')).stdout.trim()} global install stdout:\n${installed.stdout}stderr:\n${installed.stderr || '(empty)'}`,
  )
  if (
    installed.stderr.trim() ||
    /allow-scripts|npm warn/i.test(installed.stdout)
  )
    throw new Error('global npm install emitted warnings')
  // npm's lock resolves even optional packages for foreign os/cpu. No hook is
  // executed here; the separate global install below uses npm's default policy.
  writeFileSync(
    join(dest, 'graph', 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: { gildforge: packages.get('gildforge').pkg.version },
    }),
  )
  await runNpm(
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--registry',
      registry.url,
      '--no-audit',
      '--no-fund',
    ],
    'graph',
    join(dest, 'graph'),
  )
  const lock = JSON.parse(
    readFileSync(join(dest, 'graph', 'package-lock.json')),
  )
  const list = []
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue
    const name = path.split('node_modules/').at(-1)
    if (entry.hasInstallScript)
      throw new Error(
        `published dependency ${name}@${entry.version} has install scripts`,
      )
    const local = packages.get(name)
    const pkg =
      local?.pkg ??
      JSON.parse(
        (
          await runNpm(
            [
              'view',
              `${name}@${entry.version}`,
              '--json',
              '--registry',
              registry.url,
            ],
            `metadata-${list.length}`,
          )
        ).stdout,
      )
    noInstallScripts(pkg, `published dependency ${name}@${entry.version}`)
    list.push({
      name,
      version: entry.version,
      dependencies: pkg.dependencies ?? {},
      optionalDependencies: pkg.optionalDependencies ?? {},
    })
  }
  writeFileSync(
    join(dest, 'published-dependencies.json'),
    JSON.stringify(list, null, 2) + '\n',
  )
  console.log(
    `verified published dependency graph: ${list.length} packages; zero install hooks`,
  )
  env.PATH = `${join(dest, 'prefix', 'bin')}:${env.PATH}`
  for (const [label, args] of [
    ['version', ['--version']],
    ['auth-init', ['auth', 'init', '--yes']],
    ['auth-status', ['auth', 'status']],
    ['spawn', ['spawn', '--detach', '--name', 't', 'cat']],
    ['send', ['send', 't', 'hi']],
    ['status', ['status', 't']],
    ['stop', ['stop', 't']],
  ]) {
    const result = await run('gild', args, label)
    console.log(`gild ${args.join(' ')}: ${result.stdout.trim()}`)
  }
} finally {
  await registry.close()
}
