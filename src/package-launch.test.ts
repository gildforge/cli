import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { installPackage } from './agent-packages'
import { resolvePackageLaunch, preparePackageLaunch } from './package-launch'
import { PACKAGE_OBJECTS } from './package-git-proof'
import { deflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { symlink } from 'node:fs/promises'

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Package fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Package fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim()
async function fixture() {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(
      join(process.env.TEST_GILD_FIXTURE_TMP ?? resolve('.tmp'), 'p-'),
    ),
    source = join(root, 'source'),
    skill = join(root, 'skill'),
    config = join(root, 'config'),
    consumer = join(config, 'demo'),
    work = join(root, 'work'),
    bin = join(root, 'bin')
  for (const p of [source, skill, config, consumer, work, bin])
    await mkdir(p, { recursive: true, mode: 0o700 })
  const skillBytes = Buffer.from(
      '---\nname: owned-verification\ndescription: Safe owned fixture\n---\nExact nested skill bytes\r\n',
    ),
    license = Buffer.from('Owned fixture LICENSE\r\n'),
    instructions = Buffer.from('Exact package instructions\r\n')
  await writeFile(
    join(skill, 'gild.json'),
    JSON.stringify({
      version: 1,
      name: 'check',
      files: ['LICENSE', 'SKILL.md'],
      agents: {},
      dependencies: {},
    }),
  )
  await writeFile(join(skill, 'SKILL.md'), skillBytes)
  await writeFile(join(skill, 'LICENSE'), license)
  git(skill, ['init', '--quiet'])
  git(skill, ['add', '.'])
  git(skill, ['commit', '--quiet', '-m', 'Owned skill'])
  await writeFile(
    join(source, 'gild.json'),
    JSON.stringify({
      version: 1,
      name: 'personal',
      files: ['instruction.md'],
      agents: {
        member: {
          runtime: 'codex',
          model: 'fixture-model',
          effort: 'low',
          args: ['--version'],
          instructions: 'instruction.md',
          skills: ['check'],
          requestedPermissions: ['write:requested-only'],
        },
      },
      dependencies: {
        check: {
          kind: 'skills',
          repository: 'https://fixture.invalid/owned/check.git',
          ref: 'latest',
        },
      },
    }),
  )
  await writeFile(join(source, 'instruction.md'), instructions)
  git(source, ['init', '--quiet'])
  const options = {
    transportRepository: (url: string) =>
      url.includes('check.git') ? skill : source,
  }
  await installPackage(source, false, options)
  git(source, ['add', 'gild.json', 'gild.lock', 'instruction.md', '.gitignore'])
  git(source, ['commit', '--quiet', '-m', 'Owned agent with pinned skill'])
  await writeFile(
    join(consumer, 'gild.json'),
    JSON.stringify({
      version: 1,
      name: 'demo',
      files: [],
      agents: { selected: { dependency: 'personal', member: 'member' } },
      dependencies: {
        personal: {
          kind: 'agents',
          repository: 'https://fixture.invalid/owned/personal.git',
          ref: 'latest',
        },
      },
    }),
  )
  const lock = await installPackage(consumer, false, options)
  return {
    root,
    source,
    skill,
    config,
    consumer,
    work,
    bin,
    options,
    lock,
    skillBytes,
    license,
    instructions,
  }
}

test('production package HOST caller stages pinned nested bytes and instructions, independently of identity', async () => {
  const f = await fixture()
  try {
    await writeFile(
      join(f.bin, 'codex'),
      `#!/usr/bin/env python3
import pathlib,sys,json
args=sys.argv[1:]
expected='developer_instructions='+json.dumps(${JSON.stringify(f.instructions.toString())},separators=(',',':'))
assert expected in args,(expected,args)
assert '-m' in args and args[args.index('-m')+1]=='fixture-model'
assert 'model_reasoning_effort="low"' in args and '--version' in args
assert not any('write:requested-only' in a for a in args)
skills=list(pathlib.Path('.agents/skills').glob('*/SKILL.md'));assert len(skills)==1
assert skills[0].read_bytes()==bytes.fromhex('${f.skillBytes.toString('hex')}')
assert skills[0].with_name('LICENSE').read_bytes()==bytes.fromhex('${f.license.toString('hex')}')
pathlib.Path('package-effect.json').write_text(json.dumps({'bytes':len(skills[0].read_bytes()),'args':args}))
print('EXACT_PACKAGE_CALLER_EFFECT',flush=True)
`,
      { mode: 0o700 },
    )
    const cli = [
      process.execPath,
      'run',
      resolve('scripts/fixtures/package-launch.ts'),
      'spawn',
      '--config-dir',
      f.config,
      '--as',
      'fixture-approved',
      'package',
      'demo',
      'selected',
    ]
    const child = Bun.spawn(
      [
        'python3',
        resolve('scripts/fixtures/manual-profile-pty.py'),
        JSON.stringify(cli),
        f.work,
      ],
      {
        env: { HOME: f.root, PATH: f.bin + ':' + process.env.PATH, LANG: 'C' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, out, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, error }).toEqual({ code: 0, error: '' })
    expect(JSON.parse(out)).toMatchObject({ code: 0 })
    expect(JSON.parse(out).output).toContain('EXACT_PACKAGE_CALLER_EFFECT')
    expect(
      JSON.parse(await readFile(join(f.work, 'package-effect.json'), 'utf8'))
        .bytes,
    ).toBe(f.skillBytes.length)
    expect(
      JSON.parse(
        await readFile(join(f.work, 'identity-selection.json'), 'utf8'),
      ),
    ).toEqual({ label: 'fixture-approved', cwd: f.work, legacy: false })
    expect(await readdir(join(f.work, '.agents/skills'))).toEqual([])
    expect(
      (await readdir(f.work)).filter((p) => p.startsWith('.gild-package-run-')),
    ).toEqual([])
    // Prove offline: remove original repositories and still resolve pinned installed data.
    await rm(f.source, { recursive: true })
    await rm(f.skill, { recursive: true })
    expect(
      (await resolvePackageLaunch(f.consumer, 'selected')).skills[0].get(
        'LICENSE',
      ),
    ).toEqual(f.license)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}, 25000)

test('nested source lock tamper and missing Git proof refuse before staging', async () => {
  const f = await fixture()
  try {
    const path = join(f.consumer, 'agents/personal/gild.lock'),
      original = await readFile(path)
    await writeFile(path, original.toString() + '\n')
    await expect(resolvePackageLaunch(f.consumer, 'selected')).rejects.toThrow(
      'differs from its pinned Git commit',
    )
    await writeFile(path, original)
    const commit = f.lock.dependencies.personal.commit
    const changed = Buffer.from(
      git(f.source, ['cat-file', 'commit', commit]) + '\nowned mutation\n',
    )
    await rm(
      join(
        f.consumer,
        PACKAGE_OBJECTS,
        'objects',
        commit.slice(0, 2),
        commit.slice(2),
      ),
    )
    await writeFile(
      join(
        f.consumer,
        PACKAGE_OBJECTS,
        'objects',
        commit.slice(0, 2),
        commit.slice(2),
      ),
      deflateSync(
        Buffer.concat([Buffer.from(`commit ${changed.length}\0`), changed]),
      ),
    )
    await expect(resolvePackageLaunch(f.consumer, 'selected')).rejects.toThrow(
      'Git proof object integrity mismatch',
    )
    await rm(join(f.consumer, PACKAGE_OBJECTS), { recursive: true })
    await expect(resolvePackageLaunch(f.consumer, 'selected')).rejects.toThrow()
    expect(await readdir(f.work)).toEqual([])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}, 20000)

test('package registration cleanup preserves a changed file and never deletes another slot', async () => {
  const f = await fixture()
  try {
    const selection = await resolvePackageLaunch(f.consumer, 'selected'),
      material = preparePackageLaunch(selection, f.work, [])
    const directory = join(f.work, '.agents/skills'),
      slot = (await readdir(directory))[0]
    await mkdir(join(directory, 'owner-slot'))
    await writeFile(join(directory, 'owner-slot/SKILL.md'), 'owner data')
    await writeFile(join(directory, slot, 'SKILL.md'), 'owner changed bytes')
    expect(() => material.close()).toThrow('retained')
    expect(await readFile(join(directory, slot, 'SKILL.md'), 'utf8')).toBe(
      'owner changed bytes',
    )
    expect(await readFile(join(directory, 'owner-slot/SKILL.md'), 'utf8')).toBe(
      'owner data',
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}, 20000)

test('actual persistent MAIN package HOST task owns byte lifetime, durable identity, cancel and restart without replay', async () => {
  const f = await fixture(),
    sourceDirectory = join(f.root, 'src')
  await mkdir(sourceDirectory)
  const built = await Bun.build({
    entrypoints: [resolve('scripts/fixtures/package-main.ts')],
    target: 'bun',
    outdir: sourceDirectory,
    naming: 'main.mjs',
  })
  expect(built.success, JSON.stringify(built.logs)).toBe(true)
  await writeFile(
    join(sourceDirectory, 'gild.ts'),
    "await import('./main.mjs')\n",
  )
  await symlink(resolve('node_modules'), join(f.root, 'node_modules'))
  await writeFile(
    join(f.bin, 'codex'),
    `#!/usr/bin/env python3
import pathlib,sys,json,time
args=sys.argv[1:]
expected='developer_instructions='+json.dumps(${JSON.stringify('Exact package instructions\r\n')},separators=(',',':'))
assert expected in args and 'fixture-model' in args and 'model_reasoning_effort="low"' in args and '--version' in args
assert not any('write:requested-only' in a for a in args)
skills=list(pathlib.Path('.agents/skills').glob('*/SKILL.md'));assert len(skills)==1
assert skills[0].read_bytes()==bytes.fromhex('${f.skillBytes.toString('hex')}')
assert skills[0].with_name('LICENSE').read_bytes()==bytes.fromhex('${f.license.toString('hex')}')
with pathlib.Path('main-package-effects.txt').open('a') as out:out.write('one exact package effect\\n')
if '--modify' in args:skills[0].write_text('owned runtime changed bytes')
print('MAIN_PACKAGE_BYTES_READY',flush=True)
if '--slow' in args:time.sleep(60)
`,
    { mode: 0o700 },
  )
  const env = {
    HOME: f.root,
    PATH: f.bin + ':' + process.env.PATH,
    LANG: 'C',
    TERM: 'xterm-256color',
    TMPDIR: f.root,
  }
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, 'run', join(sourceDirectory, 'gild.ts'), ...args],
      { cwd: f.work, env, stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, out, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, out, error }
  }
  const command = async (...args: string[]) => {
    const r = await run(...args)
    if (r.code) throw Error(r.error || r.out)
    return JSON.parse(r.out)
  }
  const until = async (id: string, done: (t: any) => boolean) => {
    const deadline = Date.now() + 15000
    let last: unknown
    while (Date.now() < deadline) {
      const t = await command('task', 'status', id)
      last = t
      if (done(t)) return t
      await Bun.sleep(60)
    }
    throw Error(
      'Package task did not reach expected state: ' + JSON.stringify(last),
    )
  }
  const submit = (...args: string[]) => [
    'task',
    'submit',
    '--config-dir',
    f.config,
    '--as',
    'fixture-approved',
    ...args,
    'package',
    'demo',
    'selected',
  ]
  let running = false
  let passed = false
  try {
    const first = await command('main', 'start')
    running = true
    const id = randomUUID(),
      input = {
        agent: 'package',
        args: [],
        cwd: f.work,
        mode: 'HOST',
        package: { folder: 'demo', member: 'selected', configDir: f.config },
        identity: 'fixture-approved',
      }
    // Send once and deliberately discard the reply; retry must reuse the durable task.
    await new Promise<void>((done, reject) => {
      const socket = createConnection(join(f.root, '.gild/main/main.sock'))
      socket.on('error', reject)
      socket.on('connect', () =>
        socket.end(JSON.stringify({ type: 'submit', id, input }) + '\n', done),
      )
    })
    const retried = await command(...submit('--id', id))
    expect(retried.id).toBe(id)
    const result = await until(id, (t) =>
      ['SUCCEEDED', 'FAILED'].includes(t.status),
    )
    expect(result.status).toBe('SUCCEEDED')
    expect(result.code).toBe(0)
    expect(result.output).toContain('MAIN_PACKAGE_BYTES_READY')
    expect(result.package).toEqual(input.package)
    expect(result.identity).toBe('fixture-approved')
    expect(
      await readFile(join(f.work, 'main-package-effects.txt'), 'utf8'),
    ).toBe('one exact package effect\n')
    expect(await readdir(join(f.work, '.agents/skills'))).toEqual([])
    for (const changed of [
      { ...input, package: { ...input.package, member: 'other' } },
      { ...input, package: { ...input.package, folder: 'other' } },
      { ...input, identity: 'other-approved' },
    ]) {
      const response = await new Promise<string>((done, reject) => {
        const socket = createConnection(join(f.root, '.gild/main/main.sock'))
        let out = ''
        socket.setEncoding('utf8')
        socket.on('error', reject)
        socket.on('connect', () =>
          socket.write(
            JSON.stringify({ type: 'submit', id, input: changed }) + '\n',
          ),
        )
        socket.on('data', (chunk) => (out += chunk))
        socket.on('end', () => done(out))
      })
      expect(response).toContain('different request')
    }
    const slow = await command(...submit(), '--slow')
    const active = await until(
      slow.id,
      (t) =>
        t.status === 'RUNNING' && t.output.includes('MAIN_PACKAGE_BYTES_READY'),
    )
    expect((await readdir(join(f.work, '.agents/skills'))).length).toBe(1)
    const foreign = await new Promise<string>((done, reject) => {
      const socket = createConnection(
        join(f.root, '.gild/sessions', active.session + '.sock'),
      )
      let out = ''
      socket.setEncoding('utf8')
      socket.on('error', reject)
      socket.on('connect', () =>
        socket.write(
          JSON.stringify({
            type: 'stop',
            graceMs: 100,
            expected: result.worker,
          }) + '\n',
        ),
      )
      socket.on('data', (chunk) => (out += chunk))
      socket.on('end', () => done(out))
    })
    expect(foreign).toContain('foreign worker was not stopped')
    expect((await command('task', 'cancel', slow.id)).status).toBe('CANCELLED')
    const cancelled = await until(slow.id, (t) => typeof t.code === 'number')
    expect(cancelled.code).not.toBe(0)
    expect(await readdir(join(f.work, '.agents/skills'))).toEqual([])
    const modify = await command(...submit(), '--modify')
    const changed = await until(modify.id, (t) => t.status === 'FAILED')
    expect(changed.error).toContain('retained')
    const retained = (await readdir(join(f.work, '.agents/skills')))[0]
    expect(
      await readFile(
        join(f.work, '.agents/skills', retained, 'SKILL.md'),
        'utf8',
      ),
    ).toBe('owned runtime changed bytes')
    // Remove only this test's known retained fixture before the next selected skill launch.
    await rm(join(f.work, '.agents/skills', retained), { recursive: true })
    const crash = await command(...submit(), '--slow')
    await until(
      crash.id,
      (t) =>
        t.status === 'RUNNING' && t.output.includes('MAIN_PACKAGE_BYTES_READY'),
    )
    const before = await readFile(
      join(f.work, 'main-package-effects.txt'),
      'utf8',
    )
    process.kill(first.pid, 'SIGKILL')
    running = false
    const deadline = Date.now() + 8000
    while (
      (await readdir(join(f.work, '.agents/skills'))).length &&
      Date.now() < deadline
    )
      await Bun.sleep(50)
    expect(await readdir(join(f.work, '.agents/skills'))).toEqual([])
    const recovered = await command('main', 'start')
    running = true
    expect(recovered.machineId).toBe(first.machineId)
    expect((await command(...submit('--id', crash.id), '--slow')).status).toBe(
      'INTERRUPTED',
    )
    expect(
      await readFile(join(f.work, 'main-package-effects.txt'), 'utf8'),
    ).toBe(before)
    expect((await command(...submit('--id', id))).submitted).toBe(
      result.submitted,
    )
    passed = true
  } finally {
    if (running) await run('main', 'stop')
    if (passed) await rm(f.root, { recursive: true, force: true })
    else console.log('Owned failing MAIN package fixture retained:', f.root)
  }
}, 60000)
