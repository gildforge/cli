import { expect, test } from 'bun:test'
import { GildClient } from './client'
import { fixture } from '../test-cli'
import { resolve } from 'node:path'

async function progressCLI(root: string, args: string[]) {
  const command: string[] = JSON.parse(
    process.env.TEST_GILD_COMMAND ??
      JSON.stringify([process.execPath, 'run', resolve('src/gild.ts')]),
  )
  const proc = Bun.spawn([...command, '--config-dir', root, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), 10000)
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, out, err }
  } finally {
    clearTimeout(timer)
  }
}

test('import CLI and client preserve optional progress metadata and accept legacy responses', async () => {
  for (const optional of [false, true]) {
    const progress = {
      phase: 'metadata' as const,
      completed: 4,
      message: 'Imported',
      ...(optional
        ? { default_branch: 'trunk', internal_prefix: 'import_/pr' }
        : {}),
    }
    const status = {
      repository: 'alice/demo',
      source: 'https://github.com/a/b',
      mirror: true,
      state: 'mirroring',
      progress,
      warnings: [],
      error: null,
      updated_at: '2020-01-01',
      next_sync: '2020-01-02',
    }
    const posted: unknown[] = []
    const f = await fixture(async (request) => {
      if (request.method === 'POST') posted.push(await request.json())
      if (new URL(request.url).pathname.endsWith('/batch'))
        return Response.json({ ok: true })
      return Response.json(status)
    })
    try {
      await f.identity()
      const client = new GildClient(f.origin + '/api/v1', 'gf_fixturetoken')
      const params = { owner: 'alice', repo: 'demo' }
      const fetched = await client.request('importStatus', params)
      expect(fetched.progress).toEqual(progress)
      const shown = await progressCLI(f.root, [
        'repo',
        'import-status',
        'alice/demo',
        '--server',
        f.origin,
      ])
      expect({ code: shown.code, err: shown.err }).toEqual({ code: 0, err: '' })
      expect(JSON.parse(shown.out).progress).toEqual(progress)
      expect(
        (await client.request('importHeartbeat', params, { progress }))
          .progress,
      ).toEqual(progress)
      expect(
        await client.request('importBatch', params, { records: [], progress }),
      ).toEqual({ ok: true })
      expect(posted).toEqual([{ progress }, { records: [], progress }])
      await expect(
        client.request('importHeartbeat', params, {
          progress: { ...progress, internal_prefix: 'invalid-prefix' },
        }),
      ).rejects.toThrow()
      await expect(
        client.request('importHeartbeat', params, {
          progress: { ...progress, default_branch: 'x'.repeat(301) },
        }),
      ).rejects.toThrow()
      expect(posted).toHaveLength(2)
    } finally {
      await f.close()
    }
  }
})
