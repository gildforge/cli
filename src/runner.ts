import { runnerService } from './runner-service'
import {
  serverTokenSchema,
  tokenForServer,
  type ServerToken,
} from './server-token'

import { GildClient, requestPath } from './api/client'
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  realpath,
} from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import type { Command } from 'commander'
import { z } from 'zod'

const configSchema = z
  .object({
    schema: z.literal(1),
    id: z.string(),
    token: z.string().regex(/^(gr|gro|gc)_[a-zA-Z0-9]+$/),
    scope: z.enum(['repo', 'org', 'user']).optional(),
    owner: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,38}$/i)
      .optional(),
    name: z.string().regex(/^[a-zA-Z0-9][\w.-]{0,63}$/),
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional(),
    server: z.string().url(),
    os: z.string(),
    arch: z.string(),
    labels: z.array(z.string()),
  })
  .superRefine((data, ctx) => {
    if (data.scope === 'org' || data.scope === 'user') {
      if (!data.owner || !data.token.startsWith('gro_'))
        ctx.addIssue({
          code: 'custom',
          message: 'Owner runner requires owner and gro_ token',
        })
    } else if (!data.repo)
      ctx.addIssue({
        code: 'custom',
        message: 'Repo runner requires a repository',
      })
  })
export type RunnerConfig = z.infer<typeof configSchema>
export interface RunnerStep {
  name: string
  run?: string
  uses?: string
  shell: string
  directory: string
  env: Record<string, string>
  with: Record<string, string>
  continueOnError: boolean
  timeout: number
  when: { success: boolean; failure: boolean; cancelled: boolean }
}
export interface Assignment {
  schema: 1
  checkoutToken?: string
  workspaceToken: string
  github: Record<string, string>
  job: number
  run: number
  lease: string
  sha: string
  ref: string
  repository: string
  steps: RunnerStep[]
  timeout: number
}
const configRoot = () => join(homedir(), '.config', 'gild')
function runnerDir(root: string) {
  return join(root, 'runners')
}
function configPath(root: string, name: string) {
  if (!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(name))
    throw new Error('invalid runner name')
  return join(runnerDir(root), `${name}.json`)
}
export async function saveRunner(root: string, config: RunnerConfig) {
  configSchema.parse(config)
  await mkdir(runnerDir(root), { recursive: true, mode: 0o700 })
  await chmod(runnerDir(root), 0o700)
  const path = configPath(root, config.name),
    temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
}
export async function loadRunner(
  root: string,
  name: string,
): Promise<RunnerConfig> {
  const path = configPath(root, name)
  await chmod(path, 0o600)
  await chmod(runnerDir(root), 0o700)
  return configSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}
export async function listRunners(root: string): Promise<RunnerConfig[]> {
  const files = await readdir(runnerDir(root)).catch(() => [] as string[])
  return Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map((f) => loadRunner(root, f.slice(0, -5))),
  )
}
export async function request(
  config: Pick<RunnerConfig, 'server' | 'repo' | 'token' | 'scope' | 'owner'>,
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<any> {
  const client = new GildClient(
    config.server.replace(/\/$/, '') + '/api/v1',
    config.token,
  )
  return requestPath(
    client,
    method,
    `${config.scope === 'org' ? '/orgs/' + config.owner : config.scope === 'user' ? '/users/' + config.owner : '/repos/' + config.repo}/actions/${path || 'runners'}`,

    body,
  )
}
const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        done()
      },
      timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
  })
