import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { saveRunner, loadRunner, request, startRunner } from './runner'
import { servicePlan, runnerService } from './runner-service'
import { Command } from 'commander'
import { runnerCommands } from './runner'
test('owner config round trip and legacy config stay compatible', async () => {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(resolve('.tmp/owner-'))
  try {
    const base = {
      schema: 1 as const,
      id: 'id',
      name: 'bugsy',
      server: 'https://gild.gg',
      os: 'linux',
      arch: 'x64',
      labels: [],
    }
    await saveRunner(root, {
      ...base,
      token: 'gro_' + 'a'.repeat(32),
      scope: 'org',
      owner: 'acme',
    })
    expect((await loadRunner(root, 'bugsy')).scope).toBe('org')
    await saveRunner(root, {
      ...base,
      name: 'old',
      repo: 'acme/repo',
      token: 'gr_' + 'b'.repeat(32),
    })
    expect((await loadRunner(root, 'old')).repo).toBe('acme/repo')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('registration command uses one-time token without loading owner identity', async () => {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(resolve('.tmp/register-'))
  let identityCalls = 0,
    requests: any[] = []
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return Response.json({ id: 'id', token: 'gro_' + 'c'.repeat(32) })
    },
    { preconnect: original.preconnect },
  )
  try {
    const program = new Command()
    runnerCommands(program, async () => {
      identityCalls++
      throw Error('identity must not be loaded')
    })
    await program.parseAsync(
      [
        'runner',
        'add',
        '--org',
        'acme',
        '--group',
        'builds',
        '--name',
        'bugsy',
        '--token',
        'grt_' + 'd'.repeat(32),
        '--config-dir',
        root,
      ],
      { from: 'user' },
    )
    expect(identityCalls).toBe(0)
    expect(requests[0].url).toBe(
      'https://gild.gg/api/v1/orgs/acme/actions/runners',
    )
    expect(JSON.parse(requests[0].init.body).group).toBe('builds')
    expect((await loadRunner(root, 'bugsy')).token).toStartWith('gro_')
  } finally {
    globalThis.fetch = original
    await rm(root, { recursive: true, force: true })
  }
})
test('scoped runner requests target org and personal routes', async () => {
  const original = globalThis.fetch,
    seen: string[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return Response.json({ job: null })
    },
    { preconnect: original.preconnect },
  )
  try {
    for (const scope of ['org', 'user'] as const)
      await request(
        {
          server: 'https://gild.gg',
          scope,
          owner: 'acme',
          token: 'gro_' + 'a'.repeat(32),
        },
        'runners/poll',
        { wait: 0 },
      )
    expect(seen).toEqual([
      'https://gild.gg/api/v1/orgs/acme/actions/runners/poll',
      'https://gild.gg/api/v1/users/acme/actions/runners/poll',
    ])
  } finally {
    globalThis.fetch = original
  }
})
test('service install invokes the native manager with a credential-free private definition', async () => {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(resolve('.tmp/service-')),
    calls: { file: string; args: string[] }[] = []
  try {
    const opts = {
      name: 'bugsy',
      configDir: join(root, 'config'),
      home: root,
      platform: 'linux' as const,
      executable: '/opt/gild/bin/gild',
      execute: (file: string, args: string[]) => {
        calls.push({ file, args })
      },
    }
    const file = await runnerService('install', opts),
      content = await readFile(file, 'utf8')
    expect(calls).toEqual([
      { file: 'systemctl', args: ['--user', 'daemon-reload'] },
      {
        file: 'systemctl',
        args: ['--user', 'enable', '--now', 'gild.runner.bugsy.service'],
      },
    ])
    expect(content).toContain('"/opt/gild/bin/gild" "runner" "start"')
    expect(content).not.toMatch(/(?:gro|gr|gf)_/)
    await runnerService('uninstall', opts)
    expect(calls.at(-2)?.args).toEqual([
      '--user',
      'disable',
      '--now',
      'gild.runner.bugsy.service',
    ])
    expect(
      servicePlan({ ...opts, platform: 'darwin', uid: 501 }).install.slice(
        0,
        3,
      ),
    ).toEqual(['launchctl', 'bootstrap', 'gui/501'])
    const windows = servicePlan({ ...opts, platform: 'win32' })
    expect(windows.install[3]).toContain('ServiceBase.Run')
    expect(windows.install[3]).toContain('Get-Credential')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('production nested runner command honors global config-dir and edits the requested group', async () => {
  const { program } = await import('./gild')
  const root = await mkdtemp(resolve('.tmp/owner-controls-'))
  const original = globalThis.fetch,
    calls: any[] = []
  await writeFile(
    join(root, 'identity.json'),
    JSON.stringify({
      apiToken: { server: 'https://gild.gg', token: 'gf_fixture' },
    }),
    { mode: 0o600 },
  )
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json(
        {
          id: 'builds',
          name: 'builds',
          visibility: 'selected',
          allow_public_repositories: false,
          repositories: [],
        },
        { status: 201 },
      )
    },
    { preconnect: original.preconnect },
  )
  try {
    await program.parseAsync(
      [
        'runner',
        'group',
        'create',
        'builds',
        '--org',
        'acme',
        '--config-dir',
        root,
      ],
      { from: 'user' },
    )
    expect(calls[0].url).toBe(
      'https://gild.gg/api/v1/orgs/acme/actions/runner-groups',
    )
    expect(calls[0].authorization).toBe('Bearer gf_fixture')
    expect(calls[0].body.name).toBe('builds')
  } finally {
    globalThis.fetch = original
    await rm(root, { recursive: true, force: true })
  }
})
