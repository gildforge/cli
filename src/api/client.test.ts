import { test, expect } from 'bun:test'
import { GildClient, ApiRequestError, requestPath } from './client'
test('client validates input before a mutation and encodes GitHub contents paths', async () => {
  let calls = 0
  const client = new GildClient(
    'https://forge.test/api/v1',
    'fixture',
    async (input, init) => {
      calls++
      expect(String(input)).toBe(
        'https://forge.test/api/v1/repos/acme/demo/contents/src/a%20b.ts?ref=main',
      )
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer fixture',
      )
      return Response.json({
        type: 'file',
        name: 'a b.ts',
        path: 'src/a b.ts',
        sha: '1'.repeat(40),
        size: 0,
        url: 'url',
        html_url: 'url',
        git_url: 'url',
        download_url: null,
        encoding: 'base64',
        content: '',
      })
    },
  )
  await expect(
    client.request(
      'createIssue',
      { owner: 'acme', repo: 'demo' },
      { title: '' },
    ),
  ).rejects.toThrow()
  expect(calls).toBe(0)
  const file = await client.request(
    'contents',
    { owner: 'acme', repo: 'demo', path: 'src/a b.ts' },
    undefined,
    { ref: 'main' },
  )
  expect(Array.isArray(file)).toBe(false)
  expect(calls).toBe(1)
})
test('malformed responses and GitHub error envelopes fail the client', async () => {
  const broken = new GildClient(
    'https://forge.test/api/v1',
    'fixture',
    async () => Response.json({ made_up: true }),
  )
  await expect(broken.request('repos')).rejects.toThrow()
  const forbidden = new GildClient(
    'https://forge.test/api/v1',
    'fixture',
    async () =>
      Response.json(
        { message: 'Requires issues:write scope' },
        { status: 403 },
      ),
  )
  try {
    await forbidden.request('repos')
    throw Error('Expected rejection')
  } catch (e) {
    expect(e).toBeInstanceOf(ApiRequestError)
    expect((e as ApiRequestError).status).toBe(403)
  }
})
test('native runner adapters resolve the canonical route and pass idempotency keys', async () => {
  const client = new GildClient(
    'https://forge.test/api/v1',
    'fixture',
    async (input, init) => {
      expect(String(input)).toBe(
        'https://forge.test/api/v1/repos/acme/demo/actions/runners/heartbeat',
      )
      expect(JSON.parse(String(init?.body))).toEqual({ job: null, lease: null })
      return Response.json({ cancel: false })
    },
  )
  expect(
    await requestPath(
      client,
      'POST',
      '/repos/acme/demo/actions/runners/heartbeat',
      { job: null, lease: null },
    ),
  ).toEqual({ cancel: false })
  await expect(requestPath(client, 'POST', '/unknown', {})).rejects.toThrow(
    'Unknown API operation',
  )
})
