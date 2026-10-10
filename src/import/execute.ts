import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { retryImport } from './retry'
import { GildClient } from '../api/client'
import type { z } from 'zod'
import type { importAssignment, ImportRecord } from '../api/import-contract'
import { sourceURL, metadata } from './source'
import { publicFetch } from './http'
import { NativeImport } from './git'
import { githubReadToken } from './auth'
import { snapshotFetch } from './snapshot'
export async function executeImport(
  server: string,
  job: z.infer<typeof importAssignment>,
  root: string,
  signal: AbortSignal,
  log: (message: string) => void = console.log,
  sourceFetch: typeof publicFetch = publicFetch,
  anonymous = false,
) {
  const [owner, repo] = job.repository.split('/'),
    params = { owner, repo },
    client = new GildClient(server.replace(/\/$/, '') + '/api/v1', job.token)
  let progress: {
      phase: 'git' | 'metadata' | 'workflows'
      completed: number
      message: string
    } = { phase: 'git', completed: 0, message: 'Starting Git import' },
    heartbeatError: unknown
  const retry = <T>(work: () => Promise<T>) => retryImport(work, signal, log)
  let heartbeatRunning = false
  const timer = setInterval(() => {
    if (heartbeatRunning) return
    heartbeatRunning = true
    void retry(() =>
      client.request('importHeartbeat', params, { progress }, {}, { signal }),
    )
      .then(() => {
        heartbeatError = undefined
      })
      .catch((e) => {
        heartbeatError = e
      })
      .finally(() => {
        heartbeatRunning = false
      })
  }, 30000)
  const started = performance.now()
  const warnings: string[] =
    job.forge === 'git'
      ? ['Git only: metadata import is available for GitHub and GitLab']
      : []
  const path = join(
    root,
    'imports',
    createHash('sha256')
      .update(server + '\0' + job.repository + '\0' + job.source)
      .digest('hex') + '.git',
  )
  const native = new NativeImport({
    source: job.source,
    sourceToken: job.source_token,
    directory: path,
    signal,
    credentials: () =>
      retry(() =>
        client.request('importCredentials', params, undefined, {}, { signal }),
      ),
    progress: (message, completed = 0) => {
      if (progress.phase === 'git')
        progress = { phase: 'git', message, completed }
      log(message)
    },
  })
  try {
    const branch = await native.fetch(),
      stats = await native.push(async (internal_prefix) => {
        await retry(() =>
          client.request(
            'importHeartbeat',
            params,
            {
              progress: {
                ...progress,
                default_branch: native.branch(branch),
                internal_prefix,
              },
            },
            {},
            { signal },
          ),
        )
      })
    log(
      `Git verified: ${stats.branches} branches, ${stats.tags} tags, ${stats.commits} commits`,
    )
    progress = {
      phase: 'metadata',
      completed: job.checkpoint
        ? (JSON.parse(job.checkpoint).completed ?? 0)
        : 0,
      message: 'Importing source metadata',
    }
    let records: ImportRecord[] = [],
      bytes = 0,
      checkpoint = job.checkpoint
    const metadataToken =
      job.source_token ??
      (job.forge === 'github' ? await githubReadToken(anonymous) : undefined)
    const flush = async (next?: string) => {
      if (heartbeatError) throw heartbeatError
      if (signal.aborted) throw Error('Import cancelled')
      if (!records.length && next === undefined) return
      const completed = progress.completed + records.length
      if (next !== undefined)
        next = JSON.stringify({ ...JSON.parse(next), completed })
      await retry(() =>
        client.request(
          'importBatch',
          params,
          {
            records,
            progress: {
              ...progress,
              completed,
              checkpoint: next ?? checkpoint,
            },
          },
          {},
          { signal },
        ),
      )
      progress.completed = completed
      if (next !== undefined) checkpoint = next
      records = []
      bytes = 0
      log(`Metadata: ${progress.completed} records`)
    }
    for await (const event of metadata({
      source: sourceURL(job.source, job.forge),
      token: metadataToken,
      destination: server + '/' + job.repository,
      checkpoint: job.checkpoint,
      signal,
      fetcher: await snapshotFetch(
        path + '.metadata',
        !!job.checkpoint,
        sourceFetch,
      ),
      log,
      head: (ref, n) => native.head(ref, n),
      branch: (ref) => native.branch(ref),
    })) {
      for (const record of event.records) {
        const size = Buffer.byteLength(JSON.stringify(record))
        if (size > 192 * 1024)
          throw Error('Source metadata item exceeds the request limit')
        if (bytes + size > 192 * 1024 || records.length >= 40) await flush()
        records.push(record)
        bytes += size
      }
      if (event.checkpoint !== undefined) await flush(event.checkpoint)
    }
    await flush()
    const recordCount = progress.completed
    progress = {
      phase: 'workflows',
      completed: 0,
      message: 'Checking Actions compatibility',
    }
    for (const workflow of await native.workflows(branch)) {
      const result = await retry(() =>
        client.request('importWorkflow', params, workflow),
      )
      warnings.push(...result.warnings)
      progress.completed++
    }
    const status = await retry(() =>
      client.request('importFinish', params, {
        warnings,
        default_branch: native.branch(branch),
        summary: {
          ...stats,
          records: recordCount,
          elapsed_ms: performance.now() - started,
        },
      }),
    )
    log(`Imported ${job.repository}; ${status.state}`)
    for (const warning of warnings) log(warning)
    return status
  } catch (error) {
    await client
      .request('importFinish', params, {
        warnings,
        error: 'Import interrupted',
      })
      .catch(() => {})
    throw error
  } finally {
    clearInterval(timer)
  }
}
