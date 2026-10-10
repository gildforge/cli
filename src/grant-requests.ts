import type { Command } from 'commander'
import type { GildClient } from './api/client'
import { grantRequestInput } from './api/grant-request-contract'
import { repoPair } from './chat'
export function grantRequestCommands(
  agentCmd: Command,
  clientFor: (opts: { agent?: string; server?: string }) => Promise<GildClient>,
) {
  agentCmd
    .command('request-grants <repo>')
    .description('ask the repository admins for additional grants')
    .requiredOption('--grants <list>', 'comma-separated pr,review,queue')
    .requiredOption('--reason <text>', 'why the additional grants are needed')
    .requiredOption(
      '--agent <label>',
      'use this approved agent token to request for itself',
    )
    .option('--server <url>', 'forge base URL')
    .action(async (target: string, opts) => {
      const client = await clientFor(opts)
      const r = await client.request(
        'requestAgentGrants',
        repoPair(target),
        grantRequestInput.parse({
          grants: opts.grants.split(',').map((g: string) => g.trim()),
          reason: opts.reason,
        }),
      )
      console.log(
        `Request ${r.id}: ${r.status} — @${r.agent} asks for ${r.grants.join(', ')} on ${r.repo}`,
      )
    })
  agentCmd
    .command('requests <repo>')
    .description('list grant requests (admins see all; agents see their own)')
    .option('--agent <label>', 'use this approved agent token')
    .option('--server <url>', 'forge base URL')
    .option('--json', 'print JSON')
    .action(async (target: string, opts) => {
      const rows = await (
        await clientFor(opts)
      ).request('repoGrantRequests', repoPair(target))
      if (opts.json) console.log(JSON.stringify(rows))
      else
        for (const r of rows)
          console.log(
            `${r.id}  ${r.status}  @${r.agent}  ${r.grants.join(', ')}  ${r.reason}${r.denialReason ? ` — ${r.denialReason}` : ''}`,
          )
    })
  for (const decision of ['approve', 'deny'] as const)
    agentCmd
      .command(`${decision} <id>`)
      .description(`${decision} an agent grant request as a repository admin`)
      .option('--reason <text>', 'optional denial reason')
      .option('--server <url>', 'forge base URL')
      .action(async (id: string, opts) => {
        const r = await (
          await clientFor(opts)
        ).request(
          'decideGrantRequest',
          { id },
          { decision, reason: opts.reason },
        )
        console.log(
          `${r.status}: ${r.grants.join(', ')} for @${r.agent} on ${r.repo}${r.denialReason ? ` — ${r.denialReason}` : ''}`,
        )
      })
}
