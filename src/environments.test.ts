import { cli, fixture as cliFixture } from './test-cli'
import { test, expect } from 'bun:test'
import { Command } from 'commander'
import { environmentCommands, stdinValue } from './environments'
import { GildClient } from './api/client'
const environment = {
  name: 'production',
  id: 1,
  url: 'https://forge/env',
  html_url: 'https://forge/env',
  reviewers: [{ type: 'User', login: 'sami' }],
  wait_timer: 0,
  deployment_branch_policy: 'main',
  allowed_agents: [],
  protection_rules: [],
}
function fixture() {
  const calls: { url: string; body: any; authorization: string | null }[] = []
  const client = new GildClient(
    'https://forge/api/v1',
    'fixture-token',
    async (input, init) => {
      const url = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : {}
      calls.push({
        url,
        body,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Response.json(
        url.endsWith('/environments')
          ? { total_count: 1, environments: [environment] }
          : url.includes('/environments/production') &&
              !url.includes('/secrets/') &&
              !url.includes('/variables/')
            ? environment
            : { ok: true },
      )
    },
  )
  const program = new Command().exitOverride(),
    resolve = async (opts: any) => {
      if (opts.agent) expect(opts.agent).toBe('reviewer')
      return client
    }
  environmentCommands(program, resolve)
  return { program, calls }
}
test('env create commits rules through canonical environment API', async () => {
  const f = fixture()
  await f.program.parseAsync(
    [
      'env',
      'create',
      'sami/demo',
      'production',
      '--reviewer',
      'sami',
      '--reviewer',
      'sami/reviewer',
      '--wait-timer',
      '5',
      '--branch',
      'release/**',
      '--allowed-agent',
      'sami/codex',
    ],
    { from: 'user' },
  )
  expect(f.calls[0].url).toEndWith('/repos/sami/demo/environments/production')
  expect(f.calls[0].body).toEqual({
    reviewers: [
      { login: 'sami', type: 'User' },
      { login: 'sami/reviewer', type: 'Agent' },
    ],
    wait_timer: 5,
    deployment_branch_policy: ['release/**'],
    allowed_agents: ['sami/codex'],
  })
})
test('env edit preserves rules that were not supplied', async () => {
  const f = fixture()
  await f.program.parseAsync(
    ['env', 'edit', 'sami/demo', 'production', '--wait-timer', '7'],
    { from: 'user' },
  )
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1].body.wait_timer).toBe(7)
  expect(f.calls[1].body.reviewers).toEqual(environment.reviewers)
})
test('env list reads the environment list', async () => {
  const f = fixture()
  await f.program.parseAsync(['env', 'list', 'sami/demo'], { from: 'user' })
  expect(f.calls[0].url).toEndWith('/environments')
})
for (const op of ['approve', 'reject'])
  test(`run ${op} uses the authenticated agent identity`, async () => {
    const f = fixture()
    await f.program.parseAsync(
      ['run', op, 'sami/demo', '42', '--agent', 'reviewer'],
      { from: 'user' },
    )
    expect(f.calls[0].url).toEndWith(`/actions/runs/42/${op}`)
    expect(f.calls[0].authorization).toBe('Bearer fixture-token')
  })
test('stdin values preserve multiline content, trim only final newline and enforce byte cap', async () => {
  async function* bytes(v: string) {
    yield new TextEncoder().encode(v)
  }
  expect(await stdinValue(bytes('first\nsecond\n'))).toBe('first\nsecond')
  await expect(stdinValue(bytes(''))).rejects.toThrow('empty')
  await expect(stdinValue(bytes('ü'.repeat(8193)))).rejects.toThrow('16384')
})

for (const kind of ['secret', 'var'])
  for (const environment of [undefined, 'production'])
    test(`${kind} set reads stdin and never echoes the value (${environment ?? 'repo'})`, async () => {
      const seen: { path: string; value: string }[] = []
      const f = await cliFixture(async (request) => {
        seen.push({
          path: new URL(request.url).pathname,
          value: ((await request.json()) as { value: string }).value,
        })
        return Response.json({ ok: true })
      })
      try {
        await f.identity()
        const result = await cli(
          f.root,
          [
            kind,
            'set',
            'sami/demo',
            'TOKEN',
            '--server',
            f.origin,
            ...(environment ? ['--env', environment] : []),
          ],
          'sensitive-test-value\n',
        )
        expect(result.code, result.err).toBe(0)
        expect(result.out + result.err).not.toContain('sensitive-test-value')
        expect(seen[0]).toEqual({
          path: environment
            ? `/api/v1/repos/sami/demo/environments/${environment}/${kind === 'secret' ? 'secrets' : 'variables'}/TOKEN`
            : kind === 'secret'
              ? '/api/v1/repos/sami/demo/actions/settings/secrets/TOKEN'
              : '/api/v1/repos/sami/demo/actions/variables/TOKEN',
          value: 'sensitive-test-value',
        })
      } finally {
        await f.close()
      }
    })
