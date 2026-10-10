import { Command } from 'commander'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { loadProfile } from './agent-profiles'
import {
  instructionPath,
  pullInstructions,
  type InstructionsTarget,
} from './agent-instructions'
import type { GildClient } from './api/client'
export function instructionsCommands(
  agent: Command,
  clientFor: (
    label: string,
    write: boolean,
    server?: string,
  ) => Promise<{ client: GildClient; agent: string }>,
) {
  agent
    .command('instructions <name>')
    .description('read, edit, pull or push repo instructions on _meta')
    .option(
      '--repo <owner/repo>',
      'repository; defaults to the profile directory origin',
    )
    .option('--server <url>', 'joined forge server')
    .option('--edit', 'edit instructions then commit as the sponsor')
    .option('--pull', 'sync instructions, asking before replacing local edits')
    .option('--push', 'commit local instructions as the sponsor')
    .option('--editor <executable>', 'editor for --edit', 'vi')
    .action(async (name: string, opts) => {
      if ([opts.edit, opts.pull, opts.push].filter(Boolean).length > 1)
        throw Error('Choose --edit, --pull or --push')
      const profile = await loadProfile(name),
        connection = await clientFor(
          name,
          !!(opts.edit || opts.push),
          opts.server,
        )
      let repository: string | undefined = opts.repo
      if (!repository) {
        const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
          cwd: profile.directory,
          encoding: 'utf8',
        })
        try {
          const value = remote.stdout.trim(),
            url = new URL(
              value.startsWith('git@')
                ? value.replace(/^git@([^:]+):/, 'ssh://git@$1/')
                : value,
            )
          if (url.hostname === new URL(connection.client.baseURL).hostname)
            repository = url.pathname.replace(/^\//, '').replace(/\.git$/, '')
        } catch {}
      }
      if (!repository && profile.channels?.length === 1)
        repository = profile.channels[0]
      if (!repository || !/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(repository))
        throw Error('Name the repository with --repo owner/repo')
      const [owner, repo] = repository.split('/'),
        [sponsor, label] = connection.agent.split('/')
      const target: InstructionsTarget = { owner, repo, sponsor, label },
        source = JSON.stringify(target)
      const remote = await connection.client.request(
        'agentInstructions',
        target,
      )
      const runtime = remote.preferences?.runtime ?? profile.runtime
      const path = instructionPath(profile.directory, runtime)
      if (!opts.pull && !opts.push && !opts.edit) {
        console.log(remote.text)
        return
      }
      if (opts.pull || opts.edit) {
        let result = await pullInstructions(
          profile.directory,
          runtime,
          source,
          remote,
        )
        if (result.state === 'conflict') {
          if (!process.stdin.isTTY) {
            console.error(result.warning)
            process.exitCode = 1
            return
          }
          const { default: inquirer } = await import('inquirer')
          const { replace } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'replace',
              message: `Replace your locally edited ${path} with the repo instructions?`,
              default: false,
            },
          ])
          if (!replace) {
            console.error(result.warning)
            return
          }
          result = await pullInstructions(
            profile.directory,
            runtime,
            source,
            remote,
            true,
          )
        }
        if (opts.pull) {
          console.log(`synced ${path}`)
          return
        }
      }
      if (opts.edit) {
        const edited = spawnSync(opts.editor, [path], { stdio: 'inherit' })
        if (edited.error || edited.status !== 0)
          throw Error('Instructions editor did not finish successfully')
      }
      const stamp = JSON.parse(
        await readFile(path + '.gild-sync.json', 'utf8').catch(() => {
          throw Error('Pull instructions before pushing')
        }),
      )
      if (stamp.source !== source)
        throw Error('Pull instructions from this repo before pushing')
      const text = await readFile(path, 'utf8')
      const saved = await connection.client.request(
        'updateAgentInstructions',
        target,
        { text, revision: stamp.remote },
      )
      await pullInstructions(profile.directory, runtime, source, saved)
      console.log(`committed ${repository} instructions; synced ${path}`)
    })
}
