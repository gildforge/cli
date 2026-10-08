#!/usr/bin/env bun
import { ApiRequestError, GildClient } from './api/client'
import { ProofClient } from './api/bootstrap-contract'
import { serverTokenSchema, forgeServer, tokenForServer } from './server-token'
/** gild — key-first identity for the forge. One Bun/TypeScript entry point,
 *  also compiled into a standalone executable (bun build --compile). */
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { z } from 'zod'
import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
} from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import pkg from '../package.json'
import { runnerCommands } from './runner'
import { tailEvents } from './events-tail'

// ---------- identity storage (~/.config/gild/identity.json, mode 0600) ----------

const identitySchema = z.object({
  schema: z.literal(1),
  name: z.string().nullable(), // claimed @name, once the ledger exists
  device: z.string(), // human label for this machine
  publicKey: z.string(), // ed25519:<base64>
  secretKey: z.string(), // ed25519 private (base64 PKCS8)
  apiToken: serverTokenSchema, // gf_… for git push auth
  createdAt: z.string(),
})
type Identity = z.infer<typeof identitySchema>

let identityDirectory: string | undefined
const configDir = () => identityDirectory ?? join(homedir(), '.config', 'gild')
const identityPath = () => join(configDir(), 'identity.json')

export const fingerprint = (publicKey: string) =>
  createHash('sha256').update(publicKey).digest('hex').slice(0, 16)

/** The identity is only as safe as its permissions: dir 0700, file 0600,
 *  enforced on every read, not just at creation — anything looser means
 *  another user (or an agent running as one) could read the key. */
async function enforcePermissions() {
  const dir = await stat(configDir()).catch(() => null)
  if (dir && (dir.mode & 0o077) !== 0) await chmod(configDir(), 0o700)
  const file = await stat(identityPath()).catch(() => null)
  if (file && (file.mode & 0o077) !== 0) await chmod(identityPath(), 0o600)
}

