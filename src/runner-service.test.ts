import { test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  servicePlan,
  servicePath,
  runnerService,
  type ServiceOptions,
} from './runner-service'

async function fixture(platform: NodeJS.Platform) {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(resolve('.tmp/service-review-'))
  const reports: string[] = []
  const opts: ServiceOptions = {
    name: 'review-fixture',
    home: root,
    configDir: join(root, 'config'),
    platform,
    executable: '/opt/gild/gild',
    uid: 501,
    findTool: () => null,
    report: (message) => reports.push(message),
  }
  return {
    root,
    opts,
    reports,
    async close() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('service uninstall removes unit/plist after manager failure and explains retained runner credentials', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const f = await fixture(platform),
      calls: string[] = []
    try {
      const plan = servicePlan(f.opts),
        config = join(f.opts.configDir, 'runners', f.opts.name + '.json')
      await mkdir(join(plan.file, '..'), { recursive: true })
      await writeFile(plan.file, plan.content)
      await mkdir(join(config, '..'), { recursive: true })
      await writeFile(config, '{"token":"gro_fixture"}')
      const opts = {
        ...f.opts,
        execute: (file: string, args: string[]) => {
          calls.push([file, ...args].join(' '))
          if (args.includes('disable') || args.includes('bootout'))
            throw Error('already unloaded')
        },
      }
      await expect(runnerService('uninstall', opts)).rejects.toThrow(
        'Service manager',
      )
      expect(existsSync(plan.file)).toBe(false)
      expect(await readFile(config, 'utf8')).toBe('{"token":"gro_fixture"}')
      expect(f.reports.join('\n')).toContain('gro_/gr_ token')
      expect(f.reports.join('\n')).toContain(
        'gild runner remove review-fixture',
      )
      if (platform === 'linux')
        expect(calls.at(-1)).toBe('systemctl --user daemon-reload')
    } finally {
      await f.close()
    }
  }
})

test('service install rolls back newly written definitions after bootstrap/enable/reload failure', async () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const f = await fixture(platform)
    try {
      const plan = servicePlan(f.opts)
      let installationCalls = 0
      const opts = {
        ...f.opts,
        execute: (_file: string, args: string[]) => {
          if (args.includes('daemon-reload')) return
          if (JSON.stringify(args) === JSON.stringify(plan.install.slice(1))) {
            installationCalls++
            if (platform === 'win32')
              require('node:fs').writeFileSync(plan.file, 'partial SCM host')
            throw Error('manager install failed')
          }
        },
      }
      await expect(runnerService('install', opts)).rejects.toThrow(
        'written definition was removed',
      )
      expect(installationCalls).toBe(1)
      expect(existsSync(plan.file)).toBe(false)
      if (platform === 'linux') {
        await expect(
          runnerService('install', {
            ...f.opts,
            execute: () => {
              throw Error('daemon unavailable')
            },
          }),
        ).rejects.toThrow('written definition was removed')
        expect(existsSync(plan.file)).toBe(false)
      }
    } finally {
      await f.close()
    }
  }
})

test('service install preserves existing definitions and never invokes a manager for them', async () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const f = await fixture(platform)
    try {
      const plan = servicePlan(f.opts)
      await mkdir(join(plan.file, '..'), { recursive: true })
      await writeFile(plan.file, 'existing definition')
      let calls = 0
      await expect(
        runnerService('install', {
          ...f.opts,
          execute: () => {
            calls++
          },
        }),
      ).rejects.toThrow('already exists')
      expect(calls).toBe(0)
      expect(await readFile(plan.file, 'utf8')).toBe('existing definition')
    } finally {
      await f.close()
    }
  }
})

test('Linux unit uses selected tool directories, survives manager startup and prints linger hint', async () => {
  const f = await fixture('linux')
  try {
    const paths: Record<string, string> = {
      node: '/opt/node/bin/node',
      bun: '/opt/bun/bin/bun',
      git: '/usr/bin/git',
    }
    const opts = {
      ...f.opts,
      findTool: (tool: string) => paths[tool] ?? null,
      execute: () => {},
    }
    const expected = '/opt/node/bin:/opt/bun/bin:/usr/bin:/bin'
    expect(servicePath(opts.findTool)).toBe(expected)
    expect(servicePath(() => null)).toBe('/usr/bin:/bin')
    const plan = servicePlan(opts)
    expect(plan.content).toContain('Environment="PATH=' + expected + '"')
    expect(plan.content).not.toContain(
      process.env.PATH ?? 'impossible-full-path',
    )
    const file = await runnerService('install', opts)
    expect(await readFile(file, 'utf8')).toBe(plan.content)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(f.reports.join('\n')).toContain('loginctl enable-linger')
    expect(f.reports.join('\n')).toContain('after logout')
    await runnerService('uninstall', opts)
    expect(existsSync(file)).toBe(false)
  } finally {
    await f.close()
  }
})

test('Windows service install uses terminating PowerShell errors for rollback', () => {
  const plan = servicePlan({
    name: 'review',
    configDir: resolve('.tmp/config'),
    platform: 'win32',
    home: resolve('.tmp/home'),
    executable: '/opt/gild/gild',
  })
  expect(plan.install[3]).toContain("$ErrorActionPreference='Stop'")
})
