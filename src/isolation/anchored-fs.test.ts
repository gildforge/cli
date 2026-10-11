import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { AnchoredDirectory } from './anchored-fs'
import { createHash } from 'node:crypto'

test('descriptor sync executes inside a compiled Bun binary', async () => {
  await mkdir('.tmp', { recursive: true })
  const base = await mkdtemp(resolve('.tmp/compiled-sync-'))
  try {
    const source = join(base, 'check.ts'),
      binary = join(base, 'check')
    await writeFile(
      source,
      `import { AnchoredDirectory } from ${JSON.stringify(resolve('src/isolation/anchored-fs.ts'))};
const directory = AnchoredDirectory.open(${JSON.stringify(base)});
try {
  directory.put('fixture', {p:'fixture', k:'f', m:384}, Buffer.from('compiled fixture'));
  console.log(JSON.stringify(directory.entry('fixture', 'fixture')));
  directory.remove('fixture', false);
} finally { directory.close() }
`,
    )
    const built = Bun.spawnSync(
      ['bun', 'build', '--compile', source, '--outfile', binary],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(built.exitCode, built.stderr.toString()).toBe(0)
    const ran = Bun.spawnSync([binary], { stdout: 'pipe', stderr: 'pipe' })
    expect(ran.exitCode, ran.stderr.toString()).toBe(0)
    expect(JSON.parse(ran.stdout.toString())).toEqual({
      p: 'fixture',
      k: 'f',
      m: 0o600,
      s: 16,
      h: createHash('sha256').update('compiled fixture').digest('hex'),
    })
    expect(await Bun.file(join(base, 'fixture')).exists()).toBe(false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}, 30000)

test('directory descriptor operations stay with the opened ordinary directory', async () => {
  await mkdir('.tmp', { recursive: true })
  const base = await mkdtemp(resolve('.tmp/anchored-'))
  await mkdir(join(base, 'first'))
  const directory = AnchoredDirectory.open(join(base, 'first'))
  try {
    await rename(join(base, 'first'), join(base, 'original'))
    await mkdir(join(base, 'first'))
    await writeFile(join(base, 'first/sentinel'), 'replacement directory\n')
    directory.put(
      'sentinel',
      { p: 'sentinel', k: 'f', m: 0o600 },
      Buffer.from('opened directory\n'),
    )
    expect(await readFile(join(base, 'first/sentinel'), 'utf8')).toBe(
      'replacement directory\n',
    )
    expect(await readFile(join(base, 'original/sentinel'), 'utf8')).toBe(
      'opened directory\n',
    )
  } finally {
    directory.close()
    await rm(base, { recursive: true })
  }
})
