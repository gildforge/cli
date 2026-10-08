import type { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import inquirer from 'inquirer'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { GildClient } from '../api/client'
import { sourceURL } from './source'
import { executeImport } from './execute'
export function importCommands(
  repo: Command,
  client: (server: string) => Promise<GildClient>,
  root: () => string = () => join(homedir(), '.config', 'gild'),
) {
  repo
    .command('import')
    .argument('<url>', 'Git source URL')
    .option('--name <name>', 'destination name, or owner/name')
    .option('--private', 'private destination')
    .option('--mirror', 'sync source until cutover')
    .option('--forge <forge>', 'metadata provider: github, gitlab, git')
    .option('--source-token', 'prompt for a private source token')
    .option('--source-token-file <path>', 'read a source token from a file')
    .option('--server <url>', 'forge URL', 'https://gild.gg')
    .action(async (url, opts) => {
      const source = sourceURL(url, opts.forge),
        api = await client(opts.server)
      let token = opts.sourceTokenFile
        ? (await readFile(opts.sourceTokenFile, 'utf8')).trim()
        : undefined
      if (opts.sourceToken)
        token = (
          await inquirer.prompt([
            {
              type: 'password',
              name: 'token',
              message: 'Source access token:',
              mask: '*',
            },
          ])
        ).token
      if (opts.name && !/^[\w.-]+(?:\/[\w.-]+)?$/.test(opts.name))
        throw Error('Use a repository name or owner/name')
      const [org, name] = opts.name?.includes('/')
        ? opts.name.split('/')
        : [undefined, opts.name ?? source.name]
      const body = {
        url: source.url,
        name,
        private: !!opts.private,
        mirror: !!opts.mirror,
        source_token: token,
        forge: source.forge,
      }
      const status = org
        ? await api.request('importOrgCreate', { org }, body)
        : await api.request('importCreate', {}, body)
      token = undefined
      const [owner, destination] = status.repository.split('/'),
        job = await api.request('importClaim', { owner, repo: destination })
      if (!job) {
        console.log(
          'An owner runner claimed the import; use gild repo import-status ' +
            status.repository,
        )
        return
      }
      const controller = new AbortController(),
        stop = () => controller.abort()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      try {
        await executeImport(opts.server, job, root(), controller.signal)
      } finally {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
    })
  for (const action of ['import-status', 'resume', 'cutover'] as const)
    repo
      .command(action)
      .argument('<repository>', 'owner/name')
      .option(
        '--source-token-file <path>',
        'source token for resuming a private import',
      )
      .option('--server <url>', 'forge URL', 'https://gild.gg')
      .action(async (repository, opts) => {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
          throw Error('Use owner/name')
        const [owner, name] = repository.split('/'),
          api = await client(opts.server),
          params = { owner, repo: name }
        if (action === 'import-status') {
          console.log(
            JSON.stringify(await api.request('importStatus', params), null, 2),
          )
          return
        }
        if (action === 'cutover') {
          console.log(
            JSON.stringify(await api.request('importCutover', params), null, 2),
          )
          return
        }
        const source_token = opts.sourceTokenFile
          ? (await readFile(opts.sourceTokenFile, 'utf8')).trim()
          : undefined
        await api.request('importRetry', params, { source_token })
        const job = await api.request('importClaim', params)
        if (job)
          await executeImport(
            opts.server,
            job,
            root(),
            new AbortController().signal,
          )
        else console.log('An owner runner is resuming the import')
      })
}
