import { fixture } from './test-cli'

export const headSha = 'a'.repeat(40)
const user = {
  login: 'alice/test',
  id: 2,
  type: 'Bot',
  html_url: 'http://forge/alice/test',
}
export const issueFixture = {
  id: 1,
  number: 12,
  title: 'Fix it',
  body: 'Details',
  user,
  state: 'open',
  labels: [{ id: 1, name: 'triage', color: 'ff0000', description: null }],
  comments: 0,
  created_at: 'now',
  updated_at: 'now',
  closed_at: null,
  html_url: 'http://forge/owner/demo/issues/12',
  url: 'http://forge/api/v1/repos/owner/demo/issues/12',
}
const repository = {
  id: 1,
  name: 'demo',
  full_name: 'owner/demo',
  owner: user,
  private: true,
  stargazers_count: 0,
  description: null,
  default_branch: 'main',
  html_url: 'http://forge/owner/demo',
  url: 'http://forge/api/v1/repos/owner/demo',
  clone_url: 'http://forge/owner/demo.git',
  created_at: 'now',
  updated_at: 'now',
}
export const pullFixture = {
  ...issueFixture,
  html_url: 'http://forge/owner/demo/pull/12',
  head: { label: 'work', ref: 'work', sha: headSha, repo: repository },
  base: { label: 'main', ref: 'main', sha: 'b'.repeat(40), repo: repository },
  merged: false,
  merged_at: null,
  merge_commit_sha: null,
  mergeable: true,
  draft: false,
  diff_url: 'http://forge/diff',
  patch_url: 'http://forge/patch',
}
export const commentFixture = {
  id: 1,
  node_id: 'comment',
  user,
  body: 'Discuss',
  created_at: 'now',
  updated_at: 'now',
  html_url: 'http://forge/comment/1',
  url: 'http://forge/api/comment/1',
}
export const reviewFixture = {
  id: 1,
  user,
  body: 'Looks good',
  state: 'APPROVED',
  submitted_at: 'now',
  commit_id: headSha,
  html_url: 'http://forge/review/1',
}
export const diffFixture = [
  {
    sha: headSha,
    filename: 'hello.txt',
    status: 'added',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: 'diff --git a/hello.txt b/hello.txt\n+hello',
    blob_url: '',
    raw_url: '',
    contents_url: '',
  },
]
export const runsFixture = [
  {
    id: 9,
    name: 'test',
    head_branch: 'work',
    head_sha: headSha,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    run_number: 1,
    created_at: 'now',
    updated_at: 'now',
    html_url: 'http://forge/actions/9',
    url: '',
    workflow_id: 1,
    actor: user,
  },
]
export const mergeFixture = {
  sha: null,
  merged: false,
  queued: true,
  message: 'Queued for merge',
}

export async function forgeFixture() {
  const seen: {
    method: string
    path: string
    query: string
    auth: string | null
    body: unknown
  }[] = []
  const f = await fixture(async (r) => {
    const url = new URL(r.url)
    const body = r.method === 'GET' ? undefined : await r.json()
    seen.push({
      method: r.method,
      path: url.pathname,
      query: url.search,
      auth: r.headers.get('authorization'),
      body,
    })
    if (
      r.headers.get('authorization') !== 'Bearer gf_agentfixture' &&
      r.headers.get('authorization') !== 'Bearer gf_fixturetoken'
    )
      return Response.json({ message: 'Wrong identity' }, { status: 403 })
    if (url.pathname.endsWith('/merge'))
      return Response.json(mergeFixture, { status: 202 })
    if (url.pathname.endsWith('/reviews'))
      return Response.json(reviewFixture, { status: 201 })
    if (url.pathname.endsWith('/comments'))
      return Response.json(commentFixture, { status: 201 })
    if (url.pathname.endsWith('/files')) return Response.json(diffFixture)
    if (url.pathname.includes('/actions/commits/'))
      return Response.json(runsFixture)
    if (url.pathname.endsWith('/pulls'))
      return Response.json(r.method === 'GET' ? [pullFixture] : pullFixture)
    if (url.pathname.endsWith('/pulls/12')) return Response.json(pullFixture)
    if (url.pathname.includes('/issues')) return Response.json(issueFixture)
    return Response.json(
      { message: 'Forge refused this operation' },
      { status: 403 },
    )
  })
  await f.identity()
  await f.agent()
  return { ...f, seen }
}
