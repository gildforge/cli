import { test, expect } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fixture, cli } from './test-cli'
import { redact } from './session-redaction'
const input = () => ({
  started_at: '2026-10-07T00:00:00Z',
  ended_at: null,
  model: 'fixture-model',
  commands: [{ name: 'bun test', exit_code: 0, duration_ms: 10 }],
  notes: 'tested',
})
const receipt = (body: any, target: string) => ({
  ...body,
  id: '00000000-0000-4000-8000-000000000001',
  agent: 'alice/test',
  repository: 'alice/demo',
  target,
  created_at: '2026-10-07T00:00:00Z',
  updated_at: '2026-10-07T00:00:00Z',
  version: 1,
  closed: false,
  reported_by: 'agent',
})
const secrets = [
  'gf_' + 'a'.repeat(32),
  'gr_' + 'b'.repeat(32),
  'gro_' + 'c'.repeat(32),
  'ghp_' + 'd'.repeat(32),
  'github_pat_' + 'e'.repeat(30),
  'sk-' + 'f'.repeat(32),
  'AKIA' + 'A'.repeat(16),
  'ASIA' + 'B'.repeat(16),
  'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  'eyJfixture.eyJfixture.signature',
]

test('redaction strips prefixed, AWS, Cloudflare-looking and quoted assignment credentials', () => {
  const value =
    secrets.join(' ') +
    ' Bearer short-secret --token=flag-secret KEY=key-secret AWS_SECRET_ACCESS_KEY=aws-secret CLOUDFLARE_API_TOKEN=cf-secret PASSWORD="secret with spaces"'
  const safe = redact(value)
  for (const secret of [
    ...secrets,
    'short-secret',
    'flag-secret',
    'key-secret',
    'aws-secret',
    'cf-secret',
    'secret with spaces',
  ])
    expect(safe).not.toContain(secret)
  expect(safe).toContain('[redacted]')
  expect(redact('bun test --filter core')).toBe('bun test --filter core')
})

test('session record redacts before upload and hashing; record/list use joined server for pulls and commits', async () => {
  const requests: { path: string; key: string | null; body: any }[] = []
  let stored: any
  const f = await fixture(async (req) => {
    expect(req.headers.get('authorization')).toBe('Bearer gf_agentfixture')
    const path = new URL(req.url).pathname
    if (req.method === 'GET') {
      requests.push({ path, key: null, body: null })
      return Response.json([stored])
    }
    const body = (await req.json()) as any
    const key = req.headers.get('idempotency-key')
    requests.push({ path, key, body })
    stored = receipt(
      body,
      path.endsWith('/pulls/2/sessions')
        ? 'pull:2'
        : 'commit:' + 'a'.repeat(40),
    )
    return Response.json(stored, { status: 201 })
  })
  try {
    await f.agent()
    const file = join(f.root, 'session.json')
    const raw = {
      ...input(),
      commands: [
        {
          name: 'curl --token=flag-secret ' + secrets.join(' '),
          exit_code: 7,
          duration_ms: 30,
        },
      ],
      notes:
        'Bearer note-secret KEY=key-secret AWS_SECRET_ACCESS_KEY=aws-secret PASSWORD="secret with spaces"',
    }
    await writeFile(file, JSON.stringify(raw))
    for (const target of [
      ['--pull', '2'],
      ['--commit', 'a'.repeat(40)],
    ]) {
      const args = [
        'session',
        'record',
        '--repo',
        'alice/demo',
        ...target,
        '--agent',
        'test',
        '--file',
        file,
      ]
      const recorded = await cli(f.root, args)
      expect(recorded.code).toBe(0)
      const uploaded = requests.at(-1)!
      for (const secret of [
        ...secrets,
        'flag-secret',
        'note-secret',
        'key-secret',
        'aws-secret',
        'secret with spaces',
      ])
        expect(JSON.stringify(uploaded.body)).not.toContain(secret)
      expect(uploaded.body.commands[0]).toMatchObject({
        exit_code: 7,
        duration_ms: 30,
      })
      expect(uploaded.body.commands[0].name).toContain('[redacted]')
      expect(uploaded.key).toBe(
        'receipt:' +
          createHash('sha256')
            .update(JSON.stringify(uploaded.body))
            .digest('hex'),
      )
      expect(JSON.parse(recorded.out).id).toBe(stored.id)
      expect((await cli(f.root, args)).code).toBe(0)
      expect(requests.at(-1)!.key).toBe(uploaded.key)
      const listed = await cli(f.root, [
        'session',
        'list',
        '--repo',
        'alice/demo',
        ...target,
        '--agent',
        'test',
      ])
      expect(listed.code).toBe(0)
      expect(JSON.parse(listed.out)[0].id).toBe(stored.id)
    }
    expect(requests.map((x) => x.path)).toEqual(
      [1, 2, 3]
        .map(() => '/api/v1/repos/alice/demo/pulls/2/sessions')
        .concat(
          [1, 2, 3].map(
            () =>
              '/api/v1/repos/alice/demo/commits/' +
              'a'.repeat(40) +
              '/sessions',
          ),
        ),
    )
  } finally {
    await f.close()
  }
})

test('session record/list refuse another server before sending an agent token', async () => {
  let joinedCalls = 0,
    otherCalls = 0
  const f = await fixture(() => {
    joinedCalls++
    return Response.json([])
  })
  const other = await fixture(async (req) => {
    otherCalls++
    return req.method === 'GET'
      ? Response.json([])
      : Response.json(receipt(await req.json(), 'pull:2'))
  })
  try {
    await f.agent()
    const file = join(f.root, 'session.json')
    await writeFile(file, JSON.stringify(input()))
    for (const command of ['record', 'list']) {
      const args = [
        'session',
        command,
        '--repo',
        'alice/demo',
        '--pull',
        '2',
        '--agent',
        'test',
        '--server',
        other.origin,
        ...(command === 'record' ? ['--file', file] : []),
      ]
      const result = await cli(f.root, args)
      expect(result.code).toBe(1)
      expect(result.err).toContain('server this agent joined')
    }
    expect(joinedCalls).toBe(0)
    expect(otherCalls).toBe(0)
  } finally {
    await f.close()
    await other.close()
  }
})

test('session input validation fails before upload and human lists use the bound identity', async () => {
  let calls = 0
  const f = await fixture((req) => {
    calls++
    expect(req.headers.get('authorization')).toBe('Bearer gf_fixturetoken')
    return Response.json([])
  })
  try {
    await f.agent()
    await f.identity()
    const file = join(f.root, 'invalid.json')
    await writeFile(file, '{}')
    const invalid = await cli(f.root, [
      'session',
      'record',
      '--repo',
      'alice/demo',
      '--pull',
      '2',
      '--agent',
      'test',
      '--file',
      file,
    ])
    expect(invalid.code).toBe(1)
    expect(calls).toBe(0)
    expect(
      (
        await cli(f.root, [
          'session',
          'list',
          '--repo',
          'alice/demo',
          '--pull',
          '2',
          '--commit',
          'a'.repeat(40),
          '--agent',
          'test',
        ])
      ).code,
    ).toBe(1)
    expect(calls).toBe(0)
    const listed = await cli(f.root, [
      'session',
      'list',
      '--repo',
      'alice/demo',
      '--pull',
      '2',
      '--server',
      f.origin,
    ])
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.out)).toEqual([])
    expect(calls).toBe(1)
  } finally {
    await f.close()
  }
})
