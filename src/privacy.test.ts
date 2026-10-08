import { test, expect } from 'bun:test'
import { fixture, cli } from './test-cli'

test('private creation, confirmed visibility, and collaborators send scoped v1 operations', async () => {
  const calls: { method: string; path: string; body: unknown }[] = []
  const f = await fixture(async (req) => {
    expect(req.headers.get('authorization')).toBe('Bearer gf_fixturetoken')
    const path = new URL(req.url).pathname,
      body =
        req.method === 'GET' || req.method === 'DELETE'
          ? null
          : await req.json()
    calls.push({ method: req.method, path, body })
    if (path === '/api/v1/user/repos')
      return Response.json({
        id: 1,
        name: 'secret',
        full_name: 'alice/secret',
        owner: {
          login: 'alice',
          id: 1,
          type: 'User',
          html_url: f.origin + '/alice',
        },
        private: true,
        stargazers_count: 0,
        description: null,
        default_branch: 'main',
        html_url: f.origin + '/alice/secret',
        url: f.origin + '/api/v1/repos/alice/secret',
        clone_url: f.origin + '/alice/secret.git',
        created_at: 'now',
        updated_at: 'now',
      })
    if (path.endsWith('/visibility')) return Response.json(body)
    if (path.endsWith('/collaborators'))
      return Response.json({
        collaborators: [{ login: 'reader', permission: 'read' }],
        invitations: [
          {
            id: 'pending',
            repo: 'opaque-repo',
            invitee: 'writer',
            permission: 'write',
            inviter: 'alice',
            created_at: 'now',
          },
        ],
      })
    return Response.json({ ok: true })
  })
  try {
    await f.identity()
    const create = await cli(f.root, [
      'repo',
      'create',
      'secret',
      '--private',
      '--server',
      f.origin,
    ])
    expect(create.code).toBe(0)
    expect(create.out).toContain('alice/secret')
    const common = ['--repo', 'alice/secret', '--server', f.origin]
    expect(
      (await cli(f.root, ['repo', 'visibility', 'private', ...common])).code,
    ).toBe(0)
    expect(
      (
        await cli(f.root, [
          'repo',
          'visibility',
          'public',
          '--confirm',
          'alice/secret',
          ...common,
        ])
      ).code,
    ).toBe(0)
    expect(
      (
        await cli(f.root, [
          'repo',
          'collaborators',
          'add',
          '@writer',
          '--role',
          'write',
          ...common,
        ])
      ).code,
    ).toBe(0)
    const list = await cli(f.root, ['repo', 'collaborators', 'ls', ...common])
    expect(list.code).toBe(0)
    expect(list.out).toContain('@reader  read')
    expect(list.out).toContain('@writer  write  pending')
    expect(
      (await cli(f.root, ['repo', 'collaborators', 'rm', 'writer', ...common]))
        .code,
    ).toBe(0)
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/user/repos',
        body: { name: 'secret', private: true },
      },
      {
        method: 'PATCH',
        path: '/api/v1/repos/alice/secret/visibility',
        body: { visibility: 'private' },
      },
      {
        method: 'PATCH',
        path: '/api/v1/repos/alice/secret/visibility',
        body: { visibility: 'public', confirm: 'alice/secret' },
      },
      {
        method: 'PUT',
        path: '/api/v1/repos/alice/secret/collaborators/writer',
        body: { permission: 'write' },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/alice/secret/collaborators',
        body: null,
      },
      {
        method: 'DELETE',
        path: '/api/v1/repos/alice/secret/collaborators/writer',
        body: null,
      },
    ])
  } finally {
    await f.close()
  }
})