export async function loadIdentity(): Promise<Identity | null> {
  try {
    await enforcePermissions()
    return identitySchema.parse(
      JSON.parse(await readFile(identityPath(), 'utf8')),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function saveIdentity(identity: Identity) {
  identitySchema.parse(identity)
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  const temp = `${identityPath()}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(identity, null, 2) + '\n', {
    mode: 0o600,
  })
  await chmod(temp, 0o600)
  await rename(temp, identityPath())
}

// ---------- signing ----------

export function signChallenge(identity: Identity, challenge: string): string {
  const secret = Buffer.from(identity.secretKey, 'base64')
  const key = { key: secret, format: 'der' as const, type: 'pkcs8' as const }
  return cryptoSign(null, Buffer.from(challenge, 'utf8'), key).toString(
    'base64',
  )
}

export function verifyChallenge(
  publicKey: string,
  challenge: string,
  signature: string,
): boolean {
  const pub = Buffer.from(publicKey.replace(/^ed25519:/, ''), 'base64')
  return cryptoVerify(
    null,
    Buffer.from(challenge, 'utf8'),
    { key: pub, format: 'der', type: 'spki' },
    Buffer.from(signature, 'base64'),
  )
}

/** Initial token mint proves the key; subsequent calls use scoped API v1 tokens. */
export async function signedCall(
  server: string,
  path: string,
  identity: Identity,
  extra: Record<string, unknown> = {},
) {
  if (path !== '/api/tokens')
    throw new Error('Use the scoped v1 client for forge writes')
  const proof = new ProofClient(forgeServer(server)),
    { challenge } = await proof.request('challenge', {})
  const data = await proof.request('token', {
    challenge,
    publicKey: identity.publicKey,
    signature: signChallenge(identity, challenge),
  })
  return { ok: true, status: 200, data }
}
async function clientFor(server: string, identity: Identity) {
  server = forgeServer(server)
  if (!identity.apiToken || identity.apiToken.server !== server) {
    const result = await signedCall(server, '/api/tokens', identity)
    identity.apiToken = { server, token: result.data.token }
    await saveIdentity(identity)
  }
  return new GildClient(
    server + '/api/v1',
    tokenForServer(identity.apiToken, server),
  )
}

/** Register gild as git's credential helper for the forge host, so every
 *  clone pushes with the identity's API token and no prompts. Idempotent;
 *  silent when git is missing (the helper is a convenience, never a blocker). */
export function ensureGitHelper(server = 'https://gild.gg'): boolean {
  const r = Bun.spawnSync(
    [
      'git',
      'config',
      '--global',
      `credential.${server}.helper`,
      '!gild credential',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  return r.exitCode === 0
}

// ---------- commands ----------

export const program = new Command()
  .option('--config-dir <path>', 'identity directory (default: ~/.config/gild)')
  .hook('preAction', (_, command) => {
    identityDirectory = command.optsWithGlobals().configDir
    // Commander parses the global option at every depth. Propagate it to
    // runner group/service leaves as well as direct runner subcommands.
    for (let parent = command.parent; parent; parent = parent.parent)
      if (parent.name() === 'runner') {
        command.setOptionValue(
          'configDir',
          identityDirectory ?? join(homedir(), '.config', 'gild'),
        )
        break
      }
  })
program
  .name('gild')
  .description('gild — key-first identity for the forge')
  .version(pkg.version)

const authCmd = program
  .command('auth')
  .description(
    'identity and account — key-first, terminal-first (mirrors gh auth)',
  )

authCmd
  .command('init')
  .description('create your identity key on this machine')
  .option('--yes', 'accept defaults without prompting')
  .action(async (opts) => {
    const existing = await loadIdentity()
    if (existing) {
      console.log(
        chalk.yellow(
          `This machine already has an identity (${fingerprint(existing.publicKey)}).`,
        ),
      )
      const { replace } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'replace',
          default: false,
          message: 'Replace it? The old key will no longer prove who you are.',
        },
      ])
      if (!replace) {
        console.log('Kept the existing identity.')
        return
      }
    }

    const answers = opts.yes
      ? { device: hostname(), confirm: true }
      : await inquirer.prompt([
          {
            type: 'input',
            name: 'device',
            default: hostname(),
            message:
              'What should this machine be called? (shown next to your key on gild)',
          },
          {
            type: 'confirm',
            name: 'confirm',
            default: true,
            message:
              'gild never sees your private key — it stays in ~/.config/gild. Understood?',
          },
        ])

    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const identity: Identity = {
      schema: 1,
      name: null,
      apiToken: null,
      device: answers.device,
      publicKey: `ed25519:${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`,
      secretKey: privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      createdAt: new Date().toISOString(),
    }
    await saveIdentity(identity)

    // Git wiring is part of the new-account flow: once `gild auth token` mints
    // this machine's API token, every clone pushes without prompts. The
    // helper stays quiet until then (git falls back to prompting).
    const gitWired = ensureGitHelper()

    console.log()
    console.log(chalk.green('Identity created.'))
    console.log(`  device:      ${identity.device}`)
    console.log(`  public key:  ${identity.publicKey}`)
    console.log(`  fingerprint: ${fingerprint(identity.publicKey)}`)
    if (gitWired)
      console.log(
        '  git:         credential helper installed (activates with `gild auth token`)',
      )
    console.log()

    const { openClaim } = opts.yes
      ? { openClaim: false }
      : await inquirer.prompt([
          {
            type: 'confirm',
            name: 'openClaim',
            default: true,
            message:
              'Open gild.gg now to claim your name? (your public key goes along, nothing else)',
          },
        ])
    if (openClaim) {
      const url = `https://gild.gg/auth/claim?key=${encodeURIComponent(identity.publicKey)}`
      const opener =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open'
      Bun.spawn([opener, url], { stdout: 'ignore', stderr: 'ignore' })
      console.log(
        'The claim page is open with your key filled in — pick a name.',
      )
    } else {
      console.log(
        `Claim a name whenever: ${chalk.underline('https://gild.gg/auth/claim')}`,
      )
    }
  })

authCmd
  .command('status')
  .description('show the identity on this machine')
  .action(async () => {
    const identity = await loadIdentity()
    if (!identity) {
      console.log('No identity here yet. Run `gild auth init`.')
      return
    }
    console.log(
      `${identity.name ?? chalk.dim('(no name claimed)')} on ${identity.device}`,
    )
    console.log(`public key:  ${identity.publicKey}`)
    console.log(`fingerprint: ${fingerprint(identity.publicKey)}`)
  })

authCmd
  .command('sign')
  .description('sign a browser challenge: gild auth sign <challenge>')
  .argument('<challenge>', 'the challenge shown in the browser')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (challenge, opts) => {
    const identity = await loadIdentity()
    if (!identity) {
      console.error('No identity here yet. Run `gild auth init` first.')
      process.exitCode = 1
      return
    }

    const signature = signChallenge(identity, challenge)
    const server = opts.server as string
    await new ProofClient(server).request('answer', {
      challenge,
      publicKey: identity.publicKey,
      signature,
    })
    console.log(
      chalk.green(
        'Signed and sent. The browser tab should open your session now.',
      ),
    )
  })

authCmd
  .command('claim')
  .description('sign a name claim: gild auth claim <challenge>')
  .argument('<challenge>', 'the claim challenge shown in the browser')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (challenge, opts) => {
    const identity = await loadIdentity()
    if (!identity) {
      console.error('No identity here yet. Run `gild auth init` first.')
      process.exitCode = 1
      return
    }

    const signature = signChallenge(identity, challenge)
    const data = await new ProofClient(opts.server).request('claim', {
      challenge,
      publicKey: identity.publicKey,
      signature,
    })
    identity.name = data.name
    await saveIdentity(identity)
    console.log(chalk.green(`@${data.name} is yours.`))
  })

