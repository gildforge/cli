import { Command, InvalidArgumentError } from 'commander'
import type { GildClient } from './api/client'

type ClientOptions = { agent?: string; server?: string }
type Resolve = (opts: ClientOptions) => Promise<GildClient>

function issueRef(value: string) {
  const match = value.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/,
  )
  if (!match) throw new InvalidArgumentError('Use owner/repo#number')
  return { owner: match[1], repo: match[2], number: match[3] }
}

export function issueCommands(program: Command, resolve: Resolve) {
  program
    .command('issue')
    .description('read issues in a repository')
    .command('view <ref>')
    .description('print an issue: gild issue view owner/repo#12')
    .option('--agent <label>', 'use an approved agent token')
    .option(
      '--server <url>',
      'forge base URL (defaults to the joined server for agents)',
    )
    .option('--json', 'print the raw issue JSON')
    .action(async (ref: string, opts: ClientOptions & { json?: boolean }) => {
      const issue = await (await resolve(opts)).request('issue', issueRef(ref))
      if (opts.json) return console.log(JSON.stringify(issue))
      console.log(
        `#${issue.number} [${issue.state}] ${issue.title} — @${issue.user.login}`,
      )
      if (issue.labels.length)
        console.log(`labels: ${issue.labels.map((l) => l.name).join(', ')}`)
      if (issue.body) console.log(issue.body)
    })
}
