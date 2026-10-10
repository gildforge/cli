import { expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fixture } from './test-cli'
import { pullFixture, reviewFixture, mergeFixture } from './forge-test'

// A real smart-HTTP Git server behind a fake forge. Both clone and push require
// Basic auth, invoking gild's helper; API writes require the agent bearer token.
test('agent clone → author → push → PR → review → queued merge, with no token in output/config', async () => {
  let gitRoot = '',
    seed = '',
    head = '',
    created = false,
    reviewed = false,
    merged = false
  const gitAuth: string[] = [],
    apiAuth: string[] = []
  const f = await fixture(async (request) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/owner/demo.git/')) {
      const auth = request.headers.get('authorization') ?? ''
      const decoded = auth.startsWith('Basic ')
        ? Buffer.from(auth.slice(6), 'base64').toString()
        : ''
      const token = decoded.slice(decoded.indexOf(':') + 1)
      if (!['gf_agentfixture', 'gf_fixturetoken'].includes(token))
        return new Response('Authentication required', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="gild"' },
        })
      gitAuth.push(token)
      const data = new Uint8Array(await request.arrayBuffer())
      const proc = Bun.spawn(['git', 'http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: gitRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get('content-type') ?? '',
          CONTENT_LENGTH: String(data.length),
          REMOTE_USER: 'gild',
          SERVER_PROTOCOL: 'HTTP/1.1',
        },
        stdin: new Blob([data]),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [bytes, code, err] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        proc.exited,
        new Response(proc.stderr).text(),
      ])
      if (code !== 0) throw Error(err)
      const raw = Buffer.from(bytes),
        split = raw.indexOf('\r\n\r\n')
      const headers = new Headers()
      let status = 200
      for (const line of raw.subarray(0, split).toString().split('\r\n')) {
        const i = line.indexOf(':')
        if (i < 0) continue
        if (line.slice(0, i).toLowerCase() === 'status')
          status = Number(
            line
              .slice(i + 1)
              .trim()
              .split(' ')[0],
          )
        else headers.append(line.slice(0, i), line.slice(i + 1).trim())
      }
      return new Response(raw.subarray(split + 4), { status, headers })
    }
    const token = request.headers.get('authorization') ?? ''
    apiAuth.push(token)
    if (token !== 'Bearer gf_agentfixture')
      return Response.json(
        { message: 'Agent identity required' },
        { status: 403 },
      )
    const pull = { ...pullFixture, head: { ...pullFixture.head, sha: head } }
    if (url.pathname.endsWith('/pulls') && request.method === 'POST') {
      const body = await request.json()
      expect(body).toEqual({
        head: 'work',
        base: 'main',
        title: 'Agent work',
        body: 'Demo',
      })
      head = git(
        ['rev-parse', 'refs/heads/work'],
        join(gitRoot, 'owner/demo.git'),
      ).trim()
      created = true
      return Response.json(
        { ...pull, head: { ...pull.head, sha: head } },
        { status: 201 },
      )
    }
    if (url.pathname.endsWith('/pulls/12') && created)
      return Response.json(pull)
    if (url.pathname.endsWith('/reviews') && created) {
      expect(await request.json()).toEqual({
        event: 'APPROVE',
        body: 'Verified',
      })
      reviewed = true
      return Response.json(
        { ...reviewFixture, commit_id: head },
        { status: 201 },
      )
    }
    if (url.pathname.endsWith('/merge') && reviewed) {
      expect(await request.json()).toEqual({ sha: head, merge_method: 'merge' })
      // The fake queue drains by merging the actual pushed work branch.
      git(['fetch', 'origin', 'work'], seed)
      git(['merge', '--no-ff', 'FETCH_HEAD', '-m', 'Merge agent work'], seed)
      git(['push', 'origin', 'main'], seed)
      merged = true
      return Response.json(mergeFixture, { status: 202 })
    }
    return Response.json(
      { message: 'Invalid workflow transition' },
      { status: 409 },
    )
  })
  const home = join(f.root, 'home')
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  }
  function git(args: string[], cwd?: string) {
    const run = Bun.spawnSync(['git', ...args], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (run.exitCode !== 0) throw Error(run.stderr.toString())
    expect(run.stdout.toString() + run.stderr.toString()).not.toContain('gf_')
    return run.stdout.toString()
  }
  async function gild(args: string[]) {
    const command = process.env.TEST_GILD_COMMAND
      ? (JSON.parse(process.env.TEST_GILD_COMMAND) as string[])
      : [process.execPath, 'run', resolve('src/gild.ts')]
    const proc = Bun.spawn([...command, '--config-dir', f.root, ...args], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill('SIGTERM'), 15000)
    try {
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(out + err).not.toContain('gf_')
      expect({ code, err: code === 0 ? '' : err }).toEqual({ code: 0, err: '' })
      return out
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await mkdir(home)
    gitRoot = join(f.root, 'server')
    seed = join(f.root, 'seed')
    await mkdir(join(gitRoot, 'owner'), { recursive: true })
    const bare = join(gitRoot, 'owner/demo.git')
    git(['init', '--bare', '--initial-branch=main', bare])
    git(['config', 'http.receivepack', 'true'], bare)
    git(['init', '--initial-branch=main', seed])
    git(['config', 'user.name', 'Fixture human'], seed)
    git(['config', 'user.email', 'human@example.invalid'], seed)
    git(['config', 'commit.gpgsign', 'false'], seed)
    await writeFile(join(seed, 'README.md'), 'seed\n')
    git(['add', '.'], seed)
    git(['commit', '-m', 'Initial'], seed)
    git(['remote', 'add', 'origin', bare], seed)
    git(['push', '-u', 'origin', 'main'], seed)
    await f.identity()
    await f.agent()
    // A global credential-store helper must never receive the agent credential.
    git([
      'config',
      '--global',
      'credential.helper',
      `store --file=${join(home, 'leaked')}`,
    ])
    const clone = join(f.root, 'agent-clone')
    await gild(['clone', 'owner/demo', clone, '--agent', 'test'])
    const config = await readFile(join(clone, '.git/config'), 'utf8')
    expect(config).not.toContain('gf_')
    expect(config).not.toContain('Authorization')
    expect(git(['remote', 'get-url', 'origin'], clone).trim()).toBe(
      `${f.origin}/owner/demo.git`,
    )
    expect(git(['config', 'user.name'], clone).trim()).toBe('alice/test')
    expect(git(['config', 'user.email'], clone).trim()).toBe(
      'test+alice@agents.gild.gg',
    )
    git(['config', 'commit.gpgsign', 'false'], clone)
    git(['switch', '-c', 'work'], clone)
    await writeFile(join(clone, 'work.txt'), 'real agent work\n')
    git(['add', '.'], clone)
    git(['commit', '-m', 'Agent work'], clone)
    expect(git(['log', '-1', '--format=%an <%ae>'], clone).trim()).toBe(
      'alice/test <test+alice@agents.gild.gg>',
    )
    // Async subprocess lets the HTTP server service push in this test process.
    const push = Bun.spawn(['git', 'push', '-u', 'origin', 'work'], {
      cwd: clone,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([
      push.exited,
      new Response(push.stdout).text(),
      new Response(push.stderr).text(),
    ])
    expect(out + err).not.toContain('gf_')
    expect(code).toBe(0)
    expect(git(['show', 'work:work.txt'], bare)).toBe('real agent work\n')
    await gild([
      'pr',
      'create',
      'owner/demo',
      '--head',
      'work',
      '--title',
      'Agent work',
      '-b',
      'Demo',
      '--agent',
      'test',
    ])
    await gild([
      'pr',
      'review',
      'owner/demo#12',
      '--approve',
      '-b',
      'Verified',
      '--agent',
      'test',
    ])
    await gild(['pr', 'merge', 'owner/demo#12', '--agent', 'test'])
    expect(merged).toBe(true)
    expect(git(['show', 'main:work.txt'], bare)).toBe('real agent work\n')
    expect(gitAuth.length).toBeGreaterThanOrEqual(4)
    expect(gitAuth.every((t) => t === 'gf_agentfixture')).toBe(true)
    expect(apiAuth.length).toBe(4)
    expect(apiAuth.every((t) => t === 'Bearer gf_agentfixture')).toBe(true)
    expect(await Bun.file(join(home, 'leaked')).exists()).toBe(false)
    // Human clone uses the same helper mechanism and preserves author defaults.
    const humanClone = join(f.root, 'human-clone')
    await gild([
      'repo',
      'clone',
      'owner/demo',
      humanClone,
      '--server',
      f.origin,
    ])
    expect(gitAuth.at(-1)).toBe('gf_fixturetoken')
    const humanConfig = await readFile(join(humanClone, '.git/config'), 'utf8')
    expect(humanConfig).not.toContain('gf_')
    expect(humanConfig).not.toContain('[user]')
  } finally {
    await f.close()
  }
}, 60000)
