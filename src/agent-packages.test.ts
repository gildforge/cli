import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  chmod,
  stat,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installPackage, listPackages, editPackage } from './agent-packages'
import { editJsonDefinition, configuredEditor } from './configured-editor'
import { parseAgentPackageManifest } from './api/agent-package-contract'

test('owned Git package with two agents installs to consumer; explicit update changes the locked file effect', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(resolve('.tmp/package-flow-')),
    source = join(root, 'source'),
    consumer = join(root, 'consumer')
  for (const directory of [source, consumer])
    await mkdir(directory, { mode: 0o700 })
  const git = (directory: string, args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: directory,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Gild package fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Gild package fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim()
  const personal = {
    version: 1,
    name: 'personal',
    files: ['LICENSE', 'ava.md', 'bob.md'],
    agents: {
      ava: { runtime: 'codex', instructions: 'ava.md' },
      bob: { runtime: 'claude', instructions: 'bob.md' },
    },
    dependencies: {},
  }
  const demo = {
    version: 1,
    name: 'demo',
    files: [],
    agents: { ava: { dependency: 'personal', member: 'ava' } },
    dependencies: {
      personal: {
        kind: 'agents',
        repository: 'https://fixture.invalid/sami/personal.git',
        ref: 'latest',
      },
    },
  }
  try {
    await writeFile(join(source, 'gild.json'), JSON.stringify(personal))
    await writeFile(join(source, 'ava.md'), 'first authored instructions\n')
    await writeFile(join(source, 'bob.md'), 'second agent\n')
    await writeFile(join(source, 'LICENSE'), 'literal license bytes\r\n')
    git(source, ['init', '--quiet', '--initial-branch=main'])
    git(source, ['add', '.'])
    git(source, ['commit', '--quiet', '-m', 'Owned package fixture initial'])
    await writeFile(join(consumer, 'gild.json'), JSON.stringify(demo))
    git(consumer, ['init', '--quiet', '--initial-branch=main'])
    const cliConsumer = join(root, 'cli-consumer')
    await mkdir(cliConsumer, { mode: 0o700 })
    await writeFile(join(cliConsumer, 'gild.json'), JSON.stringify(demo))
    const cliInstall = async (command: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          'run',
          resolve('src/gild.ts'),
          'package',
          command,
          cliConsumer,
        ],
        {
          cwd: cliConsumer,
          env: {
            ...process.env,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'url.' + source + '.insteadOf',
            GIT_CONFIG_VALUE_0: demo.dependencies.personal.repository,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, out, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code) throw Error(error)
      return JSON.parse(out)
    }
    const firstCli = await cliInstall('install')
    expect(firstCli.dependencies.personal.commit).toBe(
      git(source, ['rev-parse', 'HEAD']),
    )
    const options = { transportRepository: () => source }
    const first = await installPackage(consumer, false, options)
    expect(first.dependencies.personal.commit).toBe(
      git(source, ['rev-parse', 'HEAD']),
    )
    expect(
      await readFile(join(consumer, 'agents/personal/ava.md'), 'utf8'),
    ).toBe('first authored instructions\n')
    expect(await readFile(join(consumer, 'agents/personal/LICENSE'))).toEqual(
      Buffer.from('literal license bytes\r\n'),
    )
    expect(git(consumer, ['check-ignore', 'agents/personal/ava.md'])).toBe(
      'agents/personal/ava.md',
    )
    await writeFile(join(source, 'ava.md'), 'updated authored instructions\n')
    git(source, ['add', 'ava.md'])
    git(source, [
      'commit',
      '--quiet',
      '-m',
      'Owned package fixture explicit update',
    ])
    const pinnedCli = await cliInstall('install')
    expect(pinnedCli.dependencies.personal.commit).toBe(
      firstCli.dependencies.personal.commit,
    )
    const updatedCli = await cliInstall('update')
    expect(updatedCli.dependencies.personal.commit).toBe(
      git(source, ['rev-parse', 'HEAD']),
    )
    expect(
      await readFile(join(cliConsumer, 'agents/personal/ava.md'), 'utf8'),
    ).toBe('updated authored instructions\n')
    const pinned = await installPackage(consumer, false, options)
    expect(pinned.dependencies.personal.commit).toBe(
      first.dependencies.personal.commit,
    )
    expect(
      await readFile(join(consumer, 'agents/personal/ava.md'), 'utf8'),
    ).toBe('first authored instructions\n')
    const updated = await installPackage(consumer, true, options)
    expect(updated.dependencies.personal.commit).not.toBe(
      first.dependencies.personal.commit,
    )
    expect(
      await readFile(join(consumer, 'agents/personal/ava.md'), 'utf8'),
    ).toBe('updated authored instructions\n')
    const skill = join(root, 'verification')
    await mkdir(skill, { mode: 0o700 })
    await writeFile(
      join(skill, 'gild.json'),
      JSON.stringify({
        version: 1,
        name: 'verification',
        files: ['LICENSE', 'SKILL.md'],
        agents: {},
        dependencies: {},
      }),
    )
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: verification-loop\n---\nRun the verification steps.\n',
    )
    await writeFile(join(skill, 'LICENSE'), 'skill literal license\r\n')
    git(skill, ['init', '--quiet', '--initial-branch=main'])
    git(skill, ['add', '.'])
    git(skill, ['commit', '--quiet', '-m', 'Owned skill dependency fixture'])
    const withSkill = {
      ...personal,
      agents: {
        ...personal.agents,
        ava: { ...personal.agents.ava, skills: ['verification'] },
      },
      dependencies: {
        verification: {
          kind: 'skills',
          repository: 'https://fixture.invalid/sami/verification.git',
          ref: 'latest',
        },
      },
    }
    await writeFile(join(source, 'gild.json'), JSON.stringify(withSkill))
    const nestedOptions = {
      transportRepository: (url: string) =>
        url.includes('verification.git') ? skill : source,
    }
    await installPackage(source, false, nestedOptions)
    git(source, ['add', 'gild.json', 'gild.lock', '.gitignore'])
    git(source, [
      'commit',
      '--quiet',
      '-m',
      'Owned package locks its skill dependency',
    ])
    await installPackage(consumer, true, nestedOptions)
    expect(
      await readFile(
        join(consumer, 'agents/personal/skills/verification/SKILL.md'),
        'utf8',
      ),
    ).toContain('verification-loop')
    expect(
      await readFile(
        join(consumer, 'agents/personal/skills/verification/LICENSE'),
      ),
    ).toEqual(Buffer.from('skill literal license\r\n'))
    const two = {
      ...demo,
      dependencies: {
        first: demo.dependencies.personal,
        later: {
          ...demo.dependencies.personal,
          repository: 'https://fixture.invalid/sami/later.git',
        },
      },
      agents: { ava: { dependency: 'first', member: 'ava' } },
    }
    const second = join(root, 'two')
    await mkdir(second, { mode: 0o700 })
    await writeFile(join(second, 'gild.json'), JSON.stringify(two))
    await installPackage(second, false, nestedOptions)
    let ownerChanged = false
    await expect(
      installPackage(second, true, {
        transportRepository: (url: string) => {
          if (url.includes('later') && !ownerChanged) {
            ownerChanged = true
            writeFileSync(
              join(second, 'agents/first/ava.md'),
              'late owner edit must survive\n',
            )
          }
          return url.includes('verification.git') ? skill : source
        },
      }),
    ).rejects.toThrow('owner data preserved')
    expect(await readFile(join(second, 'agents/first/ava.md'), 'utf8')).toBe(
      'late owner edit must survive\n',
    )
    await writeFile(
      join(consumer, 'agents/personal/ava.md'),
      'owner edit must survive\n',
    )
    await expect(installPackage(consumer, true, nestedOptions)).rejects.toThrow(
      'integrity',
    )
    expect(
      await readFile(join(consumer, 'agents/personal/ava.md'), 'utf8'),
    ).toBe('owner edit must survive\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test('offline package discovery lists two agents, skips credential roots, and continues past malformed neighbor', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(resolve('.tmp/package-list-'))
  try {
    for (const name of [
      'personal',
      'malformed',
      'agents',
      'runners',
      'vm',
      'notes space',
    ])
      await mkdir(join(root, name), { mode: 0o700 })
    await writeFile(
      join(root, 'personal/gild.json'),
      JSON.stringify({
        version: 1,
        name: 'personal',
        files: [],
        agents: { ava: { runtime: 'codex' }, bob: { runtime: 'claude' } },
        dependencies: {},
      }),
    )
    await writeFile(join(root, 'malformed/gild.json'), 'not JSON')
    await writeFile(
      join(root, 'agents/gild.json'),
      'FAKE credential sentinel: must not parse',
    )
    const result = await listPackages(root)
    expect(result.packages.map((p) => Object.keys(p.manifest.agents))).toEqual([
      ['ava', 'bob'],
    ])
    expect(result.warnings).toEqual(['malformed: invalid or unsafe gild.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('actual CLI package paths list/show/edit definitions and keep credential directories untouched', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const home = await mkdtemp(resolve('.tmp/package-cli-')),
    config = join(home, 'config'),
    folder = join(config, 'personal'),
    credentials = join(config, 'agents')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await mkdir(credentials, { mode: 0o700 })
  const sentinel = 'FAKE-GILD-CREDENTIAL: never parse or edit'
  await writeFile(join(credentials, 'ava.json'), sentinel, { mode: 0o600 })
  await writeFile(
    join(folder, 'gild.json'),
    JSON.stringify({
      version: 1,
      name: 'personal',
      files: [],
      agents: { ava: { runtime: 'codex' }, bob: { runtime: 'claude' } },
      dependencies: {},
    }),
    { mode: 0o600 },
  )
  const editor = join(home, 'editor.py')
  await writeFile(
    editor,
    "import json,sys\np=sys.argv[-1];d=json.load(open(p));d['agents']['ava']['model']='configured-editor-model';open(p,'w').write(json.dumps(d))\n",
  )
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        resolve('src/gild.ts'),
        '--config-dir',
        config,
        ...args,
      ],
      {
        env: {
          HOME: home,
          PATH: process.env.PATH!,
          VISUAL: `python3 '${editor}'`,
          EDITOR: 'must-not-run',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, out, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, out, error }
  }
  try {
    const list = await run('agent', 'ls', '--json')
    expect(list.code).toBe(0)
    expect(Object.keys(JSON.parse(list.out)[0].manifest.agents)).toEqual([
      'ava',
      'bob',
    ])
    const show = await run('agent', 'show', 'personal', 'ava')
    expect(JSON.parse(show.out)).toEqual({ runtime: 'codex' })
    const edit = await run('agent', 'edit', 'personal')
    expect(edit).toEqual({ code: 0, out: 'Updated gild.json\n', error: '' })
    expect(
      JSON.parse(await readFile(join(folder, 'gild.json'), 'utf8')).agents.ava
        .model,
    ).toBe('configured-editor-model')
    const shortcut = await run(
      'agent',
      'edit',
      'personal',
      '--member',
      'bob',
      '--model',
      'shortcut-model',
    )
    expect(shortcut.code).toBe(0)
    expect(
      JSON.parse(await readFile(join(folder, 'gild.json'), 'utf8')).agents.bob
        .model,
    ).toBe('shortcut-model')
    expect(await readFile(join(credentials, 'ava.json'), 'utf8')).toBe(sentinel)
    expect((await run('agent', 'edit', 'agents')).code).not.toBe(0)
    expect(await readFile(join(credentials, 'ava.json'), 'utf8')).toBe(sentinel)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 15000)

test('configured editor uses VISUAL argv, private draft, schema save, cancel/invalid preservation and version conflict', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(resolve('.tmp/package-editor-')),
    file = join(root, 'gild.json'),
    editor = join(root, 'fake-editor.py')
  const original = JSON.stringify({
    version: 1,
    name: 'personal',
    files: [],
    agents: { ava: { runtime: 'codex' } },
    dependencies: {},
  })
  await writeFile(
    editor,
    `import json,os,stat,sys\nmode,path=sys.argv[1:]\nassert stat.S_IMODE(os.stat(path).st_mode)==0o600\nassert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode)==0o700\nif mode=='cancel':sys.exit(7)\nif mode=='invalid':open(path,'w').write('{broken');sys.exit(0)\ndata=json.load(open(path));data['agents']['ava']['model']='fixture-model'\nif mode=='conflict':open(${JSON.stringify(file)},'w').write('owner changed canonical file')\nopen(path,'w').write(json.dumps(data))\n`,
  )
  const env = (mode: string) => ({
    ...process.env,
    VISUAL: `python3 '${editor}' '${mode}'`,
    EDITOR: 'must-not-run',
  })
  try {
    expect(configuredEditor(env('valid')).source).toBe('VISUAL')
    await writeFile(file, original, { mode: 0o600 })
    expect(
      (await editJsonDefinition(file, parseAgentPackageManifest, env('valid')))
        .changed,
    ).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8')).agents.ava.model).toBe(
      'fixture-model',
    )
    await writeFile(file, original, { mode: 0o600 })
    expect(
      (await editJsonDefinition(file, parseAgentPackageManifest, env('cancel')))
        .cancelled,
    ).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(original)
    await expect(
      editJsonDefinition(file, parseAgentPackageManifest, env('invalid')),
    ).rejects.toThrow('original file is unchanged')
    expect(await readFile(file, 'utf8')).toBe(original)
    await expect(
      editJsonDefinition(file, parseAgentPackageManifest, env('conflict')),
    ).rejects.toThrow('not overwritten')
    expect(await readFile(file, 'utf8')).toBe('owner changed canonical file')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
