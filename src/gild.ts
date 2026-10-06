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

// ---------- identity storage (~/.config/gild/identity.json, mode 0600) ----------

const identitySchema = z.object({
  schema: z.literal(1),
  name: z.string().nullable(),          // claimed @name, once the ledger exists
  device: z.string(),                   // human label for this machine
  publicKey: z.string(),                // ed25519:<base64>
  secretKey: z.string(),                // ed25519 private (base64 PKCS8)
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

// ---------- commands ----------

const program = new Command()
program.name('gild').description('gild — key-first identity for the forge').version('0.1.0')

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

    console.log()
    console.log(chalk.green('Identity created.'))
    console.log(`  device:      ${identity.device}`)
    console.log(`  public key:  ${identity.publicKey}`)
    console.log(`  fingerprint: ${fingerprint(identity.publicKey)}`)
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

if (import.meta.main) program.parseAsync()
