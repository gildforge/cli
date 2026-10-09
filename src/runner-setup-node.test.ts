import { test, expect } from 'bun:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join, delimiter } from 'node:path'
import { saveRunner, type Assignment } from './runner'

// Real compiled CLI, Git HTTP checkout, upstream setup-node, network manifest /
// archive downloads and the next shell step. No substituted Node or action.
test.each(['latest', '24', '22'])(
  'runner executes upstream actions/setup-node@v6 for %s and carries PATH to the next step',
  async (version) => {
    await mkdir('.tmp', { recursive: true })
    const root = await mkdtemp(resolve('.tmp/setup-node-')),
      home = join(root, 'home'),
      repo = join(root, 'acme/demo.git'),
      bin = join(root, 'bin')
    await Promise.all([
      mkdir(home),
      mkdir(repo, { recursive: true }),
      mkdir(bin),
    ])
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], {
        cwd: repo,
        stdout: 'pipe',
        stderr: 'pipe',
        // CI machines have no git identity; the fixture brings its own.
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Setup Node fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.test',
          GIT_COMMITTER_NAME: 'Setup Node fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.test',
        },
      })
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      return r.stdout.toString().trim()
    }
    git('init', '-b', 'main')
    await writeFile(join(repo, 'README.md'), 'setup-node fixture\n')
    git('add', '.')
    git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Fixture',
      '--author=Gild fixture <fixture@example.test>',
    )
    const sha = git('rev-parse', 'HEAD')
    const build = Bun.spawnSync(
      [
        'bun',
        'build',
        '--compile',
        resolve('src/gild.ts'),
        '--outfile',
        join(bin, 'gild'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(build.exitCode, build.stderr.toString()).toBe(0)
    const logs: string[] = [],
      steps: { step: number; status: string; exit: number }[] = []
    let finished: { status: string; reason: string } | undefined,
      assigned = false
    const job: Assignment = {
      schema: 1,
      workspaceToken: '__WORKSPACE__',
      github: {},
      job: 1,
      run: 1,
      lease: 'fixture-lease',
      sha,
      ref: 'refs/heads/main',
      repository: 'acme/demo',
      timeout: 180000,
      steps: [
        {
          name: 'Setup Node',
          uses: 'actions/setup-node@v6',
          shell: 'bash',
          directory: '.',
          env: {},
          with: { 'node-version': version },
          continueOnError: false,
          timeout: 150000,
          when: { success: true, failure: false, cancelled: false },
        },
        {
          name: 'Use downloaded Node',
          run: `node -e 'const fs=require("fs"),path=require("path");const e=process.env;const actual={version:process.version,arch:process.arch,platform:process.platform,os:e.RUNNER_OS,runnerArch:e.RUNNER_ARCH,exec:process.execPath,cache:e.RUNNER_TOOL_CACHE,temp:e.RUNNER_TEMP,home:e.HOME,cacheComplete:fs.existsSync(path.join(e.RUNNER_TOOL_CACHE,"node",process.version.slice(1),process.arch+".complete")),tempExists:fs.statSync(e.RUNNER_TEMP).isDirectory()};console.log("NODE_PROOF="+JSON.stringify(actual))'\nnpm --version`,
          shell: 'bash',
          directory: '.',
          env: {},
          with: {},
          continueOnError: false,
          timeout: 30000,
          when: { success: true, failure: false, cancelled: false },
        },
      ],
    }
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/acme/demo.git')) {
          const child = Bun.spawn(['git', 'http-backend'], {
            env: {
              ...process.env,
              GIT_PROJECT_ROOT: root,
              GIT_HTTP_EXPORT_ALL: '1',
              PATH_INFO: url.pathname,
              QUERY_STRING: url.search.slice(1),
              REQUEST_METHOD: req.method,
              CONTENT_TYPE: req.headers.get('content-type') ?? '',
            },
            stdin: new Uint8Array(await req.arrayBuffer()),
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const response = Buffer.from(
              await new Response(child.stdout).arrayBuffer(),
            ),
            at = response.indexOf('\r\n\r\n')
          expect(await child.exited).toBe(0)
          const headers = new Headers()
          for (const line of response
            .subarray(0, at)
            .toString()
            .split('\r\n')) {
            const colon = line.indexOf(':')
            if (colon > 0)
              headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
          }
          return new Response(response.subarray(at + 4), { headers })
        }
        const body = (await req.json()) as any
        if (url.pathname.endsWith('/poll')) {
          const next = assigned ? null : { ...job, spec: { id: 'test' } }
          assigned = true
          return Response.json({ job: next })
        }
        if (url.pathname.endsWith('/logs')) logs.push(...body.lines)
        if (url.pathname.endsWith('/step')) steps.push(body)
        if (url.pathname.endsWith('/finish')) finished = body
        return Response.json({ ok: true, cancel: false })
      },
    })
    const config = join(home, '.config/gild')
    try {
      await saveRunner(config, {
        schema: 1,
        id: 'fixture',
        token: 'gr_fixture',
        name: 'setup-node',
        repo: 'acme/demo',
        server: server.url.origin,
        os: process.platform,
        arch: process.arch,
        labels: [],
      })
      const child = Bun.spawn(
        [
          'gild',
          'runner',
          'start',
          '--once',
          '--isolation',
          'none',
          '--allow-root',
          '--name',
          'setup-node',
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            TMPDIR: join(root, 'tmp'),
            PATH: bin + delimiter + process.env.PATH,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const timer = setTimeout(() => child.kill('SIGTERM'), 190000)
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      clearTimeout(timer)
      await writeFile(
        resolve(`.tmp/setup-node-${version}.log`),
        [stdout, stderr, ...logs].join('\n'),
      )
      expect(exit, stderr).toBe(0)
      expect(finished?.status, logs.join('\n')).toBe('success')
      expect(
        steps.filter((s) => s.status === 'success').map((s) => s.step),
      ).toEqual([0, 1])
      const proof = JSON.parse(
        logs
          .find((line) => line.startsWith('NODE_PROOF='))!
          .slice('NODE_PROOF='.length),
      )
      if (version !== 'latest')
        expect(proof.version).toMatch(new RegExp(`^v${version}\\.`))
      else {
        const index = (await (
          await fetch('https://nodejs.org/dist/index.json')
        ).json()) as { version: string; files: string[] }[]
        const file =
          process.platform === 'darwin'
            ? `osx-${process.arch}-tar`
            : `${process.platform}-${process.arch}`
        expect(proof.version).toBe(
          index.find((v) => v.files.includes(file))!.version,
        )
      }
      expect(proof.platform).toBe(process.platform)
      expect(proof.arch).toBe(process.arch)
      expect(proof.runnerArch).toBe(process.arch.toUpperCase())
      expect(proof.os).toBe(process.platform === 'darwin' ? 'macOS' : 'Linux')
      expect(proof.exec.startsWith(proof.cache)).toBe(true)
      expect(proof.cacheComplete).toBe(true)
      expect(proof.tempExists).toBe(true)
      expect(proof.home.startsWith(home)).toBe(true)
      expect(logs.join('\n')).toContain('Attempting to download')
      console.log(
        `${process.platform}-${process.arch} ${version}: ${proof.version}, upstream download, cache marker, npm and subsequent PATH passed`,
      )
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  210000,
)
