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
    .option(
      '--private',
      'private destination (the default with a source token)',
    )
    .option('--public', 'public destination, even with a source token')
    .option('--mirror', 'sync source until cutover')
    .option('--forge <forge>', 'metadata provider: github, gitlab, git')
    .option(
      '--source-token',
      'prompt for a source token sent to gild for mirroring; defaults destination to private',
    )
    .option(
      '--source-token-file <path>',
      'read a source token sent to gild; defaults destination to private',
    )
    .option(
      '--anonymous',
      'disable local GH_TOKEN/GITHUB_TOKEN or gh auth for GitHub API reads (never sent to gild; does not change destination privacy)',
    )
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
        : [undefined, opts.name ?? source.name.toLowerCase()]
      const body = {
        url: source.url,
        name,
        // Unset lets the server choose: private whenever a source token is used.
        private: opts.private ? true : opts.public ? false : undefined,
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
        await executeImport(
          opts.server,
          job,
          root(),
          controller.signal,
          console.log,
          undefined,
          opts.anonymous,
        )
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
      .option('--anonymous', 'disable local GitHub auth for metadata reads')
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
        if (job) {
          const controller = new AbortController(),
            stop = () => controller.abort()
          process.once('SIGINT', stop)
          process.once('SIGTERM', stop)
          try {
            await executeImport(
              opts.server,
              job,
              root(),
              controller.signal,
              console.log,
              undefined,
              opts.anonymous,
            )
          } finally {
            process.removeListener('SIGINT', stop)
            process.removeListener('SIGTERM', stop)
          }
        } else console.log('An owner runner is resuming the import')
      })
}
