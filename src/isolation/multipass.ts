// `gild spawn --vm` on macOS and Windows: the agent runs in a Multipass VM
// (Ubuntu), driven only through the `multipass` command and its JSON output.
//
// One VM, `gild`, is made on first use and kept. Each session copies the
// working directory in (no mounts), plus the agent's own gild key and its
// repo-scoped token, so the agent clones, pushes and opens pull requests from
// inside the VM. Your own gild key never enters it. Work leaves the VM through
// git; the session's copy stays in the VM until you remove it.
import pkg from '../../package.json'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { VmChild } from '../spawn-vm'

export const MULTIPASS_VM = 'gild'
const HOME = '/home/ubuntu'

/** macOS and Windows run `--vm` in Multipass, unless isolation.json in the
 *  config directory sets up its own `vm` (kernel and rootfs for vz or Firecracker). */
export function usesMultipass(
  configDir?: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== 'darwin' && platform !== 'win32') return false
  if (!configDir) return true
  try {
    return !JSON.parse(readFileSync(join(configDir, 'isolation.json'), 'utf8'))
      .vm
  } catch {
    return true
  }
}

/** Where `gild vm login claude` keeps the Claude Code token (0600, this machine only). */
export const claudeTokenPath = (configDir: string) =>
  join(configDir, 'vm', 'claude.token')

// One-time setup of the VM: what an agent needs to work from inside it. Run
// as plain commands after launch (a cloud-init file left the VM without a
// network address on macOS); a marker file says it finished.
const READY = `${HOME}/.gild-ready`
const SETUP = `set -e
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq git nodejs npm python3 build-essential ca-certificates >/dev/null
sudo npm install -g --silent @anthropic-ai/claude-code gildforge@${pkg.version}
touch ${READY}`

/** The multipass binary's full path: the pty helper runs a path, not a name. */
function multipassPath() {
  const r = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    ['multipass'],
    { encoding: 'utf8' },
  )
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : 'multipass'
}

/** Multipass could not open its SSH connection into the VM. On macOS that is
 *  Local Network privacy refusing the connection, typically once the terminal
 *  or SSH session that started gild has gone; on any host, briefly, a VM whose
 *  network is still coming up. */
export const noRoute = (output: string) => /no route to host/i.test(output)

export function noRouteError(platform: NodeJS.Platform = process.platform) {
  return new Error(
    platform === 'darwin'
      ? 'Multipass cannot reach the gild VM (No route to host). macOS Local Network privacy is blocking it: allow Multipass in System Settings → Privacy & Security → Local Network, and keep the terminal or SSH session that starts gild open until the agent has started'
      : 'Multipass cannot reach the gild VM (No route to host). Check `multipass list` and the host firewall, then run this again',
  )
}

/** Runs `attempt` again while it fails with "No route to host", up to
 *  `tries` times, waiting `delayMs` between tries. */
