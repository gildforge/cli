import { expect, test } from 'bun:test'
import { cli, fixture } from './test-cli'

const issue = {
  id: 1,
  number: 12,
  title: 'Triage me',
  body: 'it broke',
  user: {
    login: 'sami',
    id: 2,
    type: 'User',
    html_url: 'https://gild.gg/sami',
  },
  state: 'open',
  labels: [{ id: 3, name: 'triage', color: 'ff0000', description: null }],
  comments: 0,
  created_at: '2026-10-09T10:00:00.000Z',
  updated_at: '2026-10-09T10:00:00.000Z',
  closed_at: null,
  html_url: 'https://gild.gg/owner/demo/issues/12',
  url: 'https://gild.gg/api/v1/repos/owner/demo/issues/12',
}

async function setup() {
  const seen: { path: string; auth: string | null }[] = []
  const f = await fixture(() => new Response('{}'))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      seen.push({
        path: url.pathname,
        auth: request.headers.get('authorization'),
      })
      if (url.pathname === '/api/v1/repos/owner/demo/issues/12')
        return Response.json(issue)
      return Response.json({ message: 'nope' }, { status: 404 })
    },
  })
  const origin = server.url.origin
  await f.identity({ server: origin, token: 'gf_fixturetoken' })
  await f.agent()
  const agentFile = Bun.file(`${f.root}/agents/test.json`)
  await Bun.write(
    agentFile,
    (await agentFile.text()).replace(
      /"server":"[^"]*"/,
      `"server":"${origin}"`,
    ),
  )
  return {
    root: f.root,
    origin,
    seen,
    async close() {
      server.stop(true)
      await f.close()
    },
  }
}

test('issue view prints a readable issue, fetches as an agent with its own token', async () => {
  const s = await setup()
  try {
    const run = await cli(s.root, [
      'issue',
      'view',
      'owner/demo#12',
      '--agent',
      'test',
    ])
    expect(run.code).toBe(0)
    expect(run.out).toBe(
      '#12 [open] Triage me — @sami\nlabels: triage\nit broke\n',
    )
    expect(run.err).toBe('')
    expect(s.seen).toEqual([
      {
        path: '/api/v1/repos/owner/demo/issues/12',
        auth: 'Bearer gf_agentfixture',
      },
    ])
    expect(run.out + run.err).not.toContain('gf_')
    const asJson = await cli(s.root, [
      'issue',
      'view',
      'owner/demo#12',
      '--json',
      '--server',
      s.origin,
    ])
    expect(asJson.code).toBe(0)
    expect(JSON.parse(asJson.out)).toEqual(issue)
  } finally {
    await s.close()
  }
})

test('issue view rejects a reference without #number', async () => {
  const s = await setup()
  try {
    const run = await cli(s.root, [
      'issue',
      'view',
      'owner/demo',
      '--server',
      s.origin,
    ])
    expect(run.code).toBe(1)
    expect(run.err).toContain('Use owner/repo#number')
  } finally {
    await s.close()
  }
})
