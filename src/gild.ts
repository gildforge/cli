#!/usr/bin/env bun
/** gild — key-first identity for the forge. One Bun/TypeScript entry point,
 *  also compiled into a standalone executable (bun build --compile). */
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { z } from 'zod'
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import pkg from '../package.json'

// ---------- identity storage (~/.config/gild/identity.json, mode 0600) ----------

const identitySchema = z.object({
  schema: z.literal(1),
  name: z.string().nullable(),          // claimed @name, once the ledger exists
  device: z.string(),                   // human label for this machine
  publicKey: z.string(),                // ed25519:<base64>
  secretKey: z.string(),                // ed25519 private (base64 PKCS8)
  apiToken: z.string().nullable().default(null),  // gf_… for git push auth
  createdAt: z.string(),
})
type Identity = z.infer<typeof identitySchema>

const configDir = () => join(homedir(), '.config', 'gild')
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
    return identitySchema.parse(JSON.parse(await readFile(identityPath(), 'utf8')))
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function saveIdentity(identity: Identity) {
  identitySchema.parse(identity)
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  const temp = `${identityPath()}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, identityPath())
}

// ---------- signing ----------

export function signChallenge(identity: Identity, challenge: string): string {
  const secret = Buffer.from(identity.secretKey, 'base64')
  const key = { key: secret, format: 'der', type: 'pkcs8' as const }
  return cryptoSign(null, Buffer.from(challenge, 'utf8'), key).toString('base64')
}

export function verifyChallenge(publicKey: string, challenge: string, signature: string): boolean {
  const pub = Buffer.from(publicKey.replace(/^ed25519:/, ''), 'base64')
  return cryptoVerify(null, Buffer.from(challenge, 'utf8'), { key: pub, format: 'der', type: 'spki' }, Buffer.from(signature, 'base64'))
}

/** Every mutating API call proves the key: fetch a challenge, sign it, send. */
export async function signedCall(server: string, path: string, identity: Identity, extra: Record<string, unknown> = {}) {
  const chRes = await fetch(`${server}/api/auth/challenge`, { method: 'POST' })
  const { challenge } = await chRes.json() as { challenge: string }
  const signature = signChallenge(identity, challenge)
  const res = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge, publicKey: identity.publicKey, signature, ...extra }),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

/** Register gild as git's credential helper for the forge host, so every
 *  clone pushes with the identity's API token and no prompts. Idempotent;
 *  silent when git is missing (the helper is a convenience, never a blocker). */
export function ensureGitHelper(server = 'https://gild.gg'): boolean {
  const r = Bun.spawnSync(
    ['git', 'config', '--global', `credential.${server}.helper`, '!gild credential'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  return r.exitCode === 0
}

// ---------- commands ----------

const program = new Command()
program.name('gild').description('gild — key-first identity for the forge').version(pkg.version)

program
  .command('init')
  .description('create your identity key on this machine')
  .option('--yes', 'accept defaults without prompting')
  .action(async (opts) => {
    const existing = await loadIdentity()
    if (existing) {
      console.log(chalk.yellow(`This machine already has an identity (${fingerprint(existing.publicKey)}).`))
      const { replace } = await inquirer.prompt([{
        type: 'confirm', name: 'replace', default: false,
        message: 'Replace it? The old key will no longer prove who you are.',
      }])
      if (!replace) { console.log('Kept the existing identity.'); return }
    }

    const answers = opts.yes
      ? { device: hostname(), confirm: true }
      : await inquirer.prompt([
          {
            type: 'input', name: 'device', default: hostname(),
            message: 'What should this machine be called? (shown next to your key on gild)',
          },
          {
            type: 'confirm', name: 'confirm', default: true,
            message: 'gild never sees your private key — it stays in ~/.config/gild. Understood?',
          },
        ])

    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const identity: Identity = {
      schema: 1,
      name: null,
      device: answers.device,
      publicKey: `ed25519:${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`,
      secretKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      createdAt: new Date().toISOString(),
    }
    await saveIdentity(identity)

    // Git wiring is part of the new-account flow: once `gild token` mints
    // this machine's API token, every clone pushes without prompts. The
    // helper stays quiet until then (git falls back to prompting).
    const gitWired = ensureGitHelper()

    console.log()
    console.log(chalk.green('Identity created.'))
    console.log(`  device:      ${identity.device}`)
    console.log(`  public key:  ${identity.publicKey}`)
    console.log(`  fingerprint: ${fingerprint(identity.publicKey)}`)
    if (gitWired) console.log('  git:         credential helper installed (activates with `gild token`)')
    console.log()

    const { openClaim } = opts.yes
      ? { openClaim: false }
      : await inquirer.prompt([{
          type: 'confirm', name: 'openClaim', default: true,
          message: 'Open gild.gg now to claim your name? (your public key goes along, nothing else)',
        }])
    if (openClaim) {
      const url = `https://gild.gg/auth/claim?key=${encodeURIComponent(identity.publicKey)}`
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      Bun.spawn([opener, url], { stdout: 'ignore', stderr: 'ignore' })
      console.log('The claim page is open with your key filled in — pick a name.')
    } else {
      console.log(`Claim a name whenever: ${chalk.underline('https://gild.gg/auth/claim')}`)
    }
  })

