import { test, expect } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  chmod,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'

for (const mode of ['decline', 'cancel', 'generation-error'] as const)
  test(`clean first-run auth init ${mode} preserves empty identity and skips Git/network effects`, async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const root = await mkdtemp(resolve('.tmp/auth-decline-')),
      config = join(root, 'config'),
      bin = join(root, 'bin'),
      home = join(root, 'home')
    for (const path of [config, bin, home]) await mkdir(path, { mode: 0o700 })
    await chmod(config, 0o500)
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh\nprintf 'attempt\\n' >> '${join(root, 'git-attempts')}'\nexit 73\n`,
      { mode: 0o700 },
    )
    let passed = false
    try {
      const cli = [
        process.execPath,
        'run',
        resolve('scripts/fixtures/auth-init-guard.ts'),
        '--config-dir',
        config,
        'auth',
        'init',
      ]
      const child = Bun.spawn(
        [
          'python3',
          resolve('scripts/fixtures/auth-init-pty.py'),
          JSON.stringify(cli),
          mode,
        ],
        {
          env: {
            HOME: home,
            PATH: bin + ':' + process.env.PATH,
            AUTH_FIXTURE_ROOT: root,
            LANG: 'C',
            TERM: 'xterm-256color',
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
      expect({ code, error }).toEqual({ code: 0, error: '' })
      const result = JSON.parse(out),
        guard = JSON.parse(
          await readFile(join(root, 'guard-result.json'), 'utf8'),
        )
      expect(guard).toEqual({
        keyGenerationAttempts: mode === 'generation-error' ? 1 : 0,
        networkAttempts: 0,
        gitHelperInvoked: false,
        identityWritten: false,
        guardsVerified: true,
      })
      expect(await readdir(config)).toEqual([])
      expect(result.output).not.toContain('Identity created.')
      if (mode === 'decline') {
        expect(result.code).toBe(0)
        expect(result.output).toContain('Identity creation cancelled.')
      } else {
        expect(result.code).not.toBe(0)
        if (mode === 'generation-error')
          expect(result.output).toContain(
            'Fixture forbids credential generation',
          )
      }
      passed = true
    } finally {
      await chmod(config, 0o700)
      if (passed) await rm(root, { recursive: true, force: true })
      else console.log('Owned failed auth-decline fixture retained:', root)
    }
  }, 25000)
