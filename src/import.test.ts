import { test, expect } from 'bun:test'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rm,
  chmod,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { NativeImport, importSSHCommand } from './import/git'
import { fixture, cli } from './test-cli'
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // CI machines have no git identity; commits and annotated tags need one.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Import Test',
      GIT_AUTHOR_EMAIL: 'import-test@gild.invalid',
      GIT_COMMITTER_NAME: 'Import Test',
      GIT_COMMITTER_EMAIL: 'import-test@gild.invalid',
    },
  }).trim()
test('native import preserves full history, branches, annotated tags, default branch and source _meta without replacing gild ACL', async () => {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(resolve('.tmp/import-git-')),
    source = join(root, 'source.git'),
    target = join(root, 'target.git')
  await mkdir(source)
  git(source, 'init', '-b', 'trunk')
  git(source, 'config', 'receive.denyCurrentBranch', 'ignore')
  for (let i = 0; i < 4; i++) {
    await writeFile(join(source, 'README'), String(i))
    git(source, 'add', '.')
    git(source, '-c', 'commit.gpgsign=false', 'commit', '-m', `commit ${i}`)
  }
  git(source, 'branch', 'topic/x')
  git(source, 'branch', 'import/pr/2', 'HEAD~1')
  git(source, 'branch', 'import_', 'HEAD~2')
  git(source, 'update-ref', 'refs/pull/2/head', 'HEAD')
  git(source, '-c', 'tag.gpgsign=false', 'tag', '-a', 'v1', '-m', 'tag')
  git(source, 'switch', '--orphan', '_meta')
  await writeFile(join(source, 'ACL'), 'source')
  git(source, 'add', '.')
  git(source, '-c', 'commit.gpgsign=false', 'commit', '-m', 'source meta')
  git(source, 'switch', 'trunk')
  await mkdir(target)
  git(target, 'init', '-b', 'main')
  git(target, 'config', 'receive.denyCurrentBranch', 'ignore')
  git(target, 'config', 'receive.denyDeleteCurrent', 'ignore')
  await writeFile(join(target, 'README'), 'seed')
  git(target, 'add', '.')
  git(target, '-c', 'commit.gpgsign=false', 'commit', '-m', 'seed')
  git(target, 'branch', '_meta')
  const protectedMeta = git(target, 'rev-parse', '_meta')
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'),
      dir = url.pathname.startsWith('/source.git') ? source : target,
      service =
        url.searchParams.get('service') ?? url.pathname.split('/').at(-1)!,
      advertise = url.pathname.endsWith('info/refs')
    if (!['git-upload-pack', 'git-receive-pack'].includes(service)) {
      res.writeHead(404).end()
      return
    }
    res.setHeader(
      'Content-Type',
      advertise
        ? `application/x-${service}-advertisement`
        : `application/x-${service}-result`,
    )
    if (advertise) {
      const head = `# service=${service}\n`
      res.write((head.length + 4).toString(16).padStart(4, '0') + head + '0000')
    }
    const child = spawn(
      'git',
      [
        service.slice(4),
        '--stateless-rpc',
        ...(advertise ? ['--advertise-refs'] : []),
        dir,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    req.pipe(child.stdin)
    child.stdout.pipe(res)
    child.stderr.resume()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const globalConfig = join(root, 'gitconfig')
  await writeFile(
    globalConfig,
    `[fetch]\n unpackLimit = 1\n[url "${origin}/source.git"]\n insteadOf = https://source.fixture.test/source.git\n`,
  )
  const receiving: number[] = []
  const before = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  try {
    const importer = new NativeImport({
      source: 'https://source.fixture.test/source.git',
      sourceToken: 'source-token-marker',
      directory: join(root, 'mirror.git'),
      signal: new AbortController().signal,
      resolveHost: async () => ['140.82.112.3'],
      credentials: async () => ({
        url: origin + '/target.git',
        token: 'import-marker',
      }),
      progress: (message, completed) => {
        if (message === 'Receiving Git objects') receiving.push(completed ?? 0)
      },
    })
    expect(await importer.fetch()).toBe('trunk')
    expect(Math.max(...receiving)).toBe(100)
    const stats = await importer.push()
    expect(stats.branches).toBe(5)
    expect(stats.tags).toBe(1)
    expect(stats.commits).toBe(5)
    expect(git(target, 'rev-parse', '_meta')).toBe(protectedMeta)
    for (const ref of [
      'refs/heads/trunk',
      'refs/heads/topic/x',
      'refs/heads/import/pr/2',
      'refs/heads/import_',
      'refs/tags/v1',
    ])
      expect(git(target, 'rev-parse', ref)).toBe(git(source, 'rev-parse', ref))
    expect(git(target, 'rev-parse', importer.branch('_meta'))).toBe(
      git(source, 'rev-parse', '_meta'),
    )
    expect(git(target, 'rev-list', '--count', 'trunk')).toBe('4')
    expect(git(target, 'branch', '--list', 'main')).toBe('')
    expect(
      await readFile(join(root, 'mirror.git/config'), 'utf8'),
    ).not.toContain('source-token-marker')
    expect(
      await readFile(join(root, 'mirror.git/config'), 'utf8'),
    ).not.toContain('import-marker')
    const importedHead = await importer.head('refs/pull/2/head', 2)
    expect(git(target, 'rev-parse', 'import/pr/2')).toBe(
      git(source, 'rev-parse', 'import/pr/2'),
    )
    expect(importedHead).toBe('import__/pr/2')
    expect(git(target, 'rev-parse', 'import__/pr/2')).toBe(
      git(source, 'rev-parse', 'trunk'),
    )
    const first = git(target, 'rev-parse', 'trunk')
    expect(await importer.fetch()).toBe('trunk')
    await importer.push()
    expect(git(target, 'rev-parse', 'trunk')).toBe(first)
    const privateSource = new NativeImport({
      ...importer.options,
      resolveHost: async () => ['192.168.1.1'],
    })
    await expect(privateSource.fetch()).rejects.toThrow('public addresses')
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = before
    await new Promise<void>((r) => server.close(() => r()))
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
test('CLI status, resume and cutover use the canonical import contract', async () => {
  const seen: string[] = [],
    status = {
      repository: 'alice/demo',
      source: 'https://github.com/a/b',
      mirror: true,
      state: 'mirroring',
      progress: { phase: 'metadata', completed: 4, message: 'Imported' },
      warnings: [],
      error: null,
      updated_at: '2020-01-01',
      next_sync: '2020-01-02',
    }
  const f = await fixture(async (req) => {
    seen.push(new URL(req.url).pathname)
    return Response.json(
      new URL(req.url).pathname.endsWith('/claim') ? null : status,
    )
  })
  try {
    await f.identity()
    for (const op of ['import-status', 'resume', 'cutover']) {
      const r = await cli(f.root, [
        'repo',
        op,
        'alice/demo',
        '--server',
        f.origin,
      ])
      expect(r.code).toBe(0)
    }
    expect(seen).toEqual([
      '/api/v1/repos/alice/demo/import',
      '/api/v1/repos/alice/demo/import/retry',
      '/api/v1/repos/alice/demo/import/claim',
      '/api/v1/repos/alice/demo/import/cutover',
    ])
  } finally {
    await f.close()
  }
})

test('a transient indexing response retries the real import RPC while revocation remains final', async () => {
  const { retryImport } = await import('./import/retry')
  const { GildClient } = await import('./api/client')
  let calls = 0,
    revoked = false
  const server = createServer((_req, res) => {
    calls++
    res
      .writeHead(revoked ? 401 : calls === 1 ? 503 : 200, {
        'content-type': 'application/json',
      })
      .end(
        JSON.stringify(
          revoked
            ? { message: 'Import lease expired or revoked' }
            : calls === 1
              ? { message: 'Repository is indexing; retry shortly' }
              : { ok: true },
        ),
      )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const client = new GildClient(
        `http://127.0.0.1:${(server.address() as any).port}/api/v1`,
        'fixture',
      ),
      result = await retryImport(
        () =>
          client.request(
            'importBatch',
            { owner: 'o', repo: 'r' },
            {
              records: [],
              progress: { phase: 'metadata', completed: 0, message: 'Retry' },
            },
          ),
        new AbortController().signal,
        () => {},
      )
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    revoked = true
    await expect(
      retryImport(
        () =>
          client.request(
            'importBatch',
            { owner: 'o', repo: 'r' },
            {
              records: [],
              progress: { phase: 'metadata', completed: 0, message: 'Revoked' },
            },
          ),
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({ status: 401 })
    expect(calls).toBe(3)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('source REST refuses literal internal destinations before opening a connection', async () => {
  const { publicFetch } = await import('./import/http')
  await expect(
    publicFetch('http://127.0.0.1/api/v4/projects/x'),
  ).rejects.toThrow('public addresses')
  await expect(
    publicFetch('https://169.254.169.254/latest/meta-data'),
  ).rejects.toThrow('public addresses')
  await expect(publicFetch('file:///etc/passwd')).rejects.toThrow(
    'Invalid source API URL',
  )
})

test('SSH imports keep their REST credential out of Git transport configuration', async () => {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(resolve('.tmp/import-ssh-auth-'))
  const options = {
    source: 'ssh://git@gitlab.example:2222/team/repo.git',
    sourceToken: 'disposable-metadata-token',
    directory: root,
    signal: new AbortController().signal,
    credentials: async () => ({
      url: 'https://gild.example/o/r.git',
      token: 'fixture',
    }),
    progress: () => {},
  }
  try {
    const native = new NativeImport(options)
    await native.git(['init', '--bare'])
    expect(
      await native.git(
        ['config', '--get-urlmatch', 'http.extraHeader', options.source],
        undefined,
        true,
      ),
    ).toBeNull()
    const https = new NativeImport({
      ...options,
      source: 'https://gitlab.example/team/repo.git',
    })
    expect(
      await https.git([
        'config',
        '--get-urlmatch',
        'http.extraHeader',
        https.options.source,
      ]),
    ).toContain('Authorization: Basic ')
    expect(await readFile(join(root, 'config'), 'utf8')).not.toContain(
      'extraHeader',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SSH source hostnames stay literal arguments even with shell metacharacters', async () => {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(resolve('.tmp/import-ssh-')),
    marker = join(root, 'unexpected'),
    ssh = join(root, 'ssh')
  try {
    await writeFile(
      ssh,
      '#!/usr/bin/env bun\nconsole.log(JSON.stringify(process.argv.slice(2)))\n',
    )
    await chmod(ssh, 0o700)
    for (const hostname of [
      'x$(touch ' + marker + ').test',
      "x'$(touch " + marker + ")'.test",
    ]) {
      const output = execFileSync(
        '/bin/sh',
        ['-c', importSSHCommand('140.82.112.3', hostname)],
        {
          env: { ...process.env, PATH: root + ':' + process.env.PATH },
          encoding: 'utf8',
        },
      )
      expect(await readFile(marker).catch(() => null)).toBeNull()
      expect(JSON.parse(output)).toEqual([
        '-o',
        'HostName=140.82.112.3',
        '-o',
        'HostKeyAlias=' + hostname,
        '-o',
        'ProxyCommand=none',
        '-o',
        'BatchMode=yes',
      ])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('local env and gh auth tokens are only used on source API requests; resume skips acknowledged records', async () => {
  const { githubReadToken } = await import('./import/auth')
  const { executeImport } = await import('./import/execute')
  const { metadata, sourceURL } = await import('./import/source')
  expect(
    await githubReadToken(
      false,
      { GH_TOKEN: 'env-marker', GITHUB_TOKEN: 'other' },
      async () => {
        throw Error('should not run gh')
      },
    ),
  ).toBe('env-marker')
  expect(
    await githubReadToken(
      false,
      { GITHUB_TOKEN: 'github-marker' },
      async () => 'gh-marker',
    ),
  ).toBe('github-marker')
  expect(await githubReadToken(false, {}, async () => 'gh-marker\n')).toBe(
    'gh-marker',
  )
  expect(
    await githubReadToken(
      true,
      { GH_TOKEN: 'env-marker' },
      async () => 'gh-marker',
    ),
  ).toBeUndefined()
  const seen: any[] = [],
    at = '2020-01-01T00:00:00.000Z'
  let checkpoint = '',
    fail = true,
    commits: number[] = []
  const status = {
    repository: 'alice/demo',
    source: 'https://github.com/a/b',
    mirror: false,
    state: 'running',
    progress: { phase: 'metadata', completed: 0, message: 'test' },
    warnings: [],
    error: null,
    updated_at: at,
    next_sync: null,
  }
  const f = await fixture(async (req) => {
    const body = await req.json()
    seen.push({ headers: Object.fromEntries(req.headers), body })
    if (req.url.endsWith('/claim')) return Response.json(null)
    if (req.url.endsWith('/batch')) {
      checkpoint = body.progress.checkpoint
      commits.push(
        ...body.records
          .filter((r: any) => r.kind === 'issue')
          .map((r: any) => r.number),
      )
      return Response.json({ ok: true })
    }
    return Response.json(status)
  })
  const sourceRequests: string[] = [],
    sourceTokens: string[] = []
  const fetcher: NonNullable<Parameters<typeof executeImport>[5]> = async (
    input,
    init,
  ) => {
    const url = new URL(String(input))
    sourceRequests.push(url.pathname)
    sourceTokens.push(new Headers(init?.headers).get('authorization')!)
    if (fail && url.pathname.endsWith('/issues/2/comments'))
      return new Response(null, { status: 403 })
    return Response.json(
      url.pathname.endsWith('/issues')
        ? [1, 2, 3].map((number) => ({
            number,
            title: 'item',
            body: 'body',
            created_at: at,
            updated_at: at,
            state: 'open',
            labels: [],
            user: { login: 'test' },
          }))
        : [],
    )
  }
  const original = {
    fetch: NativeImport.prototype.fetch,
    push: NativeImport.prototype.push,
    workflows: NativeImport.prototype.workflows,
  }
  const before = process.env.GH_TOKEN
  try {
    process.env.GH_TOKEN = 'env-marker'
    await f.identity()
    const created = await cli(f.root, [
      'repo',
      'import',
      'https://github.com/a/b',
      '--name',
      'alice/demo',
      '--server',
      f.origin,
    ])
    expect(created.code).toBe(0)
    expect(seen.find((r) => r.body.url)?.body.source_token).toBeUndefined()
    expect(seen.find((r) => r.body.url)?.body.private).toBeUndefined()
    NativeImport.prototype.fetch = async () => 'master'
    NativeImport.prototype.push = async function (prepared) {
      await prepared?.('import/pr')
      return { branches: 1, tags: 0, commits: 62 }
    }
    NativeImport.prototype.workflows = async () => []
    const job = {
      repository: 'alice/demo',
      source: 'https://github.com/a/b',
      forge: 'github' as const,
      token: 'gi_fixture',
      mirror: false,
      checkpoint: '',
    }
    await expect(
      executeImport(
        f.origin,
        job,
        f.root,
        new AbortController().signal,
        () => {},
        fetcher,
      ),
    ).rejects.toThrow('Source API 403')
    expect(commits).toEqual([1])
    expect(JSON.parse(checkpoint)).toMatchObject({ stage: 1, index: 1 })
    fail = false
    sourceRequests.length = 0
    await executeImport(
      f.origin,
      { ...job, checkpoint },
      f.root,
      new AbortController().signal,
      () => {},
      fetcher,
    )
    expect(commits).toEqual([1, 2, 3])
    expect(sourceRequests).not.toContain('/repos/a/b/issues/1/comments')
    expect(sourceRequests).not.toContain('/repos/a/b/issues')
    expect(sourceRequests).not.toContain('/repos/a/b/labels')
    expect(sourceTokens.every((t) => t === 'Bearer env-marker')).toBe(true)
    expect(JSON.stringify(seen)).not.toContain('env-marker')
    expect(
      seen.every((r) =>
        ['Bearer gi_fixture', 'Bearer gf_fixturetoken'].includes(
          r.headers.authorization,
        ),
      ),
    ).toBe(true)
    const gh = join(f.root, 'gh')
    await writeFile(gh, '#!/bin/sh\nprintf gh-marker\n')
    await chmod(gh, 0o700)
    const pathBefore = process.env.PATH,
      githubBefore = process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    process.env.PATH = f.root + ':' + pathBefore
    try {
      sourceTokens.length = 0
      await executeImport(
        f.origin,
        job,
        f.root,
        new AbortController().signal,
        () => {},
        fetcher,
      )
      expect(sourceTokens.every((t) => t === 'Bearer gh-marker')).toBe(true)
      expect(JSON.stringify(seen)).not.toContain('gh-marker')
      sourceTokens.length = 0
      await executeImport(
        f.origin,
        job,
        f.root,
        new AbortController().signal,
        () => {},
        fetcher,
        true,
      )
      expect(sourceTokens.every((t) => t === null)).toBe(true)
    } finally {
      process.env.PATH = pathBefore
      if (githubBefore !== undefined) process.env.GITHUB_TOKEN = githubBefore
    }
    // gh-derived auth travels through the same reader, with actual requests.
    const token = await githubReadToken(false, {}, async () => 'gh-marker')
    const recorded: any[] = []
    for await (const _ of metadata({
      source: sourceURL(job.source),
      token,
      destination: f.origin,
      head: async () => null,
      fetcher: async (input, init) => {
        recorded.push({ url: String(input), headers: init?.headers })
        return Response.json([])
      },
    })) {
    }
    expect(recorded.length).toBe(3)
    expect(
      recorded.every(
        (r) =>
          r.headers.authorization === 'Bearer gh-marker' &&
          new URL(r.url).hostname === 'api.github.com',
      ),
    ).toBe(true)
  } finally {
    Object.assign(NativeImport.prototype, original)
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
    await f.close()
  }
})

test('an already copied PR head succeeds without another push', async () => {
  const native = new NativeImport({
    source: 'https://github.com/a/b',
    directory: '.tmp/unused',
    signal: new AbortController().signal,
    credentials: async () => ({
      url: 'https://gild.gg/a/b.git',
      token: 'gi_test',
    }),
    progress: () => {},
  })
  const calls: string[][] = []
  native.git = async (args) => {
    calls.push(args)
    return args[0] === 'rev-parse'
      ? 'a'.repeat(40)
      : args[0] === 'ls-remote'
        ? 'a'.repeat(40) + '\trefs/heads/import/pr/2'
        : ''
  }
  expect(await native.head('refs/pull/2/head', 2)).toBe('import/pr/2')
  expect(calls.some((args) => args[0] === 'push')).toBe(false)
})

test('Git error details retain the last three lines and mask URL credentials', async () => {
  const { gitReason } = await import('./import/git')
  expect(
    gitReason('first\nsecond\nfatal: https://user:secret@gild.gg/repo\nlast\n'),
  ).toBe(' (second | fatal: https://***@gild.gg/repo | last)')
})
