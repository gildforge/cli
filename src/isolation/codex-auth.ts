import { z } from 'zod'
import { fstatSync, fsyncSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { AnchoredDirectory } from './anchored-fs'
import type { Isolation } from './session'
import { privateSessionsDirectory } from '../spawn-sessions'

export const codexAuthSchema = z
  .object({
    source: z.string().refine((p) => isAbsolute(p) && !p.includes('\0')),
    dedicated: z.literal(true),
  })
  .strict()
export type CodexAuthSource = z.infer<typeof codexAuthSchema>
const MAX = 64 * 1024
const GUEST_DIRECTORY = '/root/.codex'
const GUEST_FILE = GUEST_DIRECTORY + '/auth.json'
export class CodexCredentialError extends Error {}
const problem = (message: string) => new CodexCredentialError(message)

export function codexFileArgs(args: string[]) {
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const argument = args[index]
    const value =
      argument === '-c' || argument === '--config'
        ? args[++index]
        : argument.startsWith('--config=')
          ? argument.slice(9)
          : argument.startsWith('-c')
            ? argument.slice(2)
            : undefined
    if (
      value &&
      /^\s*cli_auth_credentials_store\s*=/.test(value) &&
      !/^\s*cli_auth_credentials_store\s*=\s*(?:"file"|'file'|file)\s*$/.test(
        value,
      )
    )
      throw problem(
        'Selected Codex source requires file credential storage; conflicting storage options are unsupported',
      )
  }
  return ['-c', 'cli_auth_credentials_store="file"', ...args]
}

function privateParent(path: string) {
  let at = AnchoredDirectory.open('/')
  try {
    for (const part of dirname(path).split('/').filter(Boolean)) {
      const next = at.directory(part)
      at.close()
      at = next
      const info = fstatSync(at.fd)
      if (info.uid !== 0 && info.uid !== process.getuid!())
        throw problem('Selected Codex source has an unowned parent')
    }
    const info = fstatSync(at.fd)
    if (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700)
      throw problem(
        'Selected Codex source directory must be owner-private (0700)',
      )
    return at
  } catch {
    at.close()
    throw problem('Selected Codex source directory is unsafe or unavailable')
  }
}
function checkCache(bytes: Buffer) {
  try {
    if (bytes.length > MAX) throw Error()
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.OPENAI_API_KEY ||
      parsed.auth_mode !== 'chatgpt' ||
      !parsed.tokens ||
      typeof parsed.tokens !== 'object' ||
      Array.isArray(parsed.tokens) ||
      !['access_token', 'refresh_token'].every(
        (key) =>
          typeof parsed.tokens[key] === 'string' &&
          parsed.tokens[key].trim().length > 0 &&
          parsed.tokens[key].length <= 32768,
      )
    )
      throw Error()
  } catch {
    throw problem(
      'Selected Codex cache is invalid, oversized, or uses an unsupported API-key mode',
    )
  }
}

/** A single selected rotating cache, not an OAuth service or protected custody.
 * Independent apps do not honor this lease; only a dedicated source is supported. */
