import { expect, test } from 'bun:test'
import { ApiRequestError, GildClient } from './client'
import type { Output } from './contract'

const params = { owner: 'fixture', repo: 'demo' }
const sha = 'a'.repeat(40)
const origin = 'https://fixture.invalid'

/** Injected transport only: no sockets, credentials, identity or provider.
 * Fixtures exercise the accepted generated client, never define a schema. */
function transport(responses: Response[]) {
  const calls: {
    method: string
    path: string
    authorization: string | null
  }[] = []
  const remaining = [...responses]
  const client = new GildClient(
    origin + '/api/v1',
    'gf_fakefixture',
    async (input, init) => {
      const url = new URL(String(input))
      if (url.origin !== origin) throw Error('Unexpected fixture destination')
      calls.push({
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      const response = remaining.shift()
      if (!response) throw Error('Unexpected extra request')
      return response
    },
  )
  return { client, calls, remaining }
}

const refs = [
  {
    ref: 'refs/heads/main',
    node_id: 'fixture-ref',
    url: origin + '/api/v1/repos/fixture/demo/git/ref/heads/main',
    object: {
      type: 'commit',
      sha,
      url: origin + '/api/v1/repos/fixture/demo/git/commits/' + sha,
    },
  },
] satisfies Output<'refs'>
const health = {
  lines: 1,
  scores: {
    quality: 90,
    containment: 80,
    legibility: 70,
    security: 60,
    modularity: 50,
  },
  rules: [],
  calibrated: false,
} satisfies NonNullable<Output<'health'>>
const changes = {
  from: null,
  to: sha,
  files: [
    {
      path: 'README.md',
      status: 'added',
      additions: 1,
      deletions: 0,
      hunks: [{ oldStart: 0, newStart: 1, lines: ['+fixture'] }],
    },
  ],
  truncated: false,
  total: 1,
  sizes: [{ path: 'README.md', lines: 1 }],
} satisfies Output<'commitChanges'>

test('existing refs, health and diff success payloads survive generated-client decoding', async () => {
  const f = transport([
    Response.json(refs),
    Response.json(health),
    Response.json(changes),
  ])
  expect(await f.client.request('refs', params)).toEqual(refs)
  expect(
    await f.client.request('health', params, undefined, { ref: 'main' }),
  ).toEqual(health)
  expect(await f.client.request('commitChanges', { ...params, sha })).toEqual(
    changes,
  )
  expect(f.calls).toEqual([
    {
      method: 'GET',
      path: '/api/v1/repos/fixture/demo/git/refs',
      authorization: 'Bearer gf_fakefixture',
    },
    {
      method: 'GET',
      path: '/api/v1/repos/fixture/demo/health?ref=main',
      authorization: 'Bearer gf_fakefixture',
    },
    {
      method: 'GET',
      path: '/api/v1/repos/fixture/demo/changes/' + sha,
      authorization: 'Bearer gf_fakefixture',
    },
  ])
  expect(f.remaining).toHaveLength(0)
})

test('legitimate empty refs, score and changes remain successful values', async () => {
  const emptyHealth = {
    lines: 0,
    scores: null,
    rules: [],
    calibrated: false,
  } satisfies NonNullable<Output<'health'>>
  const emptyChanges = {
    from: sha,
    to: sha,
    files: [],
    truncated: false,
    total: 0,
    sizes: [],
  } satisfies Output<'commitChanges'>
  const f = transport([
    Response.json([]),
    Response.json(emptyHealth),
    Response.json(emptyChanges),
  ])
  expect(await f.client.request('refs', params)).toEqual([])
  expect(await f.client.request('health', params)).toEqual(emptyHealth)
  expect(await f.client.request('commitChanges', { ...params, sha })).toEqual(
    emptyChanges,
  )
  expect(f.calls).toHaveLength(3)
})

for (const [status, code, message] of [
  [404, 'NOT_FOUND', 'Repository not found'],
  [403, 'FORBIDDEN', 'Requires repo:read scope'],
  [503, 'PREPARATION_PENDING', 'Repository is being prepared'],
] as const) {
  test(`HTTP ${status} retains status/code instead of becoming an empty prepared result`, async () => {
    const response = Response.json(
      {
        message,
        errors: [{ code }],
        // Malicious extra fields must not become a client result or error payload.
        claim: { email: 'PRIVATE_CLAIM_EMAIL_FAKE_MARKER' },
        token: 'PRIVATE_TOKEN_FAKE_MARKER',
      },
      { status, headers: status === 503 ? { 'retry-after': '1' } : {} },
    )
    const f = transport([response])
    let caught: unknown
    try {
      await f.client.request('refs', params)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ApiRequestError)
    const error = caught as ApiRequestError
    expect({
      status: error.status,
      code: error.code,
      codes: error.codes,
      message: error.message,
    }).toEqual({ status, code, codes: [code], message })
    expect(f.calls).toHaveLength(1) // Neither retry nor token escalation.
    expect(f.calls[0]!.authorization).toBe('Bearer gf_fakefixture')
    expect(JSON.stringify(error)).not.toContain(
      'PRIVATE_CLAIM_EMAIL_FAKE_MARKER',
    )
    expect(JSON.stringify(error)).not.toContain('PRIVATE_TOKEN_FAKE_MARKER')
    // Retry-After remains a server transport header; current client exposes
    // status/code only and does not promise a parsed retry deadline.
  })
}

test('old-server plain and non-JSON errors remain final without requiring new codes', async () => {
  const f = transport([
    Response.json(
      { message: 'Repository is indexing; retry shortly' },
      { status: 503 },
    ),
    new Response('gateway unavailable', { status: 503 }),
  ])
  for (const message of ['Repository is indexing; retry shortly', 'HTTP 503']) {
    let caught: unknown
    try {
      await f.client.request('health', params)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ApiRequestError)
    const error = caught as ApiRequestError
    expect({
      status: error.status,
      codes: error.codes,
      message: error.message,
    }).toEqual({ status: 503, codes: [], message })
  }
  expect(f.calls).toHaveLength(2)
})

test('a 200 Pending envelope cannot masquerade as successful legacy refs, health or diff', async () => {
  const f = transport([
    Response.json({ state: 'pending' }),
    Response.json({ state: 'pending' }),
    Response.json({ state: 'pending' }),
  ])
  await expect(f.client.request('refs', params)).rejects.toThrow()
  await expect(f.client.request('health', params)).rejects.toThrow()
  await expect(
    f.client.request('commitChanges', { ...params, sha }),
  ).rejects.toThrow()
  expect(f.calls).toHaveLength(3)
})

test('legacy compare and nullable health preserve their established payloads', async () => {
  const commit = {
    sha,
    node_id: 'fixture-commit',
    url: origin + '/commit/' + sha,
    html_url: origin + '/fixture/demo/commit/' + sha,
    commit: {
      message: 'fixture',
      author: {
        name: 'fixture',
        email: 'public@example.invalid',
        date: '2026-01-01T00:00:00Z',
      },
      committer: {
        name: 'fixture',
        email: 'public@example.invalid',
        date: '2026-01-01T00:00:00Z',
      },
      tree: { sha, url: origin + '/tree/' + sha },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: [],
  } satisfies Output<'compare'>['base_commit']
  const compare = {
    url: origin + '/compare/main...topic',
    html_url: origin + '/fixture/demo/compare/main...topic',
    status: 'identical',
    ahead_by: 0,
    behind_by: 0,
    total_commits: 0,
    base_commit: commit,
    merge_base_commit: commit,
    commits: [],
    files: [],
  } satisfies Output<'compare'>
  const f = transport([Response.json(compare), Response.json(null)])
  expect(
    await f.client.request('compare', {
      ...params,
      base: 'main',
      head: 'topic',
    }),
  ).toEqual(compare)
  expect(await f.client.request('health', params)).toBeNull()
  expect(f.calls.map((call) => call.path)).toEqual([
    '/api/v1/repos/fixture/demo/compare/main...topic',
    '/api/v1/repos/fixture/demo/health',
  ])
})

test('signed new read operations decode canonical DTOs and strip internal profile/claim fields', async () => {
  const cards = {
    owner: 'fixture',
    items: [],
    nextPage: null,
  } satisfies Output<'ownerRepoCards'>
  const display = {
    name: 'fixture',
    kind: 'user',
    profile: {
      displayName: 'Fixture',
      publicEmail: 'public@example.invalid',
      description: 'Public bio',
      url: '',
      socialLinks: [],
      location: '',
    },
    picture: { url: null, source: 'None' },
  } satisfies Output<'publicDisplayProfile'>
  const view = {
    viewer: {
      name: 'fixture/worker',
      kind: 'agent',
      displayName: 'Worker',
      picture: { url: null, source: 'None' },
    },
    canCreateRepository: false,
    repository: {
      owner: 'fixture',
      name: 'demo',
      read: true,
      editPackageManifest: false,
      pushNonDefaultBranch: true,
      pushDefaultBranch: false,
      updateSettings: false,
    },
  } satisfies Output<'viewerContext'>
  const f = transport([
    Response.json(cards),
    Response.json({
      ...display,
      claim: {
        email: 'PRIVATE_CLAIM_FAKE_MARKER',
        publicKey: 'PRIVATE_KEY_FAKE_MARKER',
      },
      profile: { ...display.profile, picture: 'RAW_PICTURE_FAKE_MARKER' },
    }),
    Response.json({
      ...view,
      viewer: { ...view.viewer, email: 'PRIVATE_VIEWER_EMAIL_FAKE_MARKER' },
      acl: { owners: ['PRIVATE_ACL_FAKE_MARKER'] },
    }),
  ])
  expect(
    await f.client.request('ownerRepoCards', { owner: 'fixture' }, undefined, {
      page: 1,
      per_page: 30,
    }),
  ).toEqual(cards)
  const parsedDisplay = await f.client.request('publicDisplayProfile', {
    owner: 'fixture',
  })
  expect(parsedDisplay).toEqual(display)
  const parsedView = await f.client.request('viewerContext', {}, undefined, {
    owner: 'fixture',
    repo: 'demo',
  })
  expect(parsedView).toEqual(view)
  for (const marker of [
    'PRIVATE_CLAIM_FAKE_MARKER',
    'PRIVATE_KEY_FAKE_MARKER',
    'RAW_PICTURE_FAKE_MARKER',
    'PRIVATE_VIEWER_EMAIL_FAKE_MARKER',
    'PRIVATE_ACL_FAKE_MARKER',
  ])
    expect(JSON.stringify([parsedDisplay, parsedView])).not.toContain(marker)
  expect(f.calls.map((call) => call.path)).toEqual([
    '/api/v1/owners/fixture/repositories?page=1&per_page=30',
    '/api/v1/owners/fixture/profile',
    '/api/v1/viewer/context?owner=fixture&repo=demo',
  ])
})

test('operation-specific viewer capabilities require booleans and cannot inherit a generic write flag', async () => {
  const view = {
    viewer: {
      name: 'fixture/worker',
      kind: 'agent',
      displayName: 'Worker',
      picture: { url: null, source: 'None' },
    },
    canCreateRepository: false,
    repository: {
      owner: 'fixture',
      name: 'demo',
      read: true,
      editPackageManifest: false,
      pushNonDefaultBranch: true,
      pushDefaultBranch: false,
      updateSettings: false,
    },
  } satisfies Output<'viewerContext'>
  const f = transport([
    Response.json({ ...view, repository: { ...view.repository, write: true } }),
    Response.json({
      ...view,
      repository: { ...view.repository, pushDefaultBranch: 'false' },
    }),
    Response.json({
      viewer: view.viewer,
      canCreateRepository: false,
      repository: { owner: 'fixture', name: 'demo', read: true, write: true },
    }),
  ])
  expect(await f.client.request('viewerContext')).toEqual(view)
  await expect(f.client.request('viewerContext')).rejects.toThrow()
  await expect(f.client.request('viewerContext')).rejects.toThrow()
  expect(f.calls).toHaveLength(3)
})

test('literal channel and session additions preserve old roster payloads and safe optional observations', async () => {
  const participant = {
    name: 'fixture/worker',
    kind: 'agent',
    prefix: '@',
    sponsor: 'fixture',
    scopes: ['repo:read'],
    online: false,
    state: null,
  } satisfies Output<'channelParticipants'>['participants'][number]
  const legacy = {
    participants: [participant],
    can_post: false,
    viewer: 'fixture',
  } satisfies Output<'channelParticipants'>
  const observation = {
    id: '00000000-0000-4000-8000-000000000000',
    started_at: '2026-01-01T00:00:00Z',
    ended_at: null,
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    closed: false,
    runtime: {
      mode: 'HOST',
      worker: {
        id: '00000000-0000-4000-8000-000000000000',
        name: 'Fixture worker',
      },
      host: { os: 'macos', version: '26.0' },
      observed_at: '2026-01-01T00:00:00Z',
    },
  } satisfies NonNullable<
    Output<'channelParticipants'>['participants'][number]['session']
  >
  const extended = {
    ...legacy,
    participants: [{ ...participant, session: observation }],
  } satisfies Output<'channelParticipants'>
  const f = transport([
    Response.json(legacy),
    Response.json(extended),
    Response.json({
      ...legacy,
      participants: [
        {
          ...participant,
          session: {
            ...observation,
            runtime: {
              ...observation.runtime,
              worker: {
                ...observation.runtime.worker,
                name: 'Bearer gf_FAKE_MARKER',
              },
            },
          },
        },
      ],
    }),
  ])
  expect(await f.client.request('channelParticipants', params)).toEqual(legacy)
  expect(await f.client.request('channelParticipants', params)).toEqual(
    extended,
  )
  await expect(
    f.client.request('channelParticipants', params),
  ).rejects.toThrow()
  expect(f.calls).toHaveLength(3)
})
