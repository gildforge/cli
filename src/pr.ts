import { Command, InvalidArgumentError } from 'commander'
import { repoPair } from './chat'
import {
  forgeCommand,
  numberedRef,
  printResult,
  type ForgeOptions,
  type ForgeResolve,
} from './forge-command'

export function prCommands(program: Command, resolve: ForgeResolve) {
  const group = program
    .command('pr')
    .description('read and manage pull requests')
  forgeCommand(group, 'create <repo>', 'open a pull request')
    .requiredOption('--head <branch>', 'head branch')
    .option('--base <branch>', 'base branch', 'main')
    .requiredOption('--title <title>', 'pull request title')
    .option('-b, --body <body>', 'pull request body', '')
    .action(
      async (
        repo: string,
        opts: ForgeOptions & {
          head: string
          base: string
          title: string
          body: string
        },
      ) => {
        printResult(
          await (
            await resolve(opts)
          ).request('createPull', repoPair(repo), {
            head: opts.head,
            base: opts.base,
            title: opts.title,
            body: opts.body,
          }),
          opts.json,
        )
      },
    )
  forgeCommand(group, 'list <repo>', 'list pull requests')
    .option('--state <state>', 'open, closed, or all', 'open')
    .option('--page <page>', 'page number', '1')
    .option('--limit <limit>', 'page size', '30')
    .action(
      async (
        repo: string,
        opts: ForgeOptions & { state: string; page: string; limit: string },
      ) => {
        if (!['open', 'closed', 'all'].includes(opts.state))
          throw new InvalidArgumentError('Use --state open, closed, or all')
        const page = Number(opts.page),
          limit = Number(opts.limit)
        if (!Number.isInteger(page) || page < 1 || page > 10000)
          throw new InvalidArgumentError(
            '--page must be an integer from 1 to 10000',
          )
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new InvalidArgumentError(
            '--limit must be an integer from 1 to 100',
          )
        const pulls = await (
          await resolve(opts, true)
        ).request('pulls', repoPair(repo), undefined, {
          state: opts.state as 'open' | 'closed' | 'all',
          page,
          per_page: limit,
        })
        if (opts.json) return console.log(JSON.stringify(pulls))
        for (const p of pulls)
          console.log(
            `#${p.number} [${p.state}] ${p.title} (${p.head.ref} → ${p.base.ref})`,
          )
      },
    )
  for (const action of ['view', 'diff', 'checks'] as const) {
    forgeCommand(group, `${action} <ref>`, `${action} a pull request`).action(
      async (ref: string, opts: ForgeOptions) => {
        const params = numberedRef(ref),
          client = await resolve(opts, true)
        if (action === 'diff') {
          const files = []
          for (let page = 1; ; page++) {
            const batch = await client.request('pullFiles', params, undefined, {
              per_page: 100,
              page,
            })
            files.push(...batch)
            if (batch.length < 100) break
          }
          if (opts.json) return console.log(JSON.stringify(files))
          for (const f of files)
            console.log(
              `${f.status}: ${f.filename} (+${f.additions} -${f.deletions})${f.patch ? '\n' + f.patch : ''}`,
            )
          return
        }
        const p = await client.request('pull', params)
        if (action === 'checks') {
          const runs = await client.request('actionCommitRuns', {
            ...params,
            sha: p.head.sha,
          })
          if (opts.json) return console.log(JSON.stringify(runs))
          for (const run of runs)
            console.log(
              `${run.id} ${run.name} ${run.conclusion ?? run.status} ${run.html_url}`,
            )
          if (!runs.length) console.log('No Actions runs for the head commit')
          return
        }
        if (opts.json) return console.log(JSON.stringify(p))
        console.log(
          `#${p.number} [${p.merged ? 'merged' : p.state}] ${p.title} — @${p.user.login}\n${p.head.ref} → ${p.base.ref}\n${p.html_url}`,
        )
        if (p.body) console.log(p.body)
      },
    )
  }
  forgeCommand(group, 'comment <ref>', 'post a conversation comment')
    .requiredOption('-b, --body <body>', 'comment body')
    .action(async (ref: string, opts: ForgeOptions & { body: string }) => {
      printResult(
        await (
          await resolve(opts)
        ).request('createIssueComment', numberedRef(ref), { body: opts.body }),
        opts.json,
      )
    })
  forgeCommand(group, 'review <ref>', 'review a pull request')
    .option('--approve', 'approve')
    .option('--request-changes', 'request changes')
    .option('--comment', 'leave a review comment')
    .option('-b, --body <body>', 'review body', '')
    .action(
      async (
        ref: string,
        opts: ForgeOptions & {
          approve?: boolean
          requestChanges?: boolean
          comment?: boolean
          body: string
        },
      ) => {
        if (
          [opts.approve, opts.requestChanges, opts.comment].filter(Boolean)
            .length !== 1
        )
          throw new InvalidArgumentError(
            'Choose exactly one of --approve, --request-changes, or --comment',
          )
        printResult(
          await (
            await resolve(opts)
          ).request('createReview', numberedRef(ref), {
            event: opts.approve
              ? 'APPROVE'
              : opts.requestChanges
                ? 'REQUEST_CHANGES'
                : 'COMMENT',
            body: opts.body,
          }),
          opts.json,
        )
      },
    )
  forgeCommand(
    group,
    'merge <ref>',
    'request merge through the forge merge queue',
  ).action(async (ref: string, opts: ForgeOptions) => {
    const params = numberedRef(ref),
      client = await resolve(opts)
    const p = await client.request('pull', params)
    const result = await client.request('mergePull', params, {
      sha: p.head.sha,
      merge_method: 'merge',
    })
    console.log(opts.json ? JSON.stringify(result) : result.message)
  })
}