export function assertRunnerHost(allowRoot = false) {
  if (!['linux', 'darwin', 'win32'].includes(process.platform))
    throw new Error('gild runners support Linux, macOS and Windows')
  if (process.getuid?.() === 0 && !allowRoot)
    throw new Error(
      'gild runner does not run as root; use a regular user (or explicitly pass --allow-root)',
    )
}
export async function insideWorkspace(workspace: string, path: string) {
  const root = await realpath(workspace),
    target = await realpath(resolve(workspace, path)),
    r = relative(root, target)
  if (
    r === '..' ||
    r.startsWith('../') ||
    r.startsWith('..\\') ||
    isAbsolute(r)
  )
    throw new Error('working-directory must stay inside this checkout')
  return target
}
export function shellCommand(shell: string, script: string): string[] {
  if (shell === 'bash')
    return ['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', script]
  if (shell === 'sh') return ['sh', '-e', script]
  if (shell === 'pwsh' || shell === 'powershell')
    return [shell, '-NoProfile', '-NonInteractive', '-File', script]
  if (shell === 'python') return ['python', script]
  // Documented shell templates; no shell eval or command substitution here.
  const parts = shell.split(/\s+/)
  if (!parts.includes('{0}') || parts.some((p) => /["'`$;|&<>]/.test(p)))
    throw new Error(
      `unsupported shell ${shell}; use bash, sh, python or a command template containing {0}`,
    )
  return parts.map((p) => (p === '{0}' ? script : p))
}
function envFor(work: string, env: Record<string, string> = {}) {
  return {
    ...(process.platform === 'win32'
      ? {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          WINDIR: process.env.WINDIR ?? 'C:\\Windows',
          COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
          TEMP: join(work, 'tmp'),
          TMP: join(work, 'tmp'),
        }
      : {}),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(work, 'home'),
    TMPDIR: join(work, 'tmp'),
    RUSTUP_HOME: join(homedir(), '.rustup'),
    LANG: 'C.UTF-8',
    CI: 'true',
    ...env,
  }
}
/** Stop only PIDs started by this job (enumerated descendants included). Never
 * pattern-kill shared tools or unrelated runners. */
function processTree(child: ChildProcess) {
  const owned = new Map<number, string>()
  const scan = () => {
    const rows =
      process.platform === 'win32'
        ? (
            JSON.parse(
              execFileSync(
                'powershell.exe',
                [
                  '-NoProfile',
                  '-Command',
                  '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress',
                ],
                { encoding: 'utf8' },
              ),
            ) as {
              ProcessId: number
              ParentProcessId: number
              CreationDate: string
            }[]
          ).map((r) => ({
            pid: r.ProcessId,
            parent: r.ParentProcessId,
            started: r.CreationDate,
          }))
        : execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], {
            encoding: 'utf8',
          })
            .trim()
            .split('\n')
            .map((line) => {
              const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
              return m
                ? { pid: Number(m[1]), parent: Number(m[2]), started: m[3] }
                : null
            })
            .filter((r) => r !== null)
    const root = rows.find((r) => r.pid === child.pid)
    if (root && !owned.has(root.pid)) owned.set(root.pid, root.started)
    let added: boolean
    do {
      added = false
      for (const r of rows)
        if (owned.has(r.parent) && !owned.has(r.pid)) {
          owned.set(r.pid, r.started)
          added = true
        }
    } while (added)
    return rows
  }
  const stop = (signal: NodeJS.Signals) => {
    const rows = scan()
    for (const [pid, stamp] of [...owned].reverse())
      if (rows.some((r) => r.pid === pid && r.started === stamp)) {
        try {
          process.kill(pid, signal)
        } catch {}
      }
  }
  return { scan, stop }
}
async function command(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
  output: (line: string) => Promise<void>,
  timeout: number,
): Promise<number> {
  if (signal.aborted) return 130
  const child = spawn(args[0], args.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let failure: unknown,
    timed = false
  const tree = processTree(child),
    tracker = setInterval(() => {
      try {
        tree.scan()
      } catch {}
    }, 250)
  const timer = setTimeout(() => {
      timed = true
      tree.stop('SIGTERM')
    }, timeout),
    abort = () => tree.stop('SIGTERM')
  signal.addEventListener('abort', abort, { once: true })
  const force = () => tree.stop('SIGKILL'),
    killer = setInterval(() => {
      if (signal.aborted || timed || failure) force()
    }, 2000)
  const consume = async (stream: AsyncIterable<Buffer>) => {
    const decoder = new TextDecoder()
    let pending = '',
      blocked = false
    try {
      for await (const chunk of stream) {
        if (blocked) continue
        pending += decoder.decode(chunk, { stream: true })
        let at: number
        while ((at = pending.indexOf('\n')) >= 0) {
          if (at > 32768) {
            blocked = true
            failure = new Error('output line exceeds 32 KiB')
            tree.stop('SIGTERM')
            pending = ''
            break
          }
          await output(pending.slice(0, at).replace(/\r$/, ''))
          pending = pending.slice(at + 1)
        }
        // Do not emit any tail after dropping an oversized line: it could be
        // the second half of a secret split across stream chunks.
        if (pending.length > 32768) {
          blocked = true
          failure = new Error('output line exceeds 32 KiB')
          tree.stop('SIGTERM')
          pending = ''
        }
      }
      if (!blocked) {
        pending += decoder.decode()
        if (pending) await output(pending)
      }
    } catch (e) {
      failure = e
      tree.stop('SIGTERM')
      throw e
    }
  }
  const exited = new Promise<number>((done, reject) => {
    child.once('error', reject)
    child.once('close', (code) => done(code ?? (signal.aborted ? 130 : 1)))
  })
  try {
    const results = await Promise.allSettled([
      exited,
      consume(child.stdout!),
      consume(child.stderr!),
    ])
    for (const r of results) if (r.status === 'rejected') throw r.reason
    if (failure) throw failure
    if (timed) {
      await output(`[gild: step timeout after ${timeout / 60000} minutes]`)
      return 124
    }
    return (results[0] as PromiseFulfilledResult<number>).value
  } finally {
    clearTimeout(timer)
    clearInterval(killer)
    clearInterval(tracker)
    signal.removeEventListener('abort', abort)
    tree.stop('SIGTERM')
  }
}
export function toolCheck(
  uses: string,
  inputs: Record<string, string>,
): { command: string[]; version?: string; label: string } | null {
  const action = uses.split('@')[0].toLowerCase()
  if (action === 'actions/setup-node')
    return {
      command: ['node', '--version'],
      version: inputs['node-version'],
      label: 'Node',
    }
  if (action === 'oven-sh/setup-bun')
    return {
      command: ['bun', '--version'],
      version: inputs['bun-version'],
      label: 'Bun',
    }
  if (action === 'actions/setup-go')
    return {
      command: ['go', 'version'],
      version: inputs['go-version'],
      label: 'Go',
    }
  if (
    action === 'dtolnay/rust-toolchain' ||
    action === 'actions-rs/toolchain'
  ) {
    const version = inputs.toolchain ?? uses.split('@')[1] ?? 'stable'
    return {
      command: ['rustup', 'run', version, 'rustc', '--version'],
      version: /^\d/.test(version) ? version : undefined,
      label: `Rust (${version})`,
    }
  }
  return null
}
export function versionMatches(actual: string, requested?: string) {
  if (!requested) return true
  // Numeric major/minor/patch and wildcard selectors only. A hosted machine
  // label never promises a hosted image's installed toolchain.
  const r = requested.replace(/^v/, '').split('.'),
    m = actual.match(/(?:v|go)?(\d+)\.(\d+)\.(\d+)/)
  if (!m || !/^v?\d+(?:\.(?:\d+|x|\*)){0,2}$/.test(requested)) return false
  return r.every((v, i) => v === 'x' || v === '*' || v === m[i + 1])
}
class LogBatch {
  private lines: string[] = []
  private bytes = 0
  private chain = Promise.resolve()
  private timer: ReturnType<typeof setInterval>
  constructor(
    private config: RunnerConfig,
    private job: Assignment,
    private step: number,
    private sequence = { next: 0 },
  ) {
    this.timer = setInterval(() => {
      void this.flush().catch(() => {})
    }, 500)
  }
  async line(line: string) {
    this.lines.push(line)
    this.bytes += line.length
    if (this.bytes >= 16384 || this.lines.length >= 128) await this.flush()
  }
  flush() {
    if (!this.lines.length) return this.chain
    const lines = this.lines
    this.lines = []
    this.bytes = 0
    const batch = this.sequence.next++
    this.chain = this.chain.then(async () => {
      let error: unknown
      for (let i = 0; i < 3; i++) {
        try {
          await request(this.config, 'runners/logs', {
            job: this.job.job,
            lease: this.job.lease,
            step: this.step,
            batch,
            lines,
          })
          return
        } catch (e) {
          error = e
          await delay(200 * (i + 1))
        }
      }
      throw error
    })
    return this.chain
  }
  async close() {
    clearInterval(this.timer)
    await this.flush()
  }
}
export async function executeJob(
  config: RunnerConfig,
  job: Assignment,
  root: string,
  outer: AbortSignal,
) {
  if (job.schema !== 1) throw new Error('unsupported runner protocol version')
  if (!/^[0-9a-f]{40}$/.test(job.sha) || job.repository !== config.repo)
    throw new Error('invalid assignment commit or repo')
  const work = join(
      runnerDir(root),
      config.name,
      'work',
      `${job.run}-${job.job}-${job.lease}`,
    ),
    checkout = join(work, 'checkout')
  if (!/^[\w-]+$/.test(job.lease)) throw new Error('invalid job lease')
  await mkdir(work, { recursive: true, mode: 0o700 })
  await chmod(work, 0o700)
  await mkdir(join(work, 'home'), { recursive: true })
  await mkdir(join(work, 'tmp'), { recursive: true })
  const controller = new AbortController(),
    cancel = () => controller.abort()
  outer.addEventListener('abort', cancel, { once: true })
  if (outer.aborted) cancel()
  let leaseFailure = false,
    heartbeatRunning = false,
    status: 'success' | 'failure' | 'cancelled' = 'success',
    reason: string | null = null
  const heartbeat = setInterval(async () => {
    if (heartbeatRunning) return
    heartbeatRunning = true
    try {
      const r = await request(config, 'runners/heartbeat', {
        job: job.job,
        lease: job.lease,
      })
      if (r.cancel) cancel()
    } catch {
      leaseFailure = true
      cancel()
    } finally {
      heartbeatRunning = false
    }
  }, 10_000)
  const deadline = setTimeout(() => {
    reason = 'job timeout exceeded'
    cancel()
  }, job.timeout)
  const logCounters = new Map<number, { next: number }>(),
    counter = (step: number) => {
      if (!logCounters.has(step)) logCounters.set(step, { next: 0 })
      return logCounters.get(step)!
    }
  try {
    const bootstrap = new LogBatch(config, job, 0, counter(0))
    try {
      // Runner-scoped token proves only this repo's read/job access; no owner
      // API token or git credentials are available to workflow subprocesses.
      const gitEnv = {
        ...envFor(work),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${config.server}.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${config.token}`,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      }
      const url = `${config.server}/${config.repo}.git`
      if (
        (await command(
          ['git', 'clone', '--no-checkout', url, checkout],
          work,
          gitEnv,
          controller.signal,
          (s) => bootstrap.line(s),
          120_000,
        )) !== 0
      )
        throw new Error('checkout through gild failed')
      // Fetch an immutable commit if the branch moved or disappeared after scheduling.
      if (
        (await command(
          ['git', 'fetch', 'origin', job.sha],
          checkout,
          gitEnv,
          controller.signal,
          (s) => bootstrap.line(s),
          120_000,
        )) !== 0
      )
        throw new Error('assigned commit could not be fetched')
      if (
        (await command(
          [
            'git',
            '-c',
            'core.hooksPath=' + join(work, 'disabled-hooks'),
            'checkout',
            '--detach',
            job.sha,
          ],
          checkout,
          gitEnv,
          controller.signal,
          (s) => bootstrap.line(s),
          120_000,
        )) !== 0
      )
        throw new Error('assigned commit could not be checked out')
      await command(
        ['git', 'remote', 'set-url', 'origin', url],
        checkout,
        envFor(work),
        controller.signal,
        (s) => bootstrap.line(s),
        30_000,
      )
    } finally {
      await bootstrap.close()
    }
    for (let i = 0; i < job.steps.length; i++) {
      const expand = (text: string) =>
        text.replaceAll(job.workspaceToken, checkout)
      const raw = job.steps[i],
        s = {
          ...raw,
          run: raw.run === undefined ? undefined : expand(raw.run),
          directory: expand(raw.directory),
          env: Object.fromEntries(
            Object.entries(raw.env).map(([k, v]) => [k, expand(v)]),
          ),
          with: Object.fromEntries(
            Object.entries(raw.with).map(([k, v]) => [k, expand(v)]),
          ),
        },
        api = { job: job.job, lease: job.lease, step: i },
        cancelled = controller.signal.aborted
      if (cancelled) {
        status = reason || leaseFailure ? 'failure' : 'cancelled'
        break
      }
      if (!s.when[status === 'failure' ? 'failure' : 'success']) {
        await request(config, 'runners/step', {
          ...api,
          status: 'skipped',
          exit: null,
        })
        continue
      }
      await request(config, 'runners/step', {
        ...api,
        status: 'running',
        exit: null,
      })
      const log = new LogBatch(config, job, i, counter(i))
      let exit = 1
      try {
        const cwd = await insideWorkspace(checkout, s.directory),
          env = {
            ...envFor(work, s.env),
            ...Object.fromEntries(
              Object.entries(job.github).map(([k, v]) => [
                `GITHUB_${k.toUpperCase()}`,
                expand(v),
              ]),
            ),
            GITHUB_SHA: job.sha,
            GITHUB_REF: job.ref,
            GITHUB_REPOSITORY: job.repository,
            GITHUB_WORKSPACE: checkout,
          }
        if (s.run !== undefined) {
          const script = join(
            work,
            `step-${i}.${s.shell === 'pwsh' || s.shell === 'powershell' ? 'ps1' : 'script'}`,
          )
          await writeFile(script, s.run + '\n', { mode: 0o600 })
          exit = await command(
            shellCommand(s.shell, script),
            cwd,
            env,
            controller.signal,
            (line) => log.line(line),
            Math.min(s.timeout, job.timeout),
          )
        } else {
          const action = s.uses!.split('@')[0].toLowerCase(),
            tool = toolCheck(s.uses!, s.with)
          if (action === 'actions/checkout') {
            const unsupported = Object.keys(s.with).filter(
              (k) => !['fetch-depth', 'persist-credentials'].includes(k),
            )
            if (unsupported.length)
              throw new Error(
                `gild checkout does not support: ${unsupported.join(', ')}`,
              )
            await log.line(
              `[gild: already checked out ${job.sha} through gild; credentials are not persisted]`,
            )
            exit = 0
          } else if (
            ['actions/upload-artifact', 'actions/cache'].includes(action)
          ) {
            await log.line(
              `[gild: ${s.uses} is a no-op; artifacts and dependency caches are not uploaded]`,
            )
            exit = 0
          } else if (tool) {
            const actionInputs: Record<string, string[]> = {
              'actions/setup-node': [
                'node-version',
                'cache',
                'cache-dependency-path',
              ],
              'oven-sh/setup-bun': ['bun-version'],
              'actions/setup-go': [
                'go-version',
                'cache',
                'cache-dependency-path',
              ],
              'dtolnay/rust-toolchain': ['toolchain', 'components', 'targets'],
              'actions-rs/toolchain': [
                'toolchain',
                'components',
                'targets',
                'override',
                'profile',
              ],
            }
            const unsupported = Object.keys(s.with).filter(
              (k) => !actionInputs[action]?.includes(k),
            )
            if (unsupported.length)
              throw new Error(
                `gild ${action} does not support: ${unsupported.join(', ')}`,
              )
            if (s.with.cache)
              await log.line(
                '[gild: dependency cache options are a no-op on this machine]',
              )
            const output: string[] = []
            exit = await command(
              tool.command,
              cwd,
              env,
              controller.signal,
              async (line) => {
                output.push(line)
                await log.line(line)
              },
              s.timeout,
            )
            if (
              exit !== 0 ||
              !versionMatches(output.join('\n'), tool.version)
            ) {
              await log.line(
                `[gild: ${tool.label}${tool.version ? ` ${tool.version}` : ''} is required on this machine; install it before starting the runner]`,
              )
              exit = 1
            }
            if (
              action === 'dtolnay/rust-toolchain' ||
              action === 'actions-rs/toolchain'
            ) {
              if (s.with.components || s.with.targets)
                throw new Error(
                  'gild toolchain checks do not support components or targets yet',
                )
            }
          } else {
            await log.line(`gild doesn't run ${s.uses} yet`)
            exit = 1
          }
        }
      } catch (e) {
        await log.line(`[gild: ${(e as Error).message}]`)
        exit = 1
      } finally {
        await log.close()
      }
      await request(config, 'runners/step', {
        ...api,
        status: controller.signal.aborted
          ? 'cancelled'
          : exit === 0
            ? 'success'
            : 'failure',
        exit,
      })
      if (exit !== 0 && !s.continueOnError) {
        status = 'failure'
        reason = `step ${i + 1} failed with exit ${exit}`
      }
    }
    if (controller.signal.aborted)
      status = reason || leaseFailure ? 'failure' : 'cancelled'
  } catch (e) {
    status =
      controller.signal.aborted && !leaseFailure && !reason
        ? 'cancelled'
        : 'failure'
    reason = (e as Error).message
  } finally {
    clearInterval(heartbeat)
    clearTimeout(deadline)
    outer.removeEventListener('abort', cancel)
    try {
      await request(config, 'runners/finish', {
        job: job.job,
        lease: job.lease,
        status,
        reason,
      })
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }
  return status
}
export async function startRunner(
  config: RunnerConfig,
  root: string,
  signal: AbortSignal,
  once = false,
) {
  while (!signal.aborted) {
    const { job } = (await request(config, 'runners/poll', {})) as {
      job: Assignment | null
    }
    if (!job) {
      if (once) return null
      continue
    }
    console.log(`Run #${job.run}, job #${job.job} on ${config.name}`)
    const jobConfig = job.checkoutToken
      ? {
          ...config,
          scope: 'repo' as const,
          repo: job.repository,
          token: job.checkoutToken,
        }
      : config
    const status = await executeJob(jobConfig, job, root, signal)
    console.log(`Run #${job.run}: ${status}`)
    if (once) return status
  }
  return null
}
async function runnerIdentity(
  root: string,
  load: () => Promise<{ apiToken?: ServerToken | null } | null>,
) {
  if (resolve(root) === resolve(configRoot())) return load()
  const file = join(root, 'identity.json')
  try {
    await chmod(file, 0o600)
    return z
      .object({ apiToken: serverTokenSchema })
      .parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
export function runnerCommands(
  program: Command,
  loadIdentity: () => Promise<{ apiToken?: ServerToken | null } | null>,
) {
  const runner = program
    .command('runner')
    .description('Actions on machines you register')
  runner
    .command('add')
    .option('--repo <owner/name>', 'repo to run jobs for')
    .option('--org <name>', 'organization to run jobs for')
    .option('--user <name>', 'personal account to run jobs for')
    .option('--group <group>', 'owner runner group', 'default')
    .option('--token <token>', 'one-time registration token')
    .option('--name <name>', 'machine name', hostname())
    .option('--labels <labels>', 'comma-separated custom labels', '')
    .option('--server <url>', 'forge base URL', 'https://gild.gg')
    .option('--config-dir <path>', 'gild config directory', configRoot())
    .action(async (opts) => {
      assertRunnerHost(true)
      if ([opts.repo, opts.org, opts.user].filter(Boolean).length !== 1)
        throw Error('Choose exactly one of --repo, --org or --user')
      if (opts.repo && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo))
        throw Error('--repo must be owner/name')
      const scope = opts.org
          ? ('org' as const)
          : opts.user
            ? ('user' as const)
            : ('repo' as const),
        owner = opts.org ?? opts.user
      configPath(opts.configDir, opts.name)
      if ((await listRunners(opts.configDir)).some((r) => r.name === opts.name))
        throw new Error('runner name already stored; remove it first')
      const identity = opts.token
        ? null
        : await runnerIdentity(opts.configDir, loadIdentity)
      const registrationToken =
        opts.token ?? tokenForServer(identity?.apiToken, opts.server)
      if (!registrationToken)
        throw new Error('Use --token or run gild auth token first')
      const server = new URL(opts.server)
      if (
        server.protocol !== 'https:' &&
        !(
          server.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)
        )
      )
        throw new Error(
          'runner server requires HTTPS (or localhost for development)',
        )
      if (
        server.username ||
        server.password ||
        server.search ||
        server.hash ||
        server.pathname !== '/'
      )
        throw new Error(
          '--server must be a forge origin, without credentials or a path',
        )
      const labels = opts.labels
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean),
        base = {
          name: opts.name,
          os: process.platform,
          arch: process.arch,
          labels,
        }
      const result = await request(
        {
          server: server.origin,
          repo: opts.repo,
          scope,
          owner,
          token: registrationToken,
        },
        'runners',
        scope === 'repo' ? base : { ...base, group: opts.group },
      )
      await saveRunner(opts.configDir, {
        schema: 1,
        ...base,
        ...result,
        repo: opts.repo,
        scope,
        owner,
        server: server.origin,
      })
      console.log(
        `Registered ${opts.name} for ${opts.repo ?? owner}. Start with gild runner start --name ${opts.name}`,
      )
    })
  runner
    .command('start')
    .option('--name <name>', 'registered runner name')
    .option('--config-dir <path>', 'gild config directory', configRoot())
    .option('--allow-root', 'explicitly allow running as root')
    .option('--once', 'run at most one job and exit')
    .action(async (opts) => {
      assertRunnerHost(opts.allowRoot)
      const configs = await listRunners(opts.configDir),
        config = opts.name
          ? await loadRunner(opts.configDir, opts.name)
          : configs.length === 1
            ? configs[0]
            : null
      if (!config)
        throw new Error(
          'choose a runner with --name (register with gild runner add first)',
        )
      const c = new AbortController(),
        stop = () => c.abort()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      console.log(
        `${config.name} waiting for ${config.repo ?? config.owner} (${config.labels.join(', ') || 'OS and architecture labels'})`,
      )
      try {
        await startRunner(config, opts.configDir, c.signal, opts.once)
      } finally {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
    })
  runner
    .command('list')
    .option('--org <name>')
    .option('--user <name>')
    .option('--server <url>', 'forge base URL', 'https://gild.gg')
    .option('--config-dir <path>', 'gild config directory', configRoot())
    .action(async (opts) => {
      if (opts.org || opts.user) {
        const identity = await runnerIdentity(opts.configDir, loadIdentity)
        if (!identity?.apiToken) throw Error('Run gild auth token first')
        console.log(
          JSON.stringify(
            await request(
              {
                server: opts.server,
                scope: opts.org ? 'org' : 'user',
                owner: opts.org ?? opts.user,
                token: tokenForServer(identity.apiToken, opts.server),
              },
              'runners',
              undefined,
              'GET',
            ),
            null,
            2,
          ),
        )
        return
      }
      for (const r of await listRunners(opts.configDir)) {
        const identity = await runnerIdentity(opts.configDir, loadIdentity)
        const token =
          identity?.apiToken?.server === r.server
            ? tokenForServer(identity.apiToken, r.server)
            : r.token
        const view = await request({ ...r, token }, '', undefined, 'GET'),
          live = view.runners.find(
            (x: { gild_id: string }) => x.gild_id === r.id,
          )
        let run: number | undefined
        if (live?.busy && r.repo) {
          const [owner, repo] = r.repo.split('/')
          const client = new GildClient(
            r.server.replace(/\/$/, '') + '/api/v1',
            token,
          )
          const overview = await client.request('actionOverview', {
            owner,
            repo,
          })
          for (const active of overview.workflow_runs.filter(
            (x: { status: string }) => x.status === 'in_progress',
          )) {
            const jobs = await client.request('actionJobs', {
              owner,
              repo,
              run: active.id,
            })
            if (
              jobs.jobs.some(
                (job: { status: string; runner_id: number | null }) =>
                  job.status === 'in_progress' && job.runner_id === live.id,
              )
            ) {
              run = active.run_number
              break
            }
          }
        }

        console.log(
          `${r.name}  ${r.repo}  ${r.os} · ${r.arch}  ${live ? (live.busy ? `busy${run === undefined ? '' : ` · run #${run}`}` : 'idle') : 'removed'}`,
        )
      }
    })
  runner
    .command('remove <name>')
    .option('--config-dir <path>', 'gild config directory', configRoot())
    .action(async (name, opts) => {
      const config = await loadRunner(opts.configDir, name),
        identity = await runnerIdentity(opts.configDir, loadIdentity)
      if (!identity?.apiToken) throw new Error('run gild auth token first')
      await request(
        { ...config, token: tokenForServer(identity.apiToken, config.server) },
        `runners/${config.id}`,
        undefined,
        'DELETE',
      )
      await rm(configPath(opts.configDir, name))
      console.log(`Removed ${name}`)
    })
  const group = runner.command('group').description('owner runner groups')
  for (const action of [
    'create',
    'ls',
    'add-repo',
    'rm-repo',
    'allow-public',
  ] as const) {
    const cmd = group
      .command(action)
      .option('--org <name>')
      .option('--user <name>')
      .option('--server <url>', 'forge base URL', 'https://gild.gg')
      .option('--config-dir <path>', 'gild config directory', configRoot())
    if (action !== 'ls') cmd.argument('<group>')
    if (action === 'add-repo' || action === 'rm-repo')
      cmd.argument('<repo>', 'repo name (owner is inferred)')
    if (action === 'allow-public') cmd.argument('<enabled>', 'true or false')
    cmd.action(async (...args) => {
      const opts = args[action === 'ls' ? 0 : action === 'create' ? 1 : 2]
      if (Boolean(opts.org) === Boolean(opts.user))
        throw Error('Choose --org or --user')
      const identity = await runnerIdentity(opts.configDir, loadIdentity)
      if (!identity?.apiToken) throw Error('Run gild auth token first')
      const owner = opts.org ?? opts.user,
        config = {
          server: opts.server,
          scope: opts.org ? ('org' as const) : ('user' as const),
          owner,
          token: tokenForServer(identity.apiToken, opts.server),
        }
      const path =
        action === 'ls' || action === 'create'
          ? 'runner-groups'
          : 'runner-groups/' +
            encodeURIComponent(args[0]) +
            (action === 'add-repo' || action === 'rm-repo'
              ? '/repositories/' +
                encodeURIComponent(args[1].replace(owner + '/', ''))
              : '')
      if (action === 'allow-public' && !['true', 'false'].includes(args[1]))
        throw Error('Use true or false')
      console.log(
        JSON.stringify(
          await request(
            config,
            path,
            action === 'create'
              ? { name: args[0] }
              : action === 'allow-public'
                ? { allow_public_repositories: args[1] === 'true' }
                : undefined,
            action === 'ls'
              ? 'GET'
              : action === 'create'
                ? 'POST'
                : action === 'add-repo'
                  ? 'PUT'
                  : action === 'rm-repo'
                    ? 'DELETE'
                    : 'PATCH',
          ),
          null,
          2,
        ),
      )
    })
  }
  const service = runner
    .command('service')
    .description('run a registered runner as an OS service')
  for (const action of ['install', 'uninstall', 'status'] as const)
    service
      .command(action)
      .requiredOption('--name <name>')
      .option('--config-dir <path>', 'gild config directory', configRoot())
      .action(async (opts) => {
        if (action === 'install') await loadRunner(opts.configDir, opts.name)
        await runnerService(action, {
          name: opts.name,
          configDir: opts.configDir,
        })
        console.log(`Service ${action}: ${opts.name}`)
      })
}
