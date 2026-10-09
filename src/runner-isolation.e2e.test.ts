// End to end: a real executeJob against a fake forge, once per isolation level.
// Needs a prepared host, so it only runs when GILD_ISOLATION_E2E points at a
// directory holding isolation.json (see docs/ISOLATION.md).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { executeJob, type Assignment, type RunnerConfig } from './runner'

const hostDir = process.env.GILD_ISOLATION_E2E
const probeDir = process.env.GILD_ISOLATION_PROBES // writable dir outside the checkout
const lanAddr = process.env.GILD_ISOLATION_LAN_ADDR // host:port of a listener on the host LAN address

const sha = () =>
  spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).stdout.trim()
let repoDir = '',
  server: ReturnType<typeof Bun.serve>,
  root = ''
const calls: { path: string; body: any }[] = []

describe.skipIf(!hostDir)('runner isolation end to end', () => {
  beforeAll(() => {
    const base = mkdtempSync(join(process.env.TMPDIR ?? '.', 'e2e-'))
    root = join(base, 'config')
    mkdirSync(root, { recursive: true })
    if (existsSync(join(hostDir!, 'isolation.json')))
      writeFileSync(
        join(root, 'isolation.json'),
        readFileSync(join(hostDir!, 'isolation.json')),
      )
    repoDir = join(base, 'o', 'r.git')
    mkdirSync(repoDir, { recursive: true })
    const git = (...a: string[]) =>
      spawnSync('git', a, { cwd: repoDir, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'a@b.c')
    git('config', 'user.name', 'x')
    writeFileSync(join(repoDir, 'hello.txt'), 'hello from the repo\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith('.git') || url.pathname.includes('.git/')) {
          const env = {
            PATH: process.env.PATH!,
            GIT_PROJECT_ROOT: join(base),
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: url.pathname,
            REQUEST_METHOD: req.method,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: req.headers.get('content-type') ?? '',
            REMOTE_ADDR: '127.0.0.1',
          }
          const cgi = spawn('git', ['http-backend'], { env })
          if (req.body) cgi.stdin.end(Buffer.from(await req.arrayBuffer()))
          else cgi.stdin.end()
          const out: Buffer[] = []
          for await (const c of cgi.stdout) out.push(c)
          const raw = Buffer.concat(out),
            cut = raw.indexOf('\r\n\r\n')
          const headers = new Headers()
          let status = 200
          for (const l of raw.subarray(0, cut).toString().split('\r\n')) {
            const [k, ...v] = l.split(': ')
            if (k.toLowerCase() === 'status')
              status = Number(v.join(': ').split(' ')[0])
            else headers.set(k, v.join(': '))
          }
          return new Response(raw.subarray(cut + 4), { status, headers })
        }
        let body: any = null
        try {
          body = await req.json()
        } catch {}
        calls.push({ path: url.pathname, body })
        return Response.json(
          url.pathname.endsWith('heartbeat') ? { cancel: false } : { ok: true },
        )
      },
    })
  })
  test('fake forge serves the repo over http', async () => {
    const p = spawn('git', [
      'ls-remote',
      `http://127.0.0.1:${server.port}/o/r.git`,
    ])
    let err = ''
    for await (const c of p.stderr) err += c
    console.log(err)
    expect(err).toBe('')
  })
  afterAll(() => server?.stop(true))

  const cfg = (): RunnerConfig => ({
    schema: 1,
    id: 'r1',
    token: 'gr_abc',
    name: 'e2e',
    repo: 'o/r',
    scope: 'repo',
    server: `http://127.0.0.1:${server.port}`,
    os: 'linux',
    arch: 'x64',
    labels: [],
  })

  async function job(
    level: string,
    steps: { name: string; run: string; env?: Record<string, string> }[],
  ) {
    calls.length = 0
    const a: Assignment = {
      schema: 1,
      workspaceToken: '@@WS@@',
      github: {},
      job: 1,
      run: 1,
      lease: 'l' + level + Date.now(),
      sha: sha(),
      ref: 'refs/heads/main',
      repository: 'o/r',
      timeout: 120_000,
      steps: steps.map((s) => ({
        name: s.name,
        run: s.run,
        shell: 'bash',
        directory: '@@WS@@',
        env: s.env ?? {},
        with: {},
        continueOnError: true,
        timeout: 60_000,
        when: { success: true, failure: true, cancelled: false },
      })),
    }
    const status = await executeJob(
      cfg(),
      a,
      root,
      new AbortController().signal,
      level,
    )
    const results = calls
      .filter(
        (c) => c.path.endsWith('runners/step') && c.body.status !== 'running',
      )
      .map((c) => c.body.status as string)
    const logs = calls
      .filter((c) => c.path.endsWith('runners/logs'))
      .flatMap((c) => c.body.lines as string[])
    return { status, results, logs }
  }

  // A TCP connect that works on every host, so the `none` control is a real
  // control: macOS has no coreutils `timeout` and its bash 3.2 hangs on /dev/tcp.
  const connect = (hostPort: string, seconds: number) =>
    `if command -v curl >/dev/null; then curl -s -o /dev/null -m ${seconds} http://${hostPort}/; ` +
    `else timeout ${seconds} bash -c 'exec 3<>/dev/tcp/${hostPort.replace(':', '/')}'; fi`
  const probes = [
    { name: 'checkout is present', run: 'test -f hello.txt && echo $PWD' },
    { name: 'write inside checkout', run: 'echo x > new.txt && cat new.txt' },
    {
      name: 'write outside checkout',
      run: `echo x > ${probeDir}/outside-${'$$'}.txt`,
    },
    {
      name: 'read host home',
      run: `cat ${probeDir}/../host-secret-marker.txt`,
    },
    {
      name: 'reach LAN',
      run: connect(lanAddr ?? '', 4),
    },
    {
      name: 'reach metadata address',
      run: connect('169.254.169.254:80', 3),
    },
    {
      name: 'secret via env',
      run: 'echo "len=${#TOKEN}"; ! grep -q "$TOKEN" /proc/cmdline',
      env: { TOKEN: 'sekret-9f3a1c-e2e' },
    },
  ]

  // GILD_ISOLATION_LEVELS=container on a Mac with Colima (no Firecracker there).
  for (const level of (
    process.env.GILD_ISOLATION_LEVELS ?? 'none,container,vm'
  ).split(',')) {
    test(`isolation ${level}`, async () => {
      const r = await job(level, probes)
      console.log(
        `LEVEL ${level}: ${probes.map((p, i) => `${p.name}=${r.results[i]}`).join(' | ')}`,
      )
      console.log(r.logs.filter((l) => l.startsWith('[gild: ')).join('\n'))
      console.log(
        JSON.stringify(calls.find((c) => c.path.endsWith('finish'))?.body),
      )
      expect(r.status).toBe('success')
      expect(r.results[0]).toBe('success')
      expect(r.results[1]).toBe('success')
      expect(r.results[6]).toBe('success')
      if (level !== 'none') {
        expect(r.results[2]).toBe('failure')
        expect(r.results[3]).toBe('failure')
        expect(r.results[4]).toBe('failure')
        expect(r.results[5]).toBe('failure')
      } else {
        expect(r.results[2]).toBe('success')
        expect(r.results[3]).toBe('success')
      }
      expect(r.logs.join('\n')).not.toContain('sekret-9f3a1c-e2e')
    }, 180_000)
  }
})
