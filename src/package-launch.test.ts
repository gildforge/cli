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