program
  .command('whoami')
  .description('show the identity on this machine')
  .action(async () => {
    const identity = await loadIdentity()
    if (!identity) { console.log('No identity here yet. Run `gild init`.'); return }
    console.log(`${identity.name ?? chalk.dim('(no name claimed)')} on ${identity.device}`)
    console.log(`public key:  ${identity.publicKey}`)
    console.log(`fingerprint: ${fingerprint(identity.publicKey)}`)
  })

program
  .command('auth')
  .description('sign a browser challenge: gild auth <challenge>')
  .argument('<challenge>', 'the challenge shown in the browser')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (challenge, opts) => {
    const identity = await loadIdentity()
    if (!identity) { console.error('No identity here yet. Run `gild init` first.'); process.exitCode = 1; return }

    const signature = signChallenge(identity, challenge)
    const server = opts.server as string
    const res = await fetch(`${server}/api/auth/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge, publicKey: identity.publicKey, signature }),
    })
    if (!res.ok) {
      console.error(chalk.red(`The forge rejected the answer (${res.status}).`))
      process.exitCode = 1
      return
    }
    console.log(chalk.green('Signed and sent. The browser tab should open your session now.'))
  })

program
  .command('claim')
  .description('sign a name claim: gild claim <challenge>')
  .argument('<challenge>', 'the claim challenge shown in the browser')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (challenge, opts) => {
    const identity = await loadIdentity()
    if (!identity) { console.error('No identity here yet. Run `gild init` first.'); process.exitCode = 1; return }

    const signature = signChallenge(identity, challenge)
    const res = await fetch(`${opts.server}/api/claim/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge, publicKey: identity.publicKey, signature }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error(chalk.red(`The forge rejected the claim (${res.status}): ${data.error ?? 'unknown'}`))
      process.exitCode = 1
      return
    }
    identity.name = data.name
    await saveIdentity(identity)
    console.log(chalk.green(`@${data.name} is yours.`))
  })

program
  .command('token')
  .description('mint a gild API token (used as the push credential by gild clone)')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (opts) => {
    const identity = await loadIdentity()
    if (!identity) { console.error('No identity here yet. Run `gild init` first.'); process.exitCode = 1; return }
    const { ok, status, data } = await signedCall(opts.server, '/api/tokens', identity)
    if (!ok) { console.error(chalk.red(`token mint failed (${status}): ${data.error ?? 'unknown'}`)); process.exitCode = 1; return }
    identity.apiToken = data.token
    await saveIdentity(identity)
    const gitWired = ensureGitHelper(opts.server)
    console.log(chalk.green('token saved.'))
    console.log('It proves your key for git pushes. Rotate any time with `gild token`.')
    if (gitWired) console.log('git credential helper active — every clone pushes without prompts.')
  })

const repoCmd = program
  .command('repo')
  .description('forge repositories')

