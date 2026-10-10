import { expect, test } from 'bun:test'
import { cli } from './test-cli'
import {
  forgeFixture,
  headSha,
  issueFixture,
  pullFixture,
  commentFixture,
  reviewFixture,
  diffFixture,
  runsFixture,
  mergeFixture,
} from './forge-test'

const prefix = '/api/v1/repos/owner/demo'
const cases = [
  {
    args: [
      'issue',
      'create',
      'owner/demo',
      '--title',
      'Fix it',
      '-b',
      'Details',
      '--label',
      'triage',
    ],
    method: 'POST',
    path: '/issues',
    body: { title: 'Fix it', body: 'Details', labels: ['triage'] },
    result: issueFixture,
  },
  {
    args: ['issue', 'comment', 'owner/demo', '12', '-b', 'Discuss'],
    method: 'POST',
    path: '/issues/12/comments',
    body: { body: 'Discuss' },
    result: commentFixture,
  },
  {
    args: ['issue', 'close', 'owner/demo#12'],
    method: 'PATCH',
    path: '/issues/12',
    body: { state: 'closed' },
    result: issueFixture,
  },
  {
    args: [
      'issue',
      'label',
      'owner/demo#12',
      '--add',
      'ready',
      'ready',
      '--remove',
      'triage',
    ],
    method: 'PATCH',
    path: '/issues/12',
    body: { labels: ['ready'] },
    result: issueFixture,
  },
  {
    args: [
      'pr',
      'create',
      'owner/demo',
      '--head',
      'work',
      '--title',
      'Fix it',
      '-b',
      'Details',
    ],
    method: 'POST',
    path: '/pulls',
    body: { head: 'work', base: 'main', title: 'Fix it', body: 'Details' },
    result: pullFixture,
  },
  {
    args: ['pr', 'list', 'owner/demo'],
    method: 'GET',
    path: '/pulls',
    result: [pullFixture],
  },
  {
    args: ['pr', 'view', 'owner/demo#12'],
    method: 'GET',
    path: '/pulls/12',
    result: pullFixture,
  },
  {
    args: ['pr', 'diff', 'owner/demo#12'],
    method: 'GET',
    path: '/pulls/12/files',
    result: diffFixture,
  },
  {
    args: ['pr', 'checks', 'owner/demo#12'],
    method: 'GET',
    path: `/actions/commits/${headSha}`,
    result: runsFixture,
  },
  {
    args: ['pr', 'comment', 'owner/demo#12', '-b', 'Discuss'],
    method: 'POST',
    path: '/issues/12/comments',
    body: { body: 'Discuss' },
    result: commentFixture,
  },
  ...[
    ['--approve', 'APPROVE'],
    ['--request-changes', 'REQUEST_CHANGES'],
    ['--comment', 'COMMENT'],
  ].map(([flag, event]) => ({
    args: ['pr', 'review', 'owner/demo#12', flag, '-b', 'Looks good'],
    method: 'POST',
    path: '/pulls/12/reviews',
    body: { event, body: 'Looks good' },
    result: reviewFixture,
  })),
  {
    args: ['pr', 'merge', 'owner/demo#12'],
    method: 'PUT',
    path: '/pulls/12/merge',
    body: { sha: headSha, merge_method: 'merge' },
    result: mergeFixture,
  },
]
for (const c of cases) {
  test(`agent workflow: ${c.args.slice(0, 2).join(' ')} ${c.args.includes('review') ? c.args[3] : ''}`, async () => {
    const f = await forgeFixture()
    try {
      const run = await cli(f.root, [...c.args, '--agent', 'test', '--json'])
      expect(run.code).toBe(0)
      expect(run.err).toBe('')
      expect(JSON.parse(run.out)).toEqual(c.result)
      expect(run.out + run.err).not.toContain('gf_')
      const last = f.seen.at(-1)!
      expect({ method: last.method, path: last.path, body: last.body }).toEqual(
        {
          method: c.method,
          path: prefix + c.path,
          body: 'body' in c ? c.body : undefined,
        },
      )
      expect(f.seen.every((r) => r.auth === 'Bearer gf_agentfixture')).toBe(
        true,
      )
      if (c.args[1] === 'list')
        expect(last.query).toBe('?state=open&page=1&per_page=30')
      if (c.args[1] === 'checks' || c.args[1] === 'merge')
        expect(f.seen[0].path).toBe(prefix + '/pulls/12')
      f.seen.length = 0
      const human = await cli(f.root, [
        ...c.args,
        '--server',
        f.origin,
        '--json',
      ])
      expect(human.code).toBe(0)
      expect(human.out + human.err).not.toContain('gf_')
      expect(f.seen.every((r) => r.auth === 'Bearer gf_fixturetoken')).toBe(
        true,
      )
      const readable = await cli(f.root, [...c.args, '--agent', 'test'])
      expect(readable.code).toBe(0)
      expect(readable.out + readable.err).not.toContain('gf_')
      if (c.args[1] === 'diff') {
        expect(readable.out).toContain('hello.txt')
        expect(readable.out).toContain('+hello')
      } else if (c.args[1] === 'checks')
        expect(readable.out).toContain('9 test success')
      else if (c.args[1] === 'list' || c.args[1] === 'view')
        expect(readable.out).toContain('#12 [open] Fix it')
      else if (c.args[1] === 'merge')
        expect(readable.out).toBe('Queued for merge\n')
      else
        expect(readable.out.trim()).toBe(
          (c.result as { html_url: string }).html_url,
        )
    } finally {
      await f.close()
    }
  })
}

test('workflow errors preserve the server message, agent failures never fall back to human', async () => {
  const f = await forgeFixture()
  try {
    const refused = await cli(f.root, [
      'pr',
      'view',
      'owner/demo#99',
      '--agent',
      'test',
    ])
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('Forge refused this operation')
    expect(refused.out + refused.err).not.toContain('gf_')
    f.seen.length = 0
    const missing = await cli(f.root, [
      'pr',
      'view',
      'owner/demo#12',
      '--agent',
      'missing',
    ])
    expect(missing.code).toBe(1)
    expect(f.seen.length).toBe(0)
    const conflicting = await cli(f.root, [
      'pr',
      'review',
      'owner/demo#12',
      '--agent',
      'test',
      '--approve',
      '--comment',
    ])
    expect(conflicting.code).toBe(1)
    expect(f.seen.length).toBe(0)
    const wrongServer = await cli(f.root, [
      'pr',
      'view',
      'owner/demo#12',
      '--agent',
      'test',
      '--server',
      'http://localhost:1',
    ])
    expect(wrongServer.code).toBe(1)
    expect(f.seen.length).toBe(0)
  } finally {
    await f.close()
  }
})
