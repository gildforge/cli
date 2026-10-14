// `gild spawn --vm` on macOS and Windows: the agent runs in a Multipass VM
// (Ubuntu), driven only through the `multipass` command and its JSON output.
//
// One VM, `gild`, is made on first use and kept. Each session copies the
// working directory in (no mounts), plus the agent's own gild key and its
// repo-scoped token, so the agent clones, pushes and opens pull requests from
// inside the VM. Your own gild key never enters it. Work leaves the VM through
// git; the session's copy stays in the VM until you remove it.
import { spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { VmChild } from '../spawn-vm'

export const MULTIPASS_VM = 'gild'
const HOME = '/home/ubuntu'

export const usesMultipass = (platform: NodeJS.Platform = process.platform) =>
  platform === 'darwin' || platform === 'win32'

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
sudo npm install -g --silent @anthropic-ai/claude-code gildforge
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

function mp(args: string[], input?: string) {
  const r = spawnSync('multipass', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 << 20,
  })
  if (r.error) throw r.error
  return r
}

function must(args: string[], what: string, input?: string) {
  const r = mp(args, input)
  if (r.status !== 0)
    throw new Error(
      `${what}: ${(r.stderr || r.stdout).trim() || `multipass exited ${r.status}`}`,
    )
  return r.stdout
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
export async function ensureVm(log: (line: string) => void = () => {}) {
  const missing = multipassMissing()
  if (missing) throw new Error(missing)
  const info = mp(['info', MULTIPASS_VM, '--format', 'json'])
  if (info.status !== 0) {
    log('making the gild VM (once, about two minutes)')
    must(
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
      'making the gild VM',
    )
  } else {
    const state = JSON.parse(info.stdout).info?.[MULTIPASS_VM]?.state
    if (state !== 'Running') {
      log('starting the gild VM')
      must(['start', MULTIPASS_VM], 'starting the gild VM')
    }
  }
  if (mp(['exec', MULTIPASS_VM, '--', 'test', '-f', READY]).status !== 0) {
    log('installing Node, git, Claude Code and gild in the gild VM (once)')
    must(
      ['exec', MULTIPASS_VM, '--', 'sh', '-c', SETUP],
      'setting up the gild VM',
    )
  }
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
  must(
    ['transfer', '--recursive', opts.cwd, `${MULTIPASS_VM}:${ws}`],
    'copying the working directory into the VM',
  )

  const program = basename(opts.binary)
  if (program === 'claude') {
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
      p.stderr.on('data', (d: Buffer) => cb(d))
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
