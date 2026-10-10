import { Command, InvalidArgumentError } from 'commander'
import {
  forgeCommand,
  numberedRef,
  type ForgeResolve,
  type ForgeOptions,
} from './forge-command'
import {
  environmentConfig,
  type EnvironmentConfig,
} from './api/environment-contract'
const repository = (value: string) => {
  const parsed = value.match(/^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9._-]*)$/i)
  if (!parsed) throw new InvalidArgumentError('Use owner/repo')
  return { owner: parsed[1], repo: parsed[2] }
}
export async function stdinValue(
  stream: AsyncIterable<Uint8Array> = process.stdin,
) {
  if (stream === process.stdin && process.stdin.isTTY)
    throw Error('Pipe the value on stdin')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > 16384) throw Error('Value exceeds 16384 bytes')
    chunks.push(chunk)
  }
  const value = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '')
  if (!value) throw Error('Value cannot be empty')
  return value
}
interface RuleOptions extends ForgeOptions {
  reviewer?: string[]
  waitTimer?: string
  branch?: string[]
  allowedAgent?: string[]
}
const collect = (value: string, previous: string[] = []) => [
  ...previous,
  value.replace(/^@/, ''),
]
function rules(command: Command) {
  return command
    .option(
      '--reviewer <identity>',
      'required person or owner/agent (repeatable)',
      collect,
    )
    .option('--wait-timer <minutes>', 'delay before deployment')
    .option(
      '--branch <pattern>',
      'any, main, or branch pattern (repeatable)',
      collect,
    )
    .option(
      '--allowed-agent <identity>',
      'allow this agent to deploy (repeatable)',
      collect,
    )
}
export function environmentCommands(program: Command, resolve: ForgeResolve) {
  const env = program
    .command('env')
    .description('repository deployment environments')
  forgeCommand(env, 'list <repo>', 'list environments').action(
    async (repo: string, opts: ForgeOptions) => {
      const result = await (
        await resolve(opts, true)
      ).request('actionEnvironments', repository(repo))
      console.log(
        opts.json
          ? JSON.stringify(result)
          : result.environments.map((e) => e.name).join('\n'),
      )
    },
  )
  for (const operation of ['create', 'edit'] as const)
    rules(
      forgeCommand(
        env,
        `${operation} <repo> <name>`,
        `${operation} protection rules`,
      ),
    ).action(async (repo: string, name: string, opts: RuleOptions) => {
      const client = await resolve(opts),
        params = { ...repository(repo), environment: name }
      const original: EnvironmentConfig =
        operation === 'edit'
          ? await client.request('actionEnvironment', params)
          : environmentConfig.parse({})
      const branch = opts.branch
      const config = environmentConfig.parse({
        reviewers: opts.reviewer
          ? opts.reviewer.map((login) => ({
              login,
              type: login.includes('/') ? 'Agent' : 'User',
            }))
          : original.reviewers,
        wait_timer:
          opts.waitTimer === undefined
            ? original.wait_timer
            : Number(opts.waitTimer),
        deployment_branch_policy: branch
          ? branch.length === 1 && ['any', 'main'].includes(branch[0])
            ? branch[0]
            : branch
          : original.deployment_branch_policy,
        allowed_agents: opts.allowedAgent ?? original.allowed_agents,
      })
      const result = await client.request(
        'actionPutEnvironment',
        params,
        config,
      )
      console.log(
        opts.json ? JSON.stringify(result) : `Saved environment ${result.name}`,
      )
    })
  for (const kind of ['secret', 'var'] as const) {
    const group = program
      .command(kind)
      .description(
        kind === 'secret' ? 'write-only Actions secrets' : 'Actions variables',
      )
    forgeCommand(group, 'set <repo> <name>', 'read the value from stdin')
      .option('--env <name>', 'target environment')
      .action(
        async (
          repo: string,
          name: string,
          opts: ForgeOptions & { env?: string },
        ) => {
          const client = await resolve(opts),
            params = repository(repo),
            value = await stdinValue()
          if (opts.env)
            await client.request(
              kind === 'secret'
                ? 'actionPutEnvironmentSecret'
                : 'actionPutEnvironmentVariable',
              { ...params, environment: opts.env, name },
              { value },
            )
          else if (kind === 'secret')
            await client.request(
              'actionPutSecret',
              { ...params, secret: name },
              { value },
            )
          else
            await client.request(
              'actionPutVariable',
              { ...params, name },
              { value },
            )
          console.log(
            `Set ${kind === 'secret' ? 'secret' : 'variable'} ${name}${opts.env ? ` in ${opts.env}` : ''}`,
          )
        },
      )
  }
  const run = program.command('run').description('review pending deployments')
  for (const state of ['approve', 'reject'] as const)
    forgeCommand(
      run,
      `${state} <repo> <run>`,
      `${state} deployments as a listed reviewer`,
    ).action(async (repo: string, number: string, opts: ForgeOptions) => {
      const ref = numberedRef(repo, number),
        params = { owner: ref.owner, repo: ref.repo, run: ref.number },
        client = await resolve(opts)
      await client.request(
        state === 'approve' ? 'actionApprove' : 'actionReject',
        params,
      )
      console.log(
        `Run ${number}: ${state === 'approve' ? 'approved' : 'rejected'}`,
      )
    })
}
