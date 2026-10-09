import { expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cli, fixture } from './test-cli'

const SECRET = 'gf_childsecretfixture0000000000000'

/** In-process stand-in for the gild-site orchestrator routes. */
async function forge() {
  const seen: {
    method: string
    path: string
    auth: string | null
    body?: any
  }[] = []
  const f = await fixture(async (request) => {
    const url = new URL(request.url)
    const body = request.method === 'GET' ? undefined : await request.json()
    seen.push({
      method: request.method,
      path: url.pathname,
      auth: request.headers.get('authorization'),
      body,
    })
    if (
      url.pathname === '/api/v1/repos/owner/demo/agents/children' &&
      request.method === 'POST'
    ) {
      if (request.headers.get('authorization') !== 'Bearer gf_agentfixture')
        return Response.json(
          { message: 'Requires the orchestrator grant on this repository' },
          { status: 403 },
        )
      return Response.json(
        {
          name: `alice/${body.label}`,
          label: body.label,
          sponsor: 'alice/test',
          human: 'alice',
          repo: 'owner/demo',
          grants: body.grants,
          suspended: false,
          suspended_at: null,
          suspended_by: null,
          created_at: '2026-10-09T12:00:00.000Z',
          revoked_at: null,
          request_id: 'child-request-1',
          scopes: ['repo:read', 'channel:write'],
          token: SECRET,
        },
        { status: 201 },
      )
    }
    const m = url.pathname.match(
      /^\/api\/v1\/repos\/owner\/demo\/agents\/([^/]+)\/([^/]+)\/(suspend|resume)$/,
    )
    if (m && request.method === 'POST')
      return Response.json({
        agent: `${m[1]}/${m[2]}`,
        suspended: m[3] === 'suspend',
        suspended_at: m[3] === 'suspend' ? '2026-10-09T12:01:00.000Z' : null,
        suspended_by: m[3] === 'suspend' ? 'alice/test' : null,
      })
    return Response.json({ message: 'nope' }, { status: 404 })
  })
  return { f, seen }
}

test('spawn-child stores the child token locally and never prints it', async () => {
  const { f, seen } = await forge()
  try {
    await f.agent()
    const result = await cli(f.root, [
      'agent',
      'spawn-child',
      'owner/demo',
      'helper',
      '--agent',
      'test',
      '--grants',
      'pr, review',
      '--note',
      'triage',
    ])
    expect(result.code).toBe(0)
    expect(result.out + result.err).not.toContain(SECRET)
    expect(result.out).toContain('Spawned @alice/helper in owner/demo')
    const post = seen.find((s) => s.path.endsWith('/agents/children'))!
    expect(post.auth).toBe('Bearer gf_agentfixture')
    expect(post.body.label).toBe('helper')
    expect(post.body.grants).toEqual(['pr', 'review'])
    expect(post.body.note).toBe('triage')
    expect(post.body.publicKey).toMatch(/^ed25519:/)
    const path = join(f.root, 'agents/helper.json')
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect([
      stored.name,
      stored.token,
      stored.requestId,
      stored.publicKey,
    ]).toEqual(['alice/helper', SECRET, 'child-request-1', post.body.publicKey])
    expect(stored.secretKey).toBeTruthy()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    // The stored child is an ordinary local agent from here on.
    const token = await cli(f.root, ['agent', 'token', 'helper'])
    expect(token.out.trim()).toBe(SECRET)
    const again = await cli(f.root, [
      'agent',
      'spawn-child',
      'owner/demo',
      'helper',
      '--agent',
      'test',
    ])
    expect(again.code).toBe(1)
    expect(again.err).toContain('already exists on this machine')
    expect(seen.filter((s) => s.path.endsWith('/agents/children')).length).toBe(
      1,
    )
  } finally {
    await f.close()
  }
})

test('spawn-child refuses an orchestrator without a local token and a bad label', async () => {
  const { f, seen } = await forge()
  try {
    const missing = await cli(f.root, [
      'agent',
      'spawn-child',
      'owner/demo',
      'helper',
      '--agent',
      'nobody',
    ])
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('No approved agent named nobody')
    await f.agent()
    const bad = await cli(f.root, [
      'agent',
      'spawn-child',
      'owner/demo',
      'Bad_Label',
      '--agent',
      'test',
    ])
    expect(bad.code).toBe(1)
    expect(seen).toEqual([])
  } finally {
    await f.close()
  }
})

test('suspend and resume name the child under the orchestrator and use its token', async () => {
  const { f, seen } = await forge()
  try {
    await f.agent()
    const off = await cli(f.root, [
      'agent',
      'suspend',
      'owner/demo',
      'helper',
      '--agent',
      'test',
    ])
    expect(off.code).toBe(0)
    expect(off.out).toContain('Suspended @alice/helper')
    const on = await cli(f.root, [
      'agent',
      'resume',
      'owner/demo',
      'bob/worker',
      '--agent',
      'test',
    ])
    expect(on.code).toBe(0)
    expect(on.out).toContain('Resumed @bob/worker')
    expect(seen.map((s) => [s.method, s.path, s.auth])).toEqual([
      [
        'POST',
        '/api/v1/repos/owner/demo/agents/alice/helper/suspend',
        'Bearer gf_agentfixture',
      ],
      [
        'POST',
        '/api/v1/repos/owner/demo/agents/bob/worker/resume',
        'Bearer gf_agentfixture',
      ],
    ])
  } finally {
    await f.close()
  }
})

test('a person suspends with their own identity', async () => {
  const { f, seen } = await forge()
  try {
    await f.identity()
    const off = await cli(f.root, [
      'agent',
      'suspend',
      'owner/demo',
      'helper',
      '--server',
      f.origin,
    ])
    expect(off.code).toBe(0)
    expect(seen.map((s) => [s.path, s.auth])).toEqual([
      [
        '/api/v1/repos/owner/demo/agents/alice/helper/suspend',
        'Bearer gf_fixturetoken',
      ],
    ])
  } finally {
    await f.close()
  }
})
