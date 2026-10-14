// `gild spawn --vm` on macOS and Windows: the agent runs in a Multipass VM
// (Ubuntu), driven only through the `multipass` command and its JSON output.
//
// One VM, `gild`, is made on first use and kept. Each session copies the
// working directory in (no mounts), plus the agent's own gild key and its
// repo-scoped token, so the agent clones, pushes and opens pull requests from
// inside the VM. Your own gild key never enters it. Work leaves the VM through
// git; the session's copy stays in the VM until you remove it.
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { IPty } from 'node-pty'
import type { VmChild } from '../spawn-vm'

export const MULTIPASS_VM = 'gild'
const HOME = '/home/ubuntu'

export const usesMultipass = (platform: NodeJS.Platform = process.platform) =>
  platform === 'darwin' || platform === 'win32'

/** Where `gild vm login claude` keeps the Claude Code token (0600, this machine only). */
export const claudeTokenPath = (configDir: string) =>
  join(configDir, 'vm', 'claude.token')

// One-time setup of the VM: what an agent needs to work from inside it.
const CLOUD_INIT = `#cloud-config
package_update: true
packages: [git, nodejs, npm, python3, build-essential, ca-certificates]
runcmd:
  - npm install -g @anthropic-ai/claude-code gildforge
`

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
    log(
      'making the gild VM (once; a few minutes while it installs Node, git, Claude Code and gild)',
    )
    const dir = join(homedir(), '.gild')
    const file = join(dir, 'multipass-cloud-init.yaml')
    await import('node:fs/promises').then((fs) =>
      fs
        .mkdir(dir, { recursive: true, mode: 0o700 })
        .then(() => fs.writeFile(file, CLOUD_INIT, { mode: 0o600 })),
    )
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
        '--cloud-init',
        file,
        '--timeout',
        '1200',
      ],
      'making the gild VM',
    )
    must(
      ['exec', MULTIPASS_VM, '--', 'cloud-init', 'status', '--wait'],
      'setting up the gild VM',
    )
    return
  }
  const state = JSON.parse(info.stdout).info?.[MULTIPASS_VM]?.state
  if (state !== 'Running') {
    log('starting the gild VM')
    must(['start', MULTIPASS_VM], 'starting the gild VM')
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
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${v}`)
  // Its pid is kept so the session can be hung up from the host.
  const launch = `echo $$ > ${quote(dir + '/pid')}; t=${quote(HOME + '/.config/gild/vm/claude.token')}; [ -f "$t" ] && export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$t")"; exec env "$@"`
  const p: IPty = opts.pty.spawn(
    'multipass',
    [
      'exec',
      MULTIPASS_VM,
      '--working-directory',
      ws,
      '--',
      'sh',
      '-c',
      launch,
      'sh',
      ...assignments,
      program,
      ...opts.args,
    ],
    {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: process.env as Record<string, string>,
      encoding: null,
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
    pid: p.pid,
    write: (data) =>
      p.write(
        typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
      ),
    resize: (cols, rows) => p.resize(cols, rows),
    onData: (cb) =>
      void p.onData((d) => cb(Buffer.isBuffer(d) ? d : Buffer.from(d))),
    onExit: (cb) =>
      void p.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal })),
    pause: () => p.pause(),
    resume: () => p.resume(),
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
