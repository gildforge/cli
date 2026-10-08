import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, cli, testIdentity } from './test-cli'
import { signedCall, verifyChallenge } from './gild'

test('token routing remints on server mismatch and migrates unbound tokens before API use', async () => {
  const received: string[] = []
  const f = await fixture(async (req) => {
    const path = new URL(req.url).pathname
    received.push(path)
    if (path === '/api/auth/challenge')
      return Response.json({ challenge: 'test-challenge' })
    if (path === '/api/tokens') {
      const body = (await req.json()) as any
      expect(
        verifyChallenge(body.publicKey, body.challenge, body.signature),
      ).toBe(true)
      return Response.json({ token: 'gf_newfixture', name: 'alice' })
    }
    expect(req.headers.get('authorization')).toBe('Bearer gf_newfixture')
    return Response.json([])
  })
  try {
    for (const token of [
      { server: 'https://other.test', token: 'gf_otherfixture' },
      'gf_legacyfixture',
    ]) {
      received.length = 0
      await f.identity(token)
      const result = await cli(f.root, ['org', 'list', '--server', f.origin])
      expect(result.code).toBe(0)
      expect(received).toEqual([
        '/api/auth/challenge',
        '/api/tokens',
        '/api/v1/orgs',
      ])
      expect(
        JSON.parse(await readFile(join(f.root, 'identity.json'), 'utf8'))
          .apiToken,
      ).toEqual({ server: f.origin, token: 'gf_newfixture' })
      received.length = 0
      expect(
        (await cli(f.root, ['org', 'list', '--server', f.origin + '/'])).code,
      ).toBe(0)
      expect(received).toEqual(['/api/v1/orgs'])
    }
  } finally {
    await f.close()
  }
})

test('credential helper refuses another origin and legacy unbound tokens', async () => {
  const f = await fixture(() => {
    throw Error('credential helper must be offline')
  })
  try {
    await f.identity()
    const u = new URL(f.origin)
    const valid = await cli(
      f.root,
      ['credential', 'get'],
      `protocol=${u.protocol.slice(0, -1)}\nhost=${u.host}\n\n`,
    )
    expect(valid.out).toContain('password=gf_fixturetoken')
    expect(
      (
        await cli(
          f.root,
          ['credential', 'get'],
          'protocol=https\nhost=other.test\n\n',
        )
      ).out,
    ).toBe('')
    await f.identity('gf_legacyfixture')
    expect(
      (
        await cli(
          f.root,
          ['credential', 'get'],
          'protocol=https\nhost=gild.gg\n\n',
        )
      ).out,
    ).toBe('')
  } finally {
    await f.close()
  }
})

test('signedCall refuses forge writes before requesting a challenge', async () => {
  let calls = 0
  const f = await fixture(() => {
    calls++
    return Response.json({ challenge: 'challenge' })
  })
  try {
    await expect(
      signedCall(f.origin, '/api/repos', testIdentity() as any),
    ).rejects.toThrow('scoped v1')
    expect(calls).toBe(0)
  } finally {
    await f.close()
  }
})

test('agent join and resumed collection sign the request and store the approved token', async () => {
  let publicKey = '',
    collections = 0
  const f = await fixture(async (req) => {
    const body = (await req.json()) as any
    if (new URL(req.url).pathname === '/api/agents/requests') {
      publicKey = body.publicKey
      expect(body).toMatchObject({
        sponsor: 'alice',
        label: 'test',
        repo: 'alice/demo',
        grants: ['pr', 'review'],
      })
      return Response.json({
        id: 'request-1',
        status: 'pending',
        agent: 'alice/test',
        approveUrl: 'https://fixture.test/approve',
        collect: 'url',
      })
    }
    collections++
    expect(
      verifyChallenge(publicKey, 'gild-agent-join:request-1', body.signature),
    ).toBe(true)
    return Response.json({
      status: 'approved',
      token: 'gf_approvedfixture',
      repo: 'alice/demo',
      grants: ['pr'],
    })
  })
  try {
    expect(
      (
        await cli(f.root, [
          'agent',
          'join',
          'test',
          '--sponsor',
          'alice',
          '--repo',
          'alice/demo',
          '--grants',
          'pr,review',
          '--server',
          f.origin,
          '--no-wait',
        ])
      ).code,
    ).toBe(0)
    expect(collections).toBe(0)
    const mismatch = await cli(f.root, [
      'agent',
      'join',
      'test',
      '--sponsor',
      'alice',
      '--server',
      'https://other.test',
    ])
    expect(mismatch.code).toBe(1)
    expect(collections).toBe(0)
    expect(
      (await cli(f.root, ['agent', 'join', 'test', '--sponsor', 'alice'])).code,
    ).toBe(0)
    expect(collections).toBe(1)
    expect(
      JSON.parse(await readFile(join(f.root, 'agents/test.json'), 'utf8'))
        .token,
    ).toBe('gf_approvedfixture')
  } finally {
    await f.close()
  }
})

test('agent collect 4xx exits with the reason without retrying', async () => {
  let calls = 0
  const f = await fixture(() => {
    calls++
    return Response.json({ error: 'approval revoked' }, { status: 403 })
  })
  try {
    await f.agent(null)
    const result = await cli(f.root, [
      'agent',
      'join',
      'test',
      '--sponsor',
      'alice',
    ])
    expect(result.code).toBe(1)
    expect(result.err).toContain('approval revoked')
    expect(calls).toBe(1)
  } finally {
    await f.close()
  }
})
