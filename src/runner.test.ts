import { test, expect } from 'bun:test'
import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
  symlink,
  rm,
} from 'node:fs/promises'
import { resolve, join } from 'node:path'
import {
  shellCommand,
  versionMatches,
  toolCheck,
  saveRunner,
  loadRunner,
  insideWorkspace,
  assertRunnerHost,
} from './runner'
test('runner toolchains check installed versions; arbitrary uses are unsupported', () => {
  expect(
    toolCheck('actions/setup-node@v4', { 'node-version': '22' })?.command,
  ).toEqual(['node', '--version'])
  expect(toolCheck('oven-sh/setup-bun@v2', {})?.command).toEqual([
    'bun',
    '--version',
  ])
  expect(toolCheck('actions/setup-go@v5', {})?.command).toEqual([
    'go',
    'version',
  ])
  expect(toolCheck('dtolnay/rust-toolchain@nightly', {})?.command).toEqual([
    'rustup',
    'run',
    'nightly',
    'rustc',
    '--version',
  ])
  expect(toolCheck('someone/arbitrary@v1', {})).toBeNull()
  expect(versionMatches('v22.11.0', '22')).toBe(true)
  expect(versionMatches('go version go1.23.1 darwin/arm64', '1.23.x')).toBe(
    true,
  )
  expect(versionMatches('v20.0.0', '22')).toBe(false)
  expect(versionMatches('v22.0.0', 'lts/*')).toBe(false)
})
test('runner uses declared shell with pipefail and does not eval templates', () => {
  expect(shellCommand('bash', 'script')).toEqual([
    'bash',
    '--noprofile',
    '--norc',
    '-e',
    '-o',
    'pipefail',
    'script',
  ])
  expect(shellCommand('sh', 'script')).toEqual(['sh', '-e', 'script'])
  expect(shellCommand('bash -e {0}', 'script')).toEqual([
    'bash',
    '-e',
    'script',
  ])
  expect(() => shellCommand('bash $(whoami) {0}', 'x')).toThrow(
    'unsupported shell',
  )
})
test('runner credentials have private permissions and cannot use traversal names', async () => {
  const parent = resolve('.tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'runner-config-'))
  try {
    const config = {
      schema: 1 as const,
      id: 'local-fixture',
      token: 'gr_' + 'a'.repeat(32),
      name: 'test',
      repo: 'acme/demo',
      server: 'http://localhost:8000',
      os: 'darwin',
      arch: 'x64',
      labels: ['fast'],
    }
    await saveRunner(root, config)
    expect((await stat(join(root, 'runners/test.json'))).mode & 0o777).toBe(
      0o600,
    )
    expect((await loadRunner(root, 'test')).token).toBe(config.token)
    expect(
      (await readFile(join(root, 'runners/test.json'), 'utf8')).includes(
        config.token,
      ),
    ).toBe(true)
    await expect(
      saveRunner(root, { ...config, name: '../escape' }),
    ).rejects.toThrow()
    const work = join(root, 'work')
    await mkdir(work)
    await symlink(root, join(work, 'outside'))
    await expect(insideWorkspace(work, 'outside')).rejects.toThrow('inside')
    expect(await insideWorkspace(work, '.')).toBe(work)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('runner root execution requires the explicit host flag', () => {
  if (process.getuid?.() === 0) expect(() => assertRunnerHost()).toThrow('root')
  expect(() => assertRunnerHost(true)).not.toThrow()
})

test('runner default bash fails a failed pipeline even when the final command succeeds', async () => {
  const base = resolve('.tmp')
  await mkdir(base, { recursive: true })
  const dir = await mkdtemp(join(base, 'shell-proof-')),
    script = join(dir, 'script.sh')
  try {
    await writeFile(script, 'false | cat\n')
    const r = Bun.spawnSync(shellCommand('bash', script), {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