repoCmd
  .command('create')
  .argument('<name>', 'repo name, or owner/name to create under an org')
  .option('--description <text>', 'description')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (nameArg, opts) => {
    const identity = await loadIdentity()
    if (!identity) { console.error('No identity here yet. Run `gild init` first.'); process.exitCode = 1; return }
    const [owner, name] = nameArg.includes('/')
      ? [nameArg.split('/')[0], nameArg.split('/').slice(1).join('/')]
      : [undefined, nameArg]
    const { ok, status, data } = await signedCall(opts.server, '/api/repos', identity, { name, owner, description: opts.description })
    if (!ok) { console.error(chalk.red(`create failed (${status}): ${data.error ?? 'unknown'}`)); process.exitCode = 1; return }
    console.log(chalk.green(`created ${data.owner}/${data.name}`))
    console.log(`  clone: gild clone ${data.owner}/${data.name}`)
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
    if (!identity) { console.error('No identity here yet. Run `gild init` first.'); process.exitCode = 1; return }
    const { ok, status, data } = await signedCall(opts.server, '/api/orgs', identity, { name, description: opts.description })
    if (!ok) { console.error(chalk.red(`create failed (${status}): ${data.error ?? 'unknown'}`)); process.exitCode = 1; return }
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
    if (!identity?.apiToken) { console.error('Run `gild token` first — listing needs your API token.'); process.exitCode = 1; return }
    const res = await fetch(`${opts.server}/api/orgs`, { headers: { authorization: `Bearer ${identity.apiToken}` } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { console.error(chalk.red(`list failed (${res.status}): ${data.error ?? 'unknown'}`)); process.exitCode = 1; return }
    if (!data.orgs?.length) { console.log('No orgs yet. `gild org create <name>` makes one.'); return }
    for (const o of data.orgs) console.log(`@${o.name}  ${chalk.dim(o.role)}${o.description ? `  ${o.description}` : ''}`)
  })

orgCmd
  .command('add-member')
  .description('add a claimed user to an org you own or admin')
  .argument('<org>', 'org name')
  .argument('<user>', 'the user\'s claimed name')
  .option('--role <role>', 'owner, admin or member', 'member')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (org, user, opts) => {
    const identity = await loadIdentity()
    if (!identity) { console.error('No identity here yet. Run `gild init` first.'); process.exitCode = 1; return }
    const { ok, status, data } = await signedCall(opts.server, `/api/orgs/${org}/members`, identity, { member: user, role: opts.role })
    if (!ok) { console.error(chalk.red(`add-member failed (${status}): ${data.error ?? 'unknown'}`)); process.exitCode = 1; return }
    console.log(chalk.green(`@${data.member} is now ${data.role} of @${data.org}`))
  })

const cloneAction = async (repoArg: string, dir: string | undefined, opts: { server: string }) => {
  const identity = await loadIdentity()
  const url = `${opts.server}/${repoArg}.git`
  const run = (args: string[], cwd?: string) => {
    const r = Bun.spawnSync(args, { cwd, stdout: 'inherit', stderr: 'inherit' })
    if (r.exitCode !== 0) { console.error(chalk.red(`git ${args[0]} failed`)); process.exit(1) }
  }
  run(['git', 'clone', url, ...(dir ? [dir] : [])])
  const repoDir = dir ?? repoArg.split('/').pop()!
  // Safety net for repos created before HEAD pointed at main: never leave
  // a clone sitting on the forge-managed _meta branch.
  const head = Bun.spawnSync(['git', 'symbolic-ref', '--short', 'HEAD'], { cwd: repoDir }).stdout.toString().trim()
  if (head === '_meta') {
    run(['git', 'checkout', 'main'], repoDir)
    console.log(chalk.dim('(switched to main — _meta is the forge\'s metadata branch)'))
  }
  if (identity?.apiToken) {
    run(['git', 'config', `http.${opts.server}.extraHeader`, `Authorization: Bearer ${identity.apiToken}`], repoDir)
    console.log('push access wired (your gild token). `git push` just works.')
  } else {
    console.log(chalk.dim('cloned read-only; run `gild token` and re-set the push header to push'))
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
  .description('git credential helper — git runs this; see `gild setup git`')
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
    if (!identity?.apiToken) process.exit(0) // no answer = git falls back to prompting
    // The proxy checks the password slot; any username works.
    console.log('username=gild')
    console.log(`password=${identity.apiToken}`)
  })

program
  .command('setup')
  .description('one-time machine setup')
  .command('git')
  .description('register gild as git\'s credential helper for the forge, so every clone pushes without prompts')
  .option('--server <url>', 'forge base URL', 'https://gild.gg')
  .action(async (opts) => {
    const identity = await loadIdentity()
    if (!identity?.apiToken) { console.error('Run `gild token` first — the helper answers with your API token.'); process.exitCode = 1; return }
    if (!ensureGitHelper(opts.server)) { console.error(chalk.red('git config failed')); process.exitCode = 1; return }
    console.log(chalk.green(`git is wired: pushes to ${opts.server} use your gild token automatically.`))
    console.log('Any clone works now — plain `git clone`, CI, scripts. Rotate any time with `gild token`.')
  })

if (import.meta.main) program.parseAsync()