authCmd
  .command('token')
  .description(
    'mint a gild API token (used as the push credential by gild clone)',
  )
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (opts) => {
    const identity = await loadIdentity()
    if (!identity) {
      console.error('No identity here yet. Run `gild auth init` first.')
      process.exitCode = 1
      return
    }
    const { ok, status, data } = await signedCall(
      opts.server,
      '/api/tokens',
      identity,
    )
    identity.apiToken = { server: forgeServer(opts.server), token: data.token }
    await saveIdentity(identity)
    const gitWired = ensureGitHelper(opts.server)
    console.log(chalk.green('token saved.'))
    console.log(
      'It proves your key for git pushes. Rotate any time with `gild auth token`.',
    )
    if (gitWired)
      console.log(
        'git credential helper active — every clone pushes without prompts.',
      )
  })

const repoCmd = program.command('repo').description('forge repositories')

repoCmd
  .command('create')
  .argument('<name>', 'repo name, or owner/name to create under an org')
  .option('--description <text>', 'description')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (nameArg, opts) => {
    const identity = await loadIdentity()
    if (!identity) {
      console.error('No identity here yet. Run `gild auth init` first.')
      process.exitCode = 1
      return
    }
    const [owner, name] = nameArg.includes('/')
      ? [nameArg.split('/')[0], nameArg.split('/').slice(1).join('/')]
      : [undefined, nameArg]
    const client = await clientFor(opts.server, identity)
    const data = owner
      ? await client.request(
          'createOrgRepository',
          { org: owner },
          { name, description: opts.description },
        )
      : await client.request(
          'createRepository',
          {},
          { name, description: opts.description },
        )
    console.log(chalk.green(`created ${data.full_name}`))
    console.log(`  clone: gild clone ${data.full_name}`)
  })

const orgCmd = program
  .command('org')
  .description('orgs: grouped repos with shared access')

orgCmd
  .command('create')
  .description('create an org (you become its owner)')
  .argument('<name>', 'org name')
  .option('--description <text>', 'description')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (name, opts) => {
    const identity = await loadIdentity()
    if (!identity) {
      console.error('No identity here yet. Run `gild auth init` first.')
      process.exitCode = 1
      return
    }
    const data = await (
      await clientFor(opts.server, identity)
    ).request('createOrg', {}, { name, description: opts.description })
    console.log(chalk.green(`created org @${data.name}`))
    console.log(`  add a repo: gild repo create ${data.name}/<repo>`)
    console.log(`  add a member: gild org add-member ${data.name} <user>`)
  })

