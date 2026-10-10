import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promptGild } from './gild-invocation'

test('prompts use plain gild for this source or binary, preserving an explicit command when shadowed', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(resolve('.tmp/invocation-'))
  try {
    const source = join(root, 'gild.ts'),
      dir = join(root, 'bin')
    await writeFile(source, '#!/usr/bin/env bun\n')
    await chmod(source, 0o755)
    await mkdir(dir)
    await symlink(source, join(dir, 'gild'))
    expect(promptGild([process.execPath, 'run', source], dir)).toBe('gild')
    expect(promptGild([source], dir)).toBe('gild')
    const other = join(root, 'other')
    await mkdir(other)
    await writeFile(join(other, 'gild'), '#!/bin/sh\nexit 0\n')
    await chmod(join(other, 'gild'), 0o755)
    expect(
      promptGild([process.execPath, 'run', source], other + ':' + dir),
    ).not.toBe('gild')
    expect(promptGild([source], '')).toBe(`'${source}'`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prompts resolve the installed npm launcher to the spawning platform binary', async () => {
  const root = await mkdtemp(resolve('.tmp/launcher-'))
  try {
    const launcher = join(root, 'node_modules/gildforge/bin/gild.js')
    const pkg = join(
      root,
      `node_modules/@gildforge/cli-${process.platform}-${process.arch}`,
    )
    const path = join(root, 'bin')
    await mkdir(join(pkg, 'bin'), { recursive: true })
    await mkdir(join(root, 'node_modules/gildforge/bin'), { recursive: true })
    await mkdir(path)
    await writeFile(join(pkg, 'package.json'), '{}')
    await writeFile(join(pkg, 'bin/gild'), '')
    await writeFile(launcher, '#!/usr/bin/env node\n')
    await chmod(launcher, 0o755)
    await symlink(launcher, join(path, 'gild'))
    expect(promptGild([join(pkg, 'bin/gild')], path)).toBe('gild')
    expect(promptGild([process.execPath], path)).not.toBe('gild')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
