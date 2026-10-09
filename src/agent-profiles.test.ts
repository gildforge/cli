import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  symlink,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { profileArguments } from './spawn-adapters'
import { fixture } from './test-cli'

const command = () =>
  process.env.TEST_GILD_COMMAND
    ? (JSON.parse(process.env.TEST_GILD_COMMAND) as string[])
    : [process.execPath, 'run', resolve('src/gild.ts')]
async function run(
  home: string,
  args: string[],
  config = join(home, 'credentials'),
  env = {},
) {
  const proc = Bun.spawn([...command(), '--config-dir', config, ...args], {
    env: { ...process.env, HOME: home, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill('SIGTERM'), 10000)
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, out, err }
  } finally {
    clearTimeout(timer)
  }
}
async function home() {
  await mkdir('.tmp', { recursive: true })
  return mkdtemp(resolve('.tmp/ap-'))
}

test('profile CRUD writes machine-local settings and keeps existing approved credentials separate', async () => {
  const h = await home(),
    f = await fixture(() => new Response('{}'))
  try {
    await f.agent()
    const credential = await readFile(join(f.root, 'agents/test.json'), 'utf8')
    const add = [
      'agent',
      'add',
      'test',
      '--runtime',
      'claude',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'high',
      '--dir',
      '.',
      '--arg=--resume',
      '--arg',
      'a b',
      '--env',
      'PATH',
      '--channel',
      'owner/repo',
    ]
    expect(await run(h, add, f.root)).toEqual({ code: 0, out: '', err: '' })
    const path = join(h, '.gild/agents/test.json')
    const initial = JSON.parse(await readFile(path, 'utf8'))
    expect(initial).toEqual({
      name: 'test',
      runtime: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
      directory: process.cwd(),
      args: ['--resume', 'a b'],
      env: ['PATH'],
      channels: ['owner/repo'],
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(h, '.gild/agents'))).mode & 0o777).toBe(0o700)
    expect((await run(h, add, f.root)).code).toBe(1)
    expect(
      await run(
        h,
        [
          'agent',
          'edit',
          'test',
          '--model',
          'opus',
          '--effort',
          '',
          '--clear-args',
          '--clear-env',
          '--clear-channels',
        ],
        f.root,
      ),
    ).toEqual({ code: 0, out: '', err: '' })
    const updated = {
      name: 'test',
      runtime: 'claude',
      model: 'opus',
      directory: process.cwd(),
      args: [],
    }
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(updated)
    const listed = await run(h, ['agent', 'ls', '--json'], f.root)
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.out)).toEqual([updated])
    expect((await run(h, ['agent', 'list'], f.root)).out).toContain(
      '@alice/test',
    )
    expect(await run(h, ['agent', 'rm', 'test'], f.root)).toEqual({
      code: 0,
      out: '',
      err: '',
    })
    expect((await run(h, ['agent', 'ls', '--json'], f.root)).out.trim()).toBe(
      '[]',
    )
    expect(await readFile(join(f.root, 'agents/test.json'), 'utf8')).toBe(
      credential,
    )
    expect(
      (await run(h, ['agent', 'edit', 'test', '--model', 'opus'], f.root)).code,
    ).toBe(1)
  } finally {
    await rm(h, { recursive: true, force: true })
    await f.close()
  }
})

test('profile files reject tokens and secret fields without writing or echoing credentials', async () => {
  const h = await home()
  try {
    const valid = {
      name: 'ava',
      runtime: 'claude',
      directory: process.cwd(),
      args: [],
    }
    const file = join(h, 'input.json'),
      secret = 'fixture-secret-never-profile'
    for (const field of ['token', 'secretKey', 'apiToken', 'env']) {
      await writeFile(
        file,
        JSON.stringify({
          ...valid,
          [field]: field === 'env' ? { KEY: secret } : secret,
        }),
      )
      const rejected = await run(h, ['agent', 'add', 'ava', '--file', file])
      expect(rejected.code).toBe(1)
      expect(rejected.err).not.toContain(secret)
      expect((await run(h, ['agent', 'ls', '--json'])).out.trim()).toBe('[]')
    }
    await writeFile(file, JSON.stringify(valid))
    expect((await run(h, ['agent', 'add', 'ava', '--file', file])).code).toBe(0)
    const before = await readFile(join(h, '.gild/agents/ava.json'), 'utf8')
    await writeFile(file, JSON.stringify({ ...valid, token: secret }))
    expect((await run(h, ['agent', 'edit', 'ava', '--file', file])).code).toBe(
      1,
    )
    expect(await readFile(join(h, '.gild/agents/ava.json'), 'utf8')).toBe(
      before,
    )
    expect(before).not.toContain(secret)
    const outside = join(h, 'outside.json')
    await writeFile(outside, JSON.stringify(valid))
    await symlink(outside, join(h, '.gild/agents/link.json'))
    expect((await run(h, ['spawn', 'agent', 'link'])).code).toBe(1)
    expect(
      (
        await run(h, [
          'agent',
          'add',
          '../escape',
          '--runtime',
          'claude',
          '--dir',
          '.',
        ])
      ).code,
    ).toBe(1)
  } finally {
    await rm(h, { recursive: true, force: true })
  }
})