orgCmd
  .command('list')
  .description('list the orgs you belong to')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (opts) => {
    const identity = await loadIdentity()
    if (!identity) {
      console.error('Run `gild auth init` first — listing needs your identity.')
      process.exitCode = 1
      return
    }
    const orgs = await (await clientFor(opts.server, identity)).request('orgs')
    if (!orgs.length) {
      console.log('No orgs yet. `gild org create <name>` makes one.')
      return
    }
    for (const o of orgs)
      console.log(
        `@${o.name}  ${chalk.dim(o.role)}${o.description ? `  ${o.description}` : ''}`,
      )
  })

orgCmd
  .command('add-member')
  .description('add a claimed user to an org you own or admin')
  .argument('<org>', 'org name')
  .argument('<user>', "the user's claimed name")
  .option('--role <role>', 'owner, admin or member', 'member')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (org, user, opts) => {
    const identity = await loadIdentity()
    if (!identity) {
      console.error('No identity here yet. Run `gild auth init` first.')
      process.exitCode = 1
      return
    }
    const data = await (
      await clientFor(opts.server, identity)
    ).request('addOrgMember', { org }, { member: user, role: opts.role })
    console.log(
      chalk.green(`@${data.member} is now ${data.role} of @${data.org}`),
    )
  })

const cloneAction = async (
  repoArg: string,
  dir: string | undefined,
  opts: { server: string },
) => {
  const identity = await loadIdentity()
  const url = `${opts.server}/${repoArg}.git`
  const run = (args: string[], cwd?: string) => {
    const r = Bun.spawnSync(args, { cwd, stdout: 'inherit', stderr: 'inherit' })
    if (r.exitCode !== 0) {
      console.error(chalk.red(`git ${args[0]} failed`))
      process.exit(1)
    }
  }
  run(['git', 'clone', url, ...(dir ? [dir] : [])])
  const repoDir = dir ?? repoArg.split('/').pop()!
  // Safety net for repos created before HEAD pointed at main: never leave
  // a clone sitting on the forge-managed _meta branch.
  const head = Bun.spawnSync(['git', 'symbolic-ref', '--short', 'HEAD'], {
    cwd: repoDir,
  })
    .stdout.toString()
    .trim()
  if (head === '_meta') {
    run(['git', 'checkout', 'main'], repoDir)
    console.log(
      chalk.dim("(switched to main — _meta is the forge's metadata branch)"),
    )
  }
  if (identity?.apiToken) {
    run(
      [
        'git',
        'config',
        `http.${opts.server}.extraHeader`,
        `Authorization: Bearer ${tokenForServer(identity.apiToken, opts.server)}`,
      ],
      repoDir,
    )
    console.log('push access wired (your gild token). `git push` just works.')
  } else {
    console.log(
      chalk.dim(
        'cloned read-only; run `gild auth token` and re-set the push header to push',
      ),
    )
  }
}

program
  .command('clone')
  .description('clone a forge repo (push access wired up automatically)')
  .argument('<repo>', 'owner/name')
  .argument('[dir]', 'directory')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(cloneAction)

repoCmd
  .command('clone')
  .description('clone a forge repo (same as gild clone)')
  .argument('<repo>', 'owner/name')
  .argument('[dir]', 'directory')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(cloneAction)