export function retryNoRoute<T extends { status: number | null }>(
  attempt: () => T & { stdout?: string; stderr?: string },
  { tries = 5, delayMs = 1000, sleep = sleepSync } = {},
): T {
  for (let i = 1; ; i++) {
    const r = attempt()
    if (r.status === 0 || !noRoute(`${r.stderr ?? ''}${r.stdout ?? ''}`))
      return r
    if (i >= tries) return r
    sleep(delayMs)
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function mp(args: string[], input?: string) {
  return retryNoRoute(() => {
    const r = spawnSync('multipass', args, {
      encoding: 'utf8',
      input,
      maxBuffer: 64 << 20,
    })
    if (r.error) throw r.error
    return r
  })
}

function must(args: string[], what: string, input?: string) {
  const r = mp(args, input)
  if (r.status !== 0) {
    const output = `${r.stderr}${r.stdout}`
    if (noRoute(output)) throw noRouteError()
    throw new Error(
      `${what}: ${(r.stderr || r.stdout).trim() || `multipass exited ${r.status}`}`,
    )
  }
  return r.stdout
}

/** Whether the VM finished its one-time setup. Only a missing marker file
 *  means "not set up"; a VM that cannot be reached is an error. */
export function readiness(r: {
  status: number | null
  stdout: string
  stderr: string
}): boolean {
  const answer = r.stdout.trim()
  if (r.status === 0 && answer === 'ready') return true
  if (r.status === 0 && answer === 'missing') return false
  if (noRoute(`${r.stderr}${r.stdout}`)) throw noRouteError()
  throw new Error(
    `checking the gild VM: ${(r.stderr || r.stdout).trim() || `multipass exited ${r.status}`}`,
  )
}

/** The program as the VM runs it: a program inside the working directory by
 *  its path relative to the copy (`./agent.sh`), anything else by name, from
 *  the VM's own PATH. */
export function guestProgram(binary: string, cwd: string) {
  const inside = relative(cwd, binary)
  if (inside && !inside.startsWith('..') && !isAbsolute(inside))
    return `./${inside.split(sep).join('/')}`
  return basename(binary)
}

/** Why Multipass can't be used here, or null. */
export function multipassMissing(): string | null {
  const r = spawnSync('multipass', ['version'], { encoding: 'utf8' })
  if (r.error || r.status !== 0)
    return process.platform === 'win32'
      ? 'Multipass is not installed. Install it from https://multipass.run, then run this again'
      : 'Multipass is not installed. Install it with `brew install --cask multipass` (or from https://multipass.run), then run this again'
  return null
}

/** Make or start the `gild` VM. */
/** One step of making the VM: a spinner, its elapsed time and, while Ubuntu
 *  downloads, Multipass's own percentage; a plain line when not on a terminal. */
function step(label: string, args: string[], log: (line: string) => void) {
  const tty = !!process.stderr.isTTY
  const started = Date.now()
  const seconds = () => `${Math.round((Date.now() - started) / 1000)}s`
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  let frame = 0,
    detail = '',
    out = ''
  if (!tty) log(`${label}…`)
  const draw = () =>
    process.stderr.write(
      `\r\x1b[2K  ${frames[frame++ % frames.length]} ${label}${detail ? ` · ${detail}` : ''}  ${seconds()}`,
    )
  const timer = tty ? setInterval(draw, 120) : undefined
  return new Promise<void>((resolve, reject) => {
    const child = spawn(multipassPath(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const read = (d: Buffer) => {
      out += d.toString()
      const percent = [...d.toString().matchAll(/(\d{1,3})%/g)].at(-1)?.[1]
      if (percent) detail = `${percent}%`
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('error', reject)
    child.on('exit', (code) => {
      if (timer) clearInterval(timer)
      if (code === 0) {
        if (tty) process.stderr.write(`\r\x1b[2K  ✓ ${label}  ${seconds()}\n`)
        else log(`${label}: done in ${seconds()}`)
        return resolve()
      }
      if (tty) process.stderr.write(`\r\x1b[2K  ✗ ${label}  ${seconds()}\n`)
      if (noRoute(out)) return reject(noRouteError())
      const why = out
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .trim()
        .split('\n')
        .at(-1)
      reject(new Error(`${label}: ${why || `multipass exited ${code}`}`))
    })
  })
}

/** Make or start the `gild` VM, showing each step. */
export async function ensureVm(log: (line: string) => void = () => {}) {
  const missing = multipassMissing()
  if (missing) throw new Error(missing)
  const info = mp(['info', MULTIPASS_VM, '--format', 'json'])
  const fresh = info.status !== 0
  const state = fresh
    ? null
    : JSON.parse(info.stdout).info?.[MULTIPASS_VM]?.state
  const isReady = () =>
    readiness(
      mp([
        'exec',
        MULTIPASS_VM,
        '--',
        'sh',
        '-c',
        `test -f ${READY} && echo ready || echo missing`,
      ]),
    )
  const setup = () =>
    log('setting up the gild VM (first time only, a few minutes)')
  if (fresh) {
    setup()
    await step(
      'Download Ubuntu 24.04 and create the VM',
      [
        'launch',
        '24.04',
        '--name',
        MULTIPASS_VM,
        '--cpus',
        '2',
        '--memory',
        '4G',
        '--disk',
        '20G',
        '--timeout',
        '600',
      ],
      log,
    )
  } else if (state !== 'Running')
    await step('Start the gild VM', ['start', MULTIPASS_VM], log)
  if (isReady()) {
    // The VM's gild follows this one: an agent in the VM signs, clones and
    // pushes with it, so an upgrade here upgrades it there.
    const inside = mp([
      'exec',
      MULTIPASS_VM,
      '--',
      'gild',
      '--version',
    ]).stdout.trim()
    if (inside !== pkg.version)
      await step(
        `Update gild in the VM to ${pkg.version}`,
        [
          'exec',
          MULTIPASS_VM,
          '--',
          'sudo',
          'npm',
          'install',
          '-g',
          '--silent',
          '--prefer-online',
          `gildforge@${pkg.version}`,
        ],
        log,
      )
    return
  }
  if (!fresh) setup()
  await step(
    'Install Node, git, Claude Code and gild',
    ['exec', MULTIPASS_VM, '--', 'sh', '-c', SETUP],
    log,
  )
}

/** Resolves when the guest wrote the session's pid file (the program is
 *  starting), when the multipass process exits, or after `timeoutMs`. */
function started(
  child: import('node:child_process').ChildProcess,
  pidFile: string,
  timeoutMs = 20000,
) {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.off('exit', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    child.once('exit', finish)
    const poll = () => {
      if (done) return
      const check = spawn(
        multipassPath(),
        ['exec', MULTIPASS_VM, '--', 'test', '-s', pidFile],
        { stdio: 'ignore' },
      )
      check.on('error', finish)
      check.on('exit', (code) =>
        code === 0 ? finish() : setTimeout(poll, 250),
      )
    }
    poll()
  })
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Write a file in the VM from host content, never through argv. */
function put(path: string, content: string, mode: string) {
  must(
    [
      'exec',
      MULTIPASS_VM,
      '--',
      'sh',
      '-c',
      `umask 077 && mkdir -p "$(dirname ${quote(path)})" && cat > ${quote(path)} && chmod ${mode} ${quote(path)}`,
    ],
    `copying ${basename(path)} into the VM`,
    content,
  )
}

export async function startMultipassChild(opts: {
  pty: typeof import('node-pty')
  configDir: string
  sessionId: string
  cwd: string
  binary: string
  args: string[]
  env: Record<string, string>
  /** The approved local agent this session runs as (its label), if any. */
  agent?: string
  cols: number
  rows: number
  log?: (line: string) => void
}): Promise<VmChild> {
  await ensureVm(opts.log)
  const dir = `${HOME}/gild/sessions/${opts.sessionId}`
  const ws = `${dir}/${basename(opts.cwd)}`
  must(
    [
      'exec',
      MULTIPASS_VM,
      '--',
      'sh',
      '-c',
      `rm -rf ${quote(dir)} && mkdir -p ${quote(dir)}`,
    ],
    'preparing the session in the VM',
  )
  opts.log?.(`copying ${opts.cwd} into the VM`)
  // A tar stream: sockets and other special files are skipped, not fatal.
  const copy = retryNoRoute(() =>
    spawnSync(
      'sh',
      [
        '-c',
        `COPYFILE_DISABLE=1 tar -C ${quote(opts.cwd)} -cf - . 2>/dev/null | ${quote(multipassPath())} exec ${MULTIPASS_VM} -- sh -c ${quote(`mkdir -p ${quote(ws)} && tar -C ${quote(ws)} -xf - 2>/dev/null`)}`,
      ],
      { encoding: 'utf8', maxBuffer: 16 << 20 },
    ),
  )
  if (noRoute(copy.stderr ?? '')) throw noRouteError()
  if (
    copy.status !== 0 ||
    mp(['exec', MULTIPASS_VM, '--', 'test', '-d', ws]).status !== 0
  )
    throw new Error(
      `copying the working directory into the VM: ${copy.stderr.trim() || 'tar failed'}`,
    )

  const program = guestProgram(opts.binary, opts.cwd)
  if (basename(opts.binary) === 'claude') {
    // Claude Code signs in with a token made once by `gild vm login claude`.
    const token =
      process.env.CLAUDE_CODE_OAUTH_TOKEN ??
      (
        await readFile(claudeTokenPath(opts.configDir), 'utf8').catch(() => '')
      ).trim()
    if (!token)
      throw new Error(
        'Claude Code needs signing in for the VM. Run `gild vm login claude` once, then run this again',
      )
    put(`${HOME}/.config/gild/vm/claude.token`, token, '600')
    // A fresh Claude Code asks first-run questions and whether to trust the folder; nobody is there to answer.
    must(
      [
        'exec',
        MULTIPASS_VM,
        '--',
        'python3',
        '-c',
        `import json,os;p=os.path.expanduser('~/.claude.json')
try: c=json.load(open(p))
except Exception: c={}
c['hasCompletedOnboarding']=True
c.setdefault('projects',{}).setdefault(${JSON.stringify(ws)},{})['hasTrustDialogAccepted']=True
json.dump(c,open(p,'w'))`,
      ],
      'preparing Claude Code in the VM',
    )
  }
  if (opts.agent) {
    // The agent's own key and repo-scoped token: it pushes and opens pull requests from the VM.
    const file = join(opts.configDir, 'agents', `${opts.agent}.json`)
    put(
      `${HOME}/.config/gild/agents/${opts.agent}.json`,
      await readFile(file, 'utf8'),
      '600',
    )
    must(
      [
        'exec',
        MULTIPASS_VM,
        '--working-directory',
        ws,
        '--',
        'sh',
        '-c',
        `git rev-parse --git-dir >/dev/null 2>&1 || exit 0
for k in $(git config --name-only --get-regexp '^credential\\..*helper$' | sort -u); do git config --unset-all "$k"; done
o=$(git remote get-url origin 2>/dev/null | sed -E 's#^(https?://[^/]+).*#\\1#')
[ -n "$o" ] && git config --add "credential.$o.helper" "!gild credential --agent ${opts.agent}"; exit 0`,
      ],
      'wiring git in the VM',
    )
  }

  const env = {
    ...opts.env,
    HOME,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  }
  // The agent's terminal is made inside the VM by `script`; the host only
  // pipes bytes through `multipass exec` (a host pty helper never got as far
  // as running multipass from a detached session). Its pid is kept so the
  // session can be hung up from the host.
  const command = [
    `echo $$ > ${quote(dir + '/pid')}`,
    `stty cols ${opts.cols} rows ${opts.rows}`,
    `t=${quote(HOME + '/.config/gild/vm/claude.token')}; [ -f "$t" ] && export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$t")"`,
    `exec env ${Object.entries(env)
      .map(([k, v]) => quote(`${k}=${v}`))
      .join(' ')} ${[program, ...opts.args].map(quote).join(' ')}`,
  ].join('; ')
  const p = spawn(
    multipassPath(),
    [
      'exec',
      MULTIPASS_VM,
      '--working-directory',
      ws,
      '--',
      'script',
      '-qfec',
      command,
      '/dev/null',
    ],
    {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  // Return once the program runs in the VM: `gild spawn --detach` reports the
  // session ready only then, so the session that started it is still there
  // while Multipass connects (macOS Local Network privacy refuses it after).
  await started(p, `${dir}/pid`)
  const hangUp = () =>
    mp([
      'exec',
      MULTIPASS_VM,
      '--',
      'sh',
      '-c',
      `kill -HUP "$(cat ${quote(dir + '/pid')} 2>/dev/null)" 2>/dev/null; exit 0`,
    ])
  const none = { written: [], deleted: [], conflicts: [], rejected: [] }
  return {
    pid: p.pid ?? -1,
    write: (data) => void p.stdin.write(data),
    // The guest terminal keeps the size it started with.
    resize: () => {},
    onData: (cb) => {
      p.stdout.on('data', (d: Buffer) => cb(d))
      p.stderr.on('data', (d: Buffer) => {
        cb(d)
        if (noRoute(d.toString()))
          cb(Buffer.from(`\r\ngild: ${noRouteError().message}\r\n`))
      })
    },
    onExit: (cb) =>
      void p.on('exit', (code, signal) =>
        cb({ exitCode: code ?? 1, signal: signal ? 1 : undefined }),
      ),
    pause: () => {
      p.stdout.pause()
      p.stderr.pause()
    },
    resume: () => {
      p.stdout.resume()
      p.stderr.resume()
    },
    kill: () => {
      hangUp()
      p.kill()
    },
    // Work leaves the VM through git (the agent pushes); nothing is copied back.
    sync: async () => none,
    dispose: async () => {
      hangUp()
      p.kill()
      return none
    },
  }
}
