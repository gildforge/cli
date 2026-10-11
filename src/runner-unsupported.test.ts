import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { executeJob, type Assignment } from './runner'
import { unsupportedRuntimeAction } from './actions/runtime-support'
import { setupNode } from './actions/setup-node'

test('disabled dependency caching stays supported; explicit setup-node caching fails before execution', async () => {
  expect(
    unsupportedRuntimeAction('actions/setup-go@v5', { cache: 'false' }),
  ).toBeUndefined()
  expect(
    unsupportedRuntimeAction('actions/setup-go@v5', { cache: false }),
  ).toBeUndefined()
  expect(
    unsupportedRuntimeAction('actions/setup-node@v6', { cache: '' }),
  ).toBeUndefined()
  let ran = false
  await expect(
    setupNode(
      'actions/setup-node@v6',
      { cache: 'npm' },
      '.tmp',
      {},
      new AbortController().signal,
      async () => {
        ran = true
        return 0
      },
      async () => {},
    ),
  ).rejects.toThrow('dependency caching is unsupported')
  expect(ran).toBe(false)
})

test('real runner execution reports artifact and cache requests as failed steps', async () => {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(resolve('.tmp/unsupported-'))
  const repo = join(root, 'acme/demo.git')
  await mkdir(repo, { recursive: true })
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  git('init', '-b', 'main')
  await writeFile(join(repo, 'README.md'), 'runner fixture\n')
  git('add', '.')
  git(
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Runner fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'Fixture',
  )
  const logs: string[] = [],
    states: { step: number; status: string; exit: number }[] = []
  let finished: { status: string } | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.startsWith('/acme/demo.git')) {
        const child = Bun.spawn(['git', 'http-backend'], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method,
            CONTENT_TYPE: req.headers.get('content-type') ?? '',
          },
          stdin: new Uint8Array(await req.arrayBuffer()),
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const response = Buffer.from(
          await new Response(child.stdout).arrayBuffer(),
        )
        const at = response.indexOf('\r\n\r\n'),
          headers = new Headers()
        expect(await child.exited).toBe(0)
        for (const line of response.subarray(0, at).toString().split('\r\n')) {
          const colon = line.indexOf(':')
          if (colon > 0)
            headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
        }
        return new Response(response.subarray(at + 4), { headers })
      }
      const body = (await req.json()) as any
      if (url.pathname.endsWith('/logs')) logs.push(...body.lines)
      if (url.pathname.endsWith('/step')) states.push(body)
      if (url.pathname.endsWith('/finish')) finished = body
      return Response.json({ ok: true, cancel: false })
    },
  })
  const requested: { uses: string; with: Record<string, string> }[] = [
    {
      uses: 'actions/upload-artifact@v4',
      with: { name: 'build', path: 'dist' },
    },
    {
      uses: 'actions/cache@v4',
      with: { path: 'dependencies', key: 'fixture' },
    },
    {
      uses: 'actions/setup-node@v6',
      with: { 'node-version': '24', cache: 'npm' },
    },
    {
      uses: 'actions/setup-go@v5',
      with: { 'go-version': '1.24', cache: 'true' },
    },
  ]
  const job: Assignment = {
    schema: 1,
    job: 1,
    run: 1,
    lease: 'fixture',
    sha: git('rev-parse', 'HEAD'),
    ref: 'refs/heads/main',
    repository: 'acme/demo',
    timeout: 15000,
    workspaceToken: '__WORKSPACE__',
    github: {},
    steps: requested.map((action) => ({
      ...action,
      with: action.with,
      name: action.uses,
      shell: 'bash',
      directory: '.',
      env: {},
      continueOnError: false,
      timeout: 5000,
      when: { success: true, failure: true, cancelled: false },
    })),
  }
  try {
    expect(
      await executeJob(
        {
          schema: 1,
          id: 'fixture',
          name: 'unsupported',
          repo: 'acme/demo',
          server: server.url.origin,
          token: 'gr_fixture',
          os: process.platform,
          arch: process.arch,
          labels: [],
        },
        job,
        root,
        new AbortController().signal,
        'none',
      ),
    ).toBe('failure')
    expect(finished?.status).toBe('failure')
    expect(
      states
        .filter((state) => state.status === 'failure')
        .map((state) => [state.step, state.exit]),
    ).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ])
    expect(states.some((state) => state.status === 'success')).toBe(false)
    for (const text of [
      'no artifact upload backend',
      'no dependency cache backend',
      'remove the cache input',
    ])
      expect(logs.join('\n')).toContain(text)
    expect(logs.join('\n')).not.toContain('is a no-op')
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