program
  .command('credential')
  .description(
    'git credential helper — git runs this; see `gild auth setup-git`',
  )
  .argument('<action>', 'get | store | erase')
  .action(async (action) => {
    if (action !== 'get') return // nothing to store or erase: the token lives in identity.json
    // The request (protocol/host lines) ends with a blank line — git may
    // hold stdin open, so stop there rather than at EOF.
    const decoder = new TextDecoder()
    let request = ''
    for await (const chunk of Bun.stdin.stream()) {
      request += decoder.decode(chunk)
      if (request.includes('\n\n')) break
    }
    const identity = await loadIdentity()
    const fields = Object.fromEntries(
      request
        .trim()
        .split('\n')
        .map((line) => {
          const i = line.indexOf('=')
          return [line.slice(0, i), line.slice(i + 1)]
        }),
    )
    let token: string
    try {
      token = tokenForServer(
        identity?.apiToken,
        `${fields.protocol}://${fields.host}`,
      )
    } catch {
      return
    }
    if (!identity?.apiToken) process.exit(0) // no answer = git falls back to prompting
    // The proxy checks the password slot; any username works.
    console.log('username=gild')
    console.log(`password=${token}`)
  })

authCmd
  .command('setup-git')
  .description(
    "register gild as git's credential helper for the forge, so every clone pushes without prompts",
  )
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (opts) => {
    const identity = await loadIdentity()
    if (!identity?.apiToken) {
      console.error(
        'Run `gild auth token` first — the helper answers with your API token.',
      )
      process.exitCode = 1
      return
    }
    tokenForServer(identity.apiToken, opts.server)
    if (!ensureGitHelper(opts.server)) {
      console.error(chalk.red('git config failed'))
      process.exitCode = 1
      return
    }
    console.log(
      chalk.green(
        `git is wired: pushes to ${opts.server} use your gild token automatically.`,
      ),
    )
    console.log(
      'Any clone works now — plain `git clone`, CI, scripts. Rotate any time with `gild auth token`.',
    )
  })

// ---------- agents: ask to join, wait for a person to approve ----------

const agentSchema = z.object({
  schema: z.literal(1),
  name: z.string(), // sponsor/label
  server: z.string(),
  publicKey: z.string(),
  secretKey: z.string(),
  requestId: z.string(),
  token: z.string().nullable().default(null),
  createdAt: z.string(),
})
type AgentIdentity = z.infer<typeof agentSchema>

export function agentServer(
  agent: Pick<AgentIdentity, 'server'>,
  requested?: string,
) {
  const joined = forgeServer(agent.server)
  if (requested && forgeServer(requested) !== joined)
    throw Error('--server differs from the server this agent joined')
  return joined
}

const agentsDir = () => join(configDir(), 'agents')
const agentPath = (label: string) => join(agentsDir(), `${label}.json`)

/** What an agent signs to collect its token. Must match the server. */
export const agentJoinChallenge = (requestId: string) =>
  `gild-agent-join:${requestId}`

async function saveAgent(label: string, agent: AgentIdentity) {
  await mkdir(agentsDir(), { recursive: true, mode: 0o700 })
  await chmod(configDir(), 0o700)
  const temp = `${agentPath(label)}.${process.pid}.tmp`
  await writeFile(
    temp,
    JSON.stringify(agentSchema.parse(agent), null, 2) + '\n',
    { mode: 0o600 },
  )
  await rename(temp, agentPath(label))
}

