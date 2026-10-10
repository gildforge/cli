import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { codexAdapter, NO_UPDATE_PROMPT } from './spawn-adapters/codex'
import { originalNotify } from './spawn-adapters/codex-notify'

async function fixture(run: (root: string) => Promise<void>) {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(resolve('.tmp/notify-'))
  const old = process.env.CODEX_HOME
  process.env.CODEX_HOME = root
  try {
    await run(root)
  } finally {
    if (old === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = old
    await rm(root, { recursive: true, force: true })
  }
}
const cli = () =>
  process.env.TEST_GILD_HOOK_COMMAND
    ? (JSON.parse(process.env.TEST_GILD_HOOK_COMMAND) as string[])
    : [process.execPath, 'run', resolve('src/gild.ts')]

test('Codex user notify runs after forwarding with its fixed args and identical notification argument, including absent sockets', async () => {
  await fixture(async (root) => {
    await mkdir(join(root, '.gild/sessions'), { recursive: true })
    const forwarded = join(root, 'forwarded.json')
    const observed = join(root, 'observed.json')
    const script = join(root, 'notify.py')
    await Bun.write(
      script,
      `import json,pathlib,sys\nassert pathlib.Path(sys.argv[1]).exists()\npathlib.Path(sys.argv[2]).write_text(json.dumps(sys.argv[3:]))\n`,
    )
    const command = [
      'python3',
      script,
      forwarded,
      observed,
      '--user-flag',
      'two words',
    ]
    const config = `# root user hook; literal strings and multiline TOML\nnotify = [\n${command.map((arg) => `'${arg}'`).join(',\n')},\n]\n[profiles.other]\nmodel = 'fixture'\n`
    await Bun.write(join(root, 'config.toml'), config)
    await mkdir(join(root, 'wrapper-config'))
    await Bun.write(
      join(root, 'wrapper-config/config.toml'),
      'notify=["/wrong-notifier"]\n',
    )
    process.env.CODEX_HOME = join(root, 'wrapper-config')
    const prepared = await codexAdapter.prepare(
      {
        id: 'test',
        directory: root,
        command: cli(),
        environment: { HOME: root, CODEX_HOME: root },
      },
      ['--resume'],
    )
    const generated = JSON.parse(
      prepared.args[1].slice('notify='.length),
    ) as string[]
    expect(generated.slice(-2)).toEqual([
      '--notify-command',
      JSON.stringify(command),
    ])
    expect(prepared.args.slice(2)).toEqual([...NO_UPDATE_PROMPT, '--resume'])
    const server = createServer((socket) => {
      let message = ''
      socket.on('data', (data) => (message += data))
      socket.on('end', () => writeFileSync(forwarded, message))
    })
    await new Promise<void>((r) =>
      server.listen(join(root, '.gild/sessions/test.sock'), r),
    )
    const raw =
      '{ "type": "agent-turn-complete", "thread-id": "fixture", "last-assistant-message": "same argv 🦊" }'
    async function invoke(id: string) {
      const args = [...generated]
      args[args.indexOf('--session') + 1] = id
      const proc = Bun.spawn([...args, raw], {
        env: { ...process.env, HOME: root },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect({ code, out, err }).toEqual({ code: 0, out: '', err: '' })
      expect(JSON.parse(await readFile(observed, 'utf8'))).toEqual([
        '--user-flag',
        'two words',
        raw,
      ])
    }
    try {
      await invoke('test')
      expect(JSON.parse(await readFile(forwarded, 'utf8'))).toEqual({
        type: 'hook',
        agent: 'codex',
        raw: JSON.parse(raw),
      })
      await rm(observed)
      await invoke('missing')
      expect(await readFile(join(root, 'config.toml'), 'utf8')).toBe(config)
    } finally {
      prepared.cleanup()
      server.close()
    }
  })
}, 15000)

test('Codex notify CLI overrides replace user notify in order and remain chained; -- terminates option parsing', async () => {
  await fixture(async (root) => {
    await Bun.write(
      join(root, 'config.toml'),
      'notify = ["/user", "original"]\n',
    )
    for (const override of [
      ['-c', "notify=['/cli', 'literal arg']"],
      ['--config', 'notify=["/cli","literal arg"]'],
      ['--config=notify=["/cli","literal arg"]'],
      ['-cnotify=["/cli","literal arg"]'],
    ]) {
      const input = [
        '-c',
        'model="fixture"',
        ...override,
        '--',
        '-c',
        'notify=["positional"]',
      ]
      const result = await originalNotify(input)
      expect(result.command).toEqual(['/cli', 'literal arg'])
      expect(result.args).toEqual([
        '-c',
        'model="fixture"',
        '--',
        '-c',
        'notify=["positional"]',
      ])
      const prepared = await codexAdapter.prepare(
        { id: 'test', directory: root, command: ['/gild'] },
        input,
      )
      const generated = JSON.parse(prepared.args[1].slice(7))
      expect(generated.slice(-2)).toEqual([
        '--notify-command',
        JSON.stringify(result.command),
      ])
      expect(prepared.args.slice(2)).toEqual([
        ...NO_UPDATE_PROMPT,
        ...result.args,
      ])
      prepared.cleanup()
    }
    expect(
      (await originalNotify(['-c', 'notify=["/first"]', '-c', 'notify=[]']))
        .command,
    ).toEqual([])
    const prepared = await codexAdapter.prepare(
      { id: 'test', directory: root, command: ['/gild'] },
      ['-c', 'notify=[]'],
    )
    expect(prepared.args).toEqual([
      '-c',
      'notify=["/gild","hook","--session","test","--agent","codex"]',
      ...NO_UPDATE_PROMPT,
    ])
    prepared.cleanup()
  })
})

test('Codex selected profile notify overlays user config and CLI notify still wins', async () => {
  await fixture(async (root) => {
    await Bun.write(
      join(root, 'config.toml'),
      'notify=["/user"]\nprofile="default"\n',
    )
    await Bun.write(join(root, 'default.config.toml'), 'notify=["/default"]\n')
    await Bun.write(
      join(root, 'chosen.config.toml'),
      'notify=["/chosen", "profile arg"]\n',
    )
    expect((await originalNotify([])).command).toEqual(['/default'])
    for (const args of [
      ['--profile', 'chosen'],
      ['-p', 'chosen'],
      ['--profile=chosen'],
      ['-pchosen'],
      ['-c', 'profile="chosen"'],
    ]) {
      expect(await originalNotify(args)).toEqual({
        command: ['/chosen', 'profile arg'],
        args,
      })
      const withNotify = [...args, '-c', 'notify=["/cli"]']
      expect(await originalNotify(withNotify)).toEqual({
        command: ['/cli'],
        args,
      })
    }
    expect(
      (await originalNotify(['-c', 'profile="chosen"', '--profile', 'default']))
        .command,
    ).toEqual(['/default'])
  })
})