export class CodexCredentialLease {
  private delivered = false
  private persisted = false
  private closed = false
  private constructor(
    private readonly source: string,
    private readonly parent: AnchoredDirectory,
    private readonly namespace: AnchoredDirectory,
    private readonly lock: AnchoredDirectory,
    private readonly lockName: string,
    private readonly captured: ReturnType<
      AnchoredDirectory['readPrivateRegular']
    >,
  ) {}
  static async acquire(
    value: CodexAuthSource,
    workspace: string,
    leaseDirectory?: string,
  ) {
    const config = codexAuthSchema.parse(value),
      source = resolve(config.source)
    if (
      source === resolve(homedir(), '.codex', 'auth.json') ||
      (process.env.CODEX_HOME &&
        source === resolve(process.env.CODEX_HOME, 'auth.json'))
    )
      throw problem(
        'The active Codex cache is unsupported: select a dedicated source with no independent consumers',
      )
    if (
      source === resolve(workspace) ||
      source.startsWith(resolve(workspace) + '/')
    )
      throw problem(
        'Selected Codex credentials must stay outside the workspace',
      )
    const parent = privateParent(source)
    let namespace: AnchoredDirectory | undefined,
      lock: AnchoredDirectory | undefined
    const lockName =
      'codex-auth-' + createHash('sha256').update(source).digest('hex')
    try {
      const directory = leaseDirectory ?? (await privateSessionsDirectory())
      namespace = privateParent(join(directory, 'marker'))
      try {
        lock = namespace.privateDirectory(lockName)
      } catch {
        throw problem(
          'Selected Codex source is busy or requires owner reconciliation; its lease cannot be stolen',
        )
      }
      lock.putRegularIfAbsent(
        'state.json',
        Buffer.from(
          JSON.stringify({ schema: 1, stage: 'captured', pid: process.pid }) +
            '\n',
        ),
      )
      fsyncSync(namespace.fd)
      const captured = parent.readPrivateRegular(basename(source), MAX)
      try {
        checkCache(captured.data)
      } catch (e) {
        captured.data.fill(0)
        throw e
      }
      return new CodexCredentialLease(
        source,
        parent,
        namespace,
        lock,
        lockName,
        captured,
      )
    } catch (e) {
      if (lock) {
        if (lock.hasEntry('state.json')) lock.remove('state.json', false)
        namespace?.remove(lockName, true)
        lock.close()
      }
      namespace?.close()
      parent.close()
      if (e instanceof CodexCredentialError) throw e
      throw problem('Selected Codex source is unsafe or unavailable')
    }
  }
  async restore(iso: Isolation) {
    try {
      const code = await iso.exec(
        [
          '/bin/sh',
          '-c',
          'umask 077; mkdir -p /root/.codex; chmod 700 /root/.codex',
        ],
        {
          cwd: '/root',
          env: { HOME: '/root', PATH: '/usr/bin:/bin' },
          timeoutMs: 3000,
          signal: AbortSignal.timeout(4000),
          onLine: async () => {},
        },
      )
      if (code) throw Error()
      // An ambiguous put may have delivered credentials. Retain the lease on failure.
      this.delivered = true
      await iso.put(GUEST_FILE, this.captured.data.toString('utf8'), 0o600)
    } catch {
      this.abandon()
      throw problem(
        'Codex credential delivery failed; selected source requires owner reconciliation',
      )
    }
  }
  async persist(iso: Isolation) {
    let updated: Buffer | undefined
    try {
      if (!this.delivered || !iso.files) throw Error()
      const entries = await iso.files.list(GUEST_DIRECTORY),
        entry = entries.find((e) => e.p === 'auth.json')
      if (
        !entry ||
        entry.k !== 'f' ||
        (entry.m & 0o777) !== 0o600 ||
        (entry.s ?? MAX + 1) > MAX
      )
        throw Error()
      updated = await iso.files.read(GUEST_FILE)
      checkCache(updated)
      const currentParent = privateParent(this.source)
      try {
        const original = fstatSync(this.parent.fd),
          current = fstatSync(currentParent.fd)
        if (original.dev !== current.dev || original.ino !== current.ino)
          throw Error()
      } finally {
        currentParent.close()
      }
      if (
        !this.parent.replacePrivateRegular(
          basename(this.source),
          updated,
          this.captured,
          MAX,
        )
      )
        throw Error()
      this.persisted = true
      this.lock.put(
        'state.json',
        { p: 'state.json', k: 'f', m: 0o600 },
        Buffer.from('{"schema":1,"stage":"persisted"}\n'),
      )
    } catch {
      this.abandon()
      throw problem(
        'Updated Codex cache was not confirmed persisted; selected source requires owner reconciliation',
      )
    } finally {
      updated?.fill(0)
    }
  }
  /** Call only after the VM has closed; other consumers may then capture the updated cache. */
  release() {
    if (this.closed) return
    if (this.delivered && !this.persisted)
      throw problem('Codex cache finalization is incomplete')
    const current = this.namespace.directory(this.lockName)
    try {
      const ours = fstatSync(this.lock.fd),
        now = fstatSync(current.fd)
      if (ours.dev !== now.dev || ours.ino !== now.ino)
        throw problem('Codex lease changed; owner reconciliation is required')
    } finally {
      current.close()
    }
    if (this.lock.names(2).join(',') !== 'state.json')
      throw problem(
        'Codex lease contents changed; owner reconciliation is required',
      )
    this.lock.remove('state.json', false)
    this.namespace.remove(this.lockName, true)
    fsyncSync(this.namespace.fd)
    this.close()
  }
  abandon() {
    if (this.closed) return
    if (!this.delivered) {
      this.release()
      return
    }
    // No dead-PID takeover: a lost refresh result needs explicit owner reconciliation.
    try {
      this.lock.put(
        'state.json',
        { p: 'state.json', k: 'f', m: 0o600 },
        Buffer.from('{"schema":1,"stage":"requires-reconciliation"}\n'),
      )
    } finally {
      this.close()
    }
  }
  private close() {
    this.closed = true
    this.captured.data.fill(0)
    this.lock.close()
    this.namespace.close()
    this.parent.close()
  }
}