async function loadAgent(label: string): Promise<AgentIdentity | null> {
  try {
    return agentSchema.parse(
      JSON.parse(await readFile(agentPath(label), 'utf8')),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const agentCmd = program
  .command('agent')
  .description(
    'agent accounts: an agent asks to join, a person approves (like adding a machine to a tailnet)',
  )

agentCmd
  .command('join <label>')
  .description(
    'ask to work for someone as @<sponsor>/<label>; prints an approval link and waits',
  )
  .requiredOption(
    '--sponsor <name>',
    'the person you work for (their gild name)',
  )
  .option('--repo <owner/name>', 'a repo you want to work in')
  .option(
    '--grants <list>',
    'what you ask for there: pr, review, queue (comma separated)',
    'pr',
  )
  .option('--note <text>', 'why, in a sentence the approver will read')
  .option('--server <url>', 'forge base URL (defaults to the joined server)')
  .option(
    '--no-wait',
    'file the request and exit; run `gild agent join` again later to collect',
  )
  .action(async (label: string, opts) => {
    let agent = await loadAgent(label)
    const server = agent
      ? agentServer(agent, opts.server)
      : forgeServer(opts.server ?? 'https://gild.gg')
    if (!agent || agent.token) {
      if (agent?.token) {
        console.log(
          chalk.yellow(
            `@${agent.name} has already joined. Its token: gild agent token ${label}`,
          ),
        )
        return
      }
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const pub = `ed25519:${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`
      const data = await new ProofClient(server).request('join', {
        sponsor: opts.sponsor,
        label,
        publicKey: pub,
        repo: opts.repo,
        grants: String(opts.grants ?? '')
          .split(',')
          .map((g: string) => g.trim())
          .filter(Boolean),
        note: opts.note,
      })
      agent = {
        schema: 1,
        name: data.agent!,
        server,
        publicKey: pub,
        token: null,
        requestId: data.id,
        createdAt: new Date().toISOString(),
        secretKey: privateKey
          .export({ format: 'der', type: 'pkcs8' })
          .toString('base64'),
      }
      await saveAgent(label, agent)
      console.log(
        `Asked @${opts.sponsor} to approve ${chalk.bold('@' + agent.name)}.`,
      )
      console.log(`Approve here: ${chalk.cyan(data.approveUrl)}`)
    } else {
      console.log(
        `Still waiting on @${agent.name.split('/')[0]}: ${chalk.cyan(`${agent.server}/agents/approve/${agent.requestId}`)}`,
      )
    }
    if (opts.wait === false) return

    // Poll by proving the key; the token comes back once, on approval.
    const signature = signChallenge(
      agent as unknown as Identity,
      agentJoinChallenge(agent.requestId),
    )
    for (const started = Date.now(); Date.now() - started < 60 * 60 * 1000;) {
      let data: {
        status: string
        name?: string
        token?: string
        repo?: string | null
        grants?: string[]
      }
      try {
        data = await new ProofClient(agent.server).request(
          'collect',
          { signature },
          { id: agent.requestId },
        )
      } catch (error) {
        if (error instanceof ApiRequestError && error.status >= 500) {
          await Bun.sleep(5000)
          continue
        }
        if (error instanceof ApiRequestError) {
          console.error(
            chalk.red(error.message || `check failed (${error.status})`),
          )
          process.exitCode = 1
          return
        }
        throw error
      }
      if (data.status === 'approved' && data.token) {
        await saveAgent(label, { ...agent, token: data.token })
        console.log(
          chalk.green(`Approved. You are @${agent.name}.`) +
            (data.repo && data.grants?.length
              ? ` In ${data.repo} you may: ${data.grants.join(', ')}.`
              : ''),
        )
        console.log(
          `Use the token for git (any username) and the API: ${chalk.bold(`gild agent token ${label}`)}`,
        )
        return
      }
      if (data.status === 'denied' || data.status === 'expired') {
        console.error(chalk.red(`The request was ${data.status}.`))
        process.exitCode = 1
        return
      }
      await Bun.sleep(3000)
    }
    console.error(
      chalk.yellow(
        'Still waiting after an hour. Run the same command again to keep waiting.',
      ),
    )
  })

agentCmd
  .command('token <label>')
  .description(
    "print an approved agent's API token (for git and Authorization: Bearer)",
  )
  .action(async (label: string) => {
    const agent = await loadAgent(label)
    if (!agent?.token) {
      console.error(
        `No approved agent named ${label} on this machine. Run gild agent join ${label} --sponsor <name>.`,
      )
      process.exitCode = 1
      return
    }
    console.log(agent.token)
  })

agentCmd
  .command('list')
  .description('agents on this machine')
  .action(async () => {
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(agentsDir()).catch(() => [] as string[])
    if (!files.length) {
      console.log(
        'No agents on this machine. Ask to join with gild agent join <label> --sponsor <name>.',
      )
      return
    }
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const a = await loadAgent(f.replace(/\.json$/, ''))
      if (a)
        console.log(
          `@${a.name}  ${a.token ? chalk.green('approved') : chalk.yellow('waiting')}  ${fingerprint(a.publicKey)}`,
        )
    }
  })

program
  .command('events')
  .description('durable forge event stream')
  .command('tail')
  .option('--repo <owner/repo>', 'limit events to a repository')
  .option('--since <cursor>', 'resume after a durable cursor')
  .option('--agent <label>', 'use an approved agent token')
  .option('--once', 'read one available page and exit')
  .option(
    '--raw',
    'include full event payloads, including approval URLs and secrets',
  )
  .option(
    '--server <url>',
    'forge base URL (defaults to the joined server for agents)',
  )
  .action(async (opts) => {
    const agent = opts.agent ? await loadAgent(opts.agent) : null
    const identity = opts.agent ? null : await loadIdentity()
    if (opts.agent && !agent?.token)
      throw Error('Agent token is not approved here yet')
    if (!opts.agent && !identity) throw Error('Run gild auth init first')
    const client = agent?.token
      ? new GildClient(agentServer(agent, opts.server) + '/api/v1', agent.token)
      : await clientFor(opts.server ?? 'https://gild.gg', identity!)
    const controller = new AbortController(),
      stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      await tailEvents(client, opts, controller.signal)
    } finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
  })

const sessionCmd = program
  .command('session')
  .description('report or inspect an agent session receipt')
function sessionTarget(opts: { repo: string; pull?: string; commit?: string }) {
  const [owner, repo, ...extra] = opts.repo.split('/')
  if (!owner || !repo || extra.length) throw Error('Use --repo owner/repo')
  if (Boolean(opts.pull) === Boolean(opts.commit))
    throw Error('Choose exactly one of --pull or --commit')
  if (opts.pull && !/^[1-9][0-9]*$/.test(opts.pull))
    throw Error('Pull number must be positive')
  if (opts.commit && !/^[a-f0-9]{40}$/.test(opts.commit))
    throw Error('Commit must be a full SHA')
  return {
    owner,
    repo,
    ...(opts.pull ? { number: opts.pull } : { sha: opts.commit! }),
  }
}
sessionCmd
  .command('record')
  .requiredOption('--repo <owner/repo>')
  .option('--pull <number>')
  .option('--commit <sha>')
  .requiredOption('--agent <label>')
  .requiredOption('--file <path>', 'session JSON file')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (opts) => {
    const params = sessionTarget(opts),
      agent = await loadAgent(opts.agent)
    if (!agent?.token) throw Error('Use an approved local agent token')
    const body = JSON.parse(await readFile(opts.file, 'utf8')),
      client = new GildClient(
        opts.server.replace(/\/$/, '') + '/api/v1',
        agent.token,
      )
    const options = {
      idempotencyKey:
        'receipt:' +
        createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    }
    const receipt = opts.pull
      ? await client.request(
          'createPullSession',
          params,
          body,
          undefined,
          options,
        )
      : await client.request(
          'createCommitSession',
          params,
          body,
          undefined,
          options,
        )
    console.log(JSON.stringify(receipt))
  })
sessionCmd
  .command('list')
  .requiredOption('--repo <owner/repo>')
  .option('--pull <number>')
  .option('--commit <sha>')
  .option('--agent <label>')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (opts) => {
    const params = sessionTarget(opts),
      agent = opts.agent ? await loadAgent(opts.agent) : null,
      identity = await loadIdentity()
    if (opts.agent && !agent?.token)
      throw Error('Use an approved local agent token')
    if (!opts.agent && !identity) throw Error('Run gild auth init first')
    const client = agent?.token
      ? new GildClient(opts.server.replace(/\/$/, '') + '/api/v1', agent.token)
      : await clientFor(opts.server, identity!)
    console.log(
      JSON.stringify(
        opts.pull
          ? await client.request('pullSessions', params)
          : await client.request('commitSessions', params),
      ),
    )
  })

runnerCommands(program, loadIdentity)

if (import.meta.main)
  program.parseAsync().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
