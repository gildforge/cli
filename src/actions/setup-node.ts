import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

// Immutable upstream bundles: execute setup-node itself, including its semver,
// manifest fallback and platform-specific @actions/tool-cache implementation.
const releases: Record<string, { sha: string; checksum: string }> = {
  v4: {
    sha: '49933ea5288caeca8642d1e84afbd3f7d6820020',
    checksum:
      '8897425776cbef7ddfca2275e536ecc0c26b313161de2235c5aa9fda8ce961fc',
  },
  v5: {
    sha: 'a0853c24544627f65ddf259abe73b1d18a591444',
    checksum:
      '806d9f7717a532872b6beff29ce4033887857f7a7bbd2f0d4d7144bee6488385',
  },
  v6: {
    sha: '249970729cb0ef3589644e2896645e5dc5ba9c38',
    checksum:
      '4023ca6e4bfb441f113117fadf0dab62135c07aa53af156a3673836a5ef94333',
  },
}

export type ActionCommand = (
  args: string[],
  env: Record<string, string>,
) => Promise<number>

export async function setupNode(
  uses: string,
  inputs: Record<string, string>,
  work: string,
  env: Record<string, string>,
  signal: AbortSignal,
  run: ActionCommand,
  output: (line: string) => Promise<void>,
): Promise<string | null> {
  const ref = uses.split('@')[1],
    release =
      releases[ref] ?? Object.values(releases).find((r) => r.sha === ref)
  if (!release) throw Error('setup-node supports pinned v4, v5 and v6 releases')
  const action = join(work, 'actions', release.sha),
    archive = join(work, 'tmp', `setup-node-${release.sha}.tar.gz`)
  // Job-owned storage: another workflow cannot poison an executable cache.
  await mkdir(action, { recursive: true })
  await output(`[gild: acquiring actions/setup-node@${release.sha}]`)
  const response = await fetch(
    `https://codeload.github.com/actions/setup-node/tar.gz/${release.sha}`,
    { signal },
  )
  if (!response.ok)
    throw Error(`setup-node bundle download: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== release.checksum)
    throw Error('setup-node bundle checksum mismatch')
  await writeFile(archive, bytes)
  if (
    (await run(
      ['tar', '-xzf', archive, '--strip-components=1', '-C', action],
      env,
    )) !== 0
  )
    throw Error('setup-node bundle extraction failed')
  const files = Object.fromEntries(
    ['PATH', 'ENV', 'OUTPUT', 'STATE'].map((name) => [
      name,
      join(action, `${name}.txt`),
    ]),
  )
  await Promise.all(Object.values(files).map((file) => writeFile(file, '')))
  const actionEnv = {
    ...env,
    // Always bootstrap from the machine, even after an earlier step selected older Node.
    PATH: process.env.PATH ?? env.PATH,
    ...Object.fromEntries(
      Object.entries(files).map(([name, file]) => [`GITHUB_${name}`, file]),
    ),
    'INPUT_NODE-VERSION': inputs['node-version'] ?? '',
    'INPUT_CHECK-LATEST': 'false',
    // Gild has no GitHub cache service or GitHub credential to give the action.
    INPUT_CACHE: '',
    INPUT_TOKEN: '',
    'INPUT_PACKAGE-MANAGER-CACHE': 'false',
  }
  if (inputs.cache)
    await output('[gild: dependency cache options are a no-op on this machine]')
  const exit = await run(
    ['node', join(action, 'dist', 'setup', 'index.js')],
    actionEnv,
  )
  if (exit !== 0) return null
  const paths = (await readFile(files.PATH, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .reverse()
  return [...paths, env.PATH].join(delimiter)
}
