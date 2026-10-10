import { test, expect } from 'bun:test'
import { fixture, cli } from './test-cli'
import { mentionPrompt, triggerPrompt } from './spawn-bridge'
const request = {
  id: 'request-id',
  agent: 'alice/test',
  repo: 'alice/repo',
  grants: ['review'],
  reason: 'Review the PR',
  status: 'pending',
  createdAt: new Date().toISOString(),
  decidedAt: null,
  decidedBy: null,
  denialReason: null,
}
test('CLI grant request, list, approve and deny use canonical operations and the correct identity', async () => {
  const calls: {
    path: string
    method: string
    body: any
    token: string | null
  }[] = []
  const f = await fixture(async (r) => {
    const path = new URL(r.url).pathname,
      body = r.method === 'GET' ? undefined : await r.json()
    calls.push({
      path,
      method: r.method,
      body,
      token: r.headers.get('authorization'),
    })
    return Response.json(
      r.method === 'GET'
        ? (path.endsWith('/request-id') ? request : [request])
        : {
            ...request,
            ...(body?.decision
              ? {
                  status: body.decision === 'approve' ? 'approved' : 'denied',
                  decidedBy: 'alice',
                  denialReason: body.reason ?? null,
                }
              : {}),
          },
      { status: r.method === 'POST' ? 201 : 200 },
    )
  })
  try {
    await f.agent()
    await f.identity()
    let r = await cli(f.root, [
      'agent',
      'request-grants',
      'alice/repo',
      '--grants',
      'review',
      '--reason',
      'Review the PR',
      '--agent',
      'test',
    ])
    expect(r.code).toBe(0)
    expect(r.out).toContain('request-id')
    expect(calls[0]).toEqual({
      path: '/api/v1/repos/alice/repo/agents/grant-requests',
      method: 'POST',
      body: { grants: ['review'], reason: 'Review the PR' },
      token: 'Bearer gf_agentfixture',
    })
    r = await cli(f.root, [
      'agent',
      'requests',
      'alice/repo',
      '--agent',
      'test',
      '--json',
    ])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)[0].id).toBe('request-id')
    for (const decision of ['approve', 'deny']) {
      r = await cli(f.root, [
        'agent',
        decision,
        'request-id',
        '--server',
        f.origin,
        ...(decision === 'deny' ? ['--reason', 'Review first'] : []),
      ])
      expect(r.code).toBe(0)
      expect(r.out).toContain(decision === 'approve' ? 'approved' : 'denied')
      expect(calls.at(-1)?.path).toBe(
        '/api/v1/agents/grant-requests/request-id',
      )
      expect(calls.at(-1)?.token).toBe('Bearer gf_fixturetoken')
      if(decision==='approve') {
        expect(calls.at(-2)?.method).toBe('GET')
        expect(calls.at(-1)?.body).toEqual({decision:'approve',grants:['review']})
      }
    }
    expect(calls.at(-1)?.body).toEqual({
      decision: 'deny',
      reason: 'Review first',
    })
    const n = calls.length
    r = await cli(f.root, [
      'agent',
      'request-grants',
      'alice/repo',
      '--grants',
      'review',
      '--reason',
      'Review the PR',
    ])
    expect(r.code).not.toBe(0)
    expect(calls.length).toBe(n)
  } finally {
    await f.close()
  }
})
test('actual missing-scope CLI error suggests the exact grant request command', async () => {
  const f = await fixture(() =>
    Response.json({ message: 'Requires pulls:write scope' }, { status: 403 }),
  )
  try {
    await f.agent()
    const r = await cli(f.root, [
      'pr',
      'review',
      'alice/repo#2',
      '--approve',
      '--body',
      'Reviewed',
      '--agent',
      'test',
    ])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      'gild agent request-grants alice/repo --grants review --reason "<why this is needed>" --agent test',
    )
  } finally {
    await f.close()
  }
})
test('mention and trigger prompts teach agents to request grants with a reason', () => {
  const mention = mentionPrompt('alice/repo', 'test', {
    repository: { full_name: 'alice/repo' },
    agent: 'alice/test',
    message: {
      id: 'm',
      cursor: '1',
      author: { name: 'alice' },
      body: 'Review please',
    },
  })
  const trigger = triggerPrompt(
    'alice/repo',
    { event: 'issues', action: 'opened' },
    { number: 1, title: 'Issue' },
    'alice',
    undefined,
    'gild',
    'test',
  )
  for (const p of [mention, trigger]) {
    expect(p).toContain('instead of asking in chat')
    expect(p).toContain(
      'gild agent request-grants alice/repo --grants <grant> --reason "<why this is needed>" --agent test',
    )
  }
  const decision = mentionPrompt('alice/repo', 'test', {
    repository: { full_name: 'alice/repo' },
    agent: 'alice/test',
    message: {
      id: 'grant-decision',
      cursor: '0',
      author: { name: 'alice' },
      body: '[gild] @alice approved review on alice/repo',
    },
  })
  expect(decision.split('\n')[0]).toBe(
    '[gild] @alice approved review on alice/repo',
  )
})
