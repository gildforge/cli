import { Command, InvalidArgumentError } from 'commander'
import { repoPair } from './chat'
import {
  forgeCommand,
  numberedRef,
  printResult,
  type ForgeOptions,
  type ForgeResolve,
} from './forge-command'

export function issueCommands(program: Command, resolve: ForgeResolve) {
  const group = program.command('issue').description('read and manage issues')
  forgeCommand(group, 'view <ref> [number]', 'read an issue').action(
    async (ref: string, number: string | undefined, opts: ForgeOptions) => {
      const issue = await (
        await resolve(opts, true)
      ).request('issue', numberedRef(ref, number))
      if (opts.json) return console.log(JSON.stringify(issue))
      console.log(
        `#${issue.number} [${issue.state}] ${issue.title} — @${issue.user.login}`,
      )
      if (issue.labels.length)
        console.log(`labels: ${issue.labels.map((l) => l.name).join(', ')}`)
      if (issue.body) console.log(issue.body)
    },
  )
  forgeCommand(group, 'create <repo>', 'create an issue')
    .requiredOption('--title <title>', 'issue title')
    .option('-b, --body <body>', 'issue body', '')
    .option('--label <labels...>', 'initial labels')
    .action(
      async (
        repo: string,
        opts: ForgeOptions & { title: string; body: string; label?: string[] },
      ) => {
        printResult(
          await (
            await resolve(opts)
          ).request('createIssue', repoPair(repo), {
            title: opts.title,
            body: opts.body,
            labels: opts.label ?? [],
          }),
          opts.json,
        )
      },
    )
  forgeCommand(group, 'comment <ref> [number]', 'comment on an issue')
    .requiredOption('-b, --body <body>', 'comment body')
    .action(
      async (
        ref: string,
        number: string | undefined,
        opts: ForgeOptions & { body: string },
      ) => {
        printResult(
          await (
            await resolve(opts)
          ).request('createIssueComment', numberedRef(ref, number), {
            body: opts.body,
          }),
          opts.json,
        )
      },
    )
  forgeCommand(group, 'close <ref> [number]', 'close an issue').action(
    async (ref: string, number: string | undefined, opts: ForgeOptions) => {
      printResult(
        await (
          await resolve(opts)
        ).request('updateIssue', numberedRef(ref, number), { state: 'closed' }),
        opts.json,
      )
    },
  )
  forgeCommand(group, 'label <ref> [number]', 'add or remove issue labels')
    .option('--add <labels...>', 'labels to add')
    .option('--remove <labels...>', 'labels to remove')
    .action(
      async (
        ref: string,
        number: string | undefined,
        opts: ForgeOptions & { add?: string[]; remove?: string[] },
      ) => {
        if (!opts.add?.length && !opts.remove?.length)
          throw new InvalidArgumentError('Use --add or --remove')
        const params = numberedRef(ref, number),
          client = await resolve(opts)
        const issue = await client.request('issue', params)
        const labels = [
          ...new Set([...issue.labels.map((l) => l.name), ...(opts.add ?? [])]),
        ].filter((l) => !opts.remove?.includes(l))
        printResult(
          await client.request('updateIssue', params, { labels }),
          opts.json,
        )
      },
    )
}