for (const [runtime, settings, expected] of [
  [
    'claude',
    { model: 'claude-opus-5-5', effort: 'high' },
    ['--model', 'claude-opus-5-5', '--effort', 'high'],
  ],
  ['/native/claude', { effort: 'max' }, ['--effort', 'max']],
  [
    'codex',
    { model: 'gpt-6.1', effort: 'high' },
    ['-m', 'gpt-6.1', '-c', 'model_reasoning_effort="high"'],
  ],
  ['codex', { effort: 'x"\\y' }, ['-c', 'model_reasoning_effort="x\\"\\\\y"']],
  ['kimi', { model: 'kimi-model' }, ['--model', 'kimi-model']],
  ['custom', { model: 'ignored', effort: 'ignored' }, []],
  ['claude', {}, []],
  ['codex', {}, []],
  ['kimi', {}, []],
] as const) {
  test(`profile runtime flags: ${runtime} ${JSON.stringify(settings)}`, () => {
    expect(profileArguments(runtime, settings)).toEqual([...expected])
  })
}
test('profile runtime flags reject unsupported effort instead of inventing flags', () => {
  expect(() => profileArguments('kimi', { effort: 'high' })).toThrow(
    'no effort flag',
  )
  expect(() => profileArguments('claude', { effort: 'ultra' })).toThrow(
    'Claude effort',
  )
})

test('profile piped spawn resolves cwd, relative commands, verbatim args and environment allowlist', async () => {
  const h = await home()
  try {
    const dir = join(h, 'working')
    await mkdir(dir)
    await writeFile(
      join(dir, 'native'),
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),keep:process.env.KEEP_TEST,drop:process.env.KEEP_DROP,baseline:Object.fromEntries(["PATH","HOME","TERM","LANG","USER","SHELL","TMPDIR"].map(k=>[k,process.env[k]]))}))\n',
      { mode: 0o755 },
    )
    expect(
      (
        await run(h, [
          'agent',
          'add',
          'ava',
          '--runtime',
          './native',
          '--model',
          'ignored',
          '--effort',
          'ignored',
          '--dir',
          dir,
          '--arg=--native',
          '--arg',
          'a b',
          '--env',
          'KEEP_TEST',
        ])
      ).code,
    ).toBe(0)
    const result = await run(
      h,
      ['spawn', 'agent', 'ava', '--resume', '--', '--as', 'literal'],
      undefined,
      {
        KEEP_TEST: 'kept',
        KEEP_DROP: 'hidden',
        TERM: 'native-test-term',
        LANG: 'test-lang',
        USER: 'test-user',
        SHELL: '/fixture/shell',
        TMPDIR: h,
      },
    )
    expect(result.code).toBe(0)
    expect(result.err).toBe('')
    expect(JSON.parse(result.out)).toEqual({
      cwd: dir,
      args: ['--native', 'a b', '--resume', '--', '--as', 'literal'],
      keep: 'kept',
      baseline: {
        PATH: process.env.PATH,
        HOME: h,
        TERM: 'native-test-term',
        LANG: 'test-lang',
        USER: 'test-user',
        SHELL: '/fixture/shell',
        TMPDIR: h,
      },
    })
    expect(
      (await run(h, ['spawn', '--as', 'other', 'agent', 'ava'])).code,
    ).toBe(1)
    await rm(dir, { recursive: true })
    const missing = await run(h, ['spawn', 'agent', 'ava'])
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('directory does not exist')
  } finally {
    await rm(h, { recursive: true, force: true })
  }
})

for (const scenario of [
  'profile',
  'profile-names',
  'profile-local',
  'profile-stale',
]) {
  test(`profile PTY: ${scenario}`, async () => {
    const script = 'events-harness.py'
    const proc = Bun.spawn(
      ['python3', resolve('scripts/fixtures/' + script), '--' + scenario],
      {
        env: { ...process.env, TEST_GILD_COMMAND: JSON.stringify(command()) },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const timer = setTimeout(() => proc.kill('SIGTERM'), 20000)
    try {
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect({ code, err }).toEqual({ code: 0, err: '' })
      expect(JSON.parse(out).passed).toBe(true)
    } finally {
      clearTimeout(timer)
    }
  }, 25000)
}
