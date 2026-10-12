import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { skillManifestIdentity } from '../api/agent-profile-contract'
import { SkillBundleCache } from './bundle-cache'
import { prepareManualProfileSkill } from './manual-profile'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
async function fixture() {
  const root = mkdtempSync(resolve('.manual-profile-test-'))
  roots.push(root)
  chmodSync(root, 0o700)
  const source = join(root, 'source'),
    cwd = join(root, 'project'),
    cacheDirectory = join(root, 'cache')
  for (const p of [source, cwd, cacheDirectory]) mkdirSync(p, { mode: 0o700 })
  const manifest = JSON.parse(
    readFileSync(
      'scripts/fixtures/skills/ecc-verification-loop.manifest.json',
      'utf8',
    ),
  )
  for (const name of ['SKILL.md', 'LICENSE'])
    copyFileSync(
      join('scripts/fixtures/skills/ecc-verification-loop', name),
      join(source, name),
    )
  const { pinId, bundleDigest, entryDigest } =
    await skillManifestIdentity(manifest)
  const selection = { pinId, bundleDigest, entryDigest },
    spec = { cacheDirectory, manifest, selection }
  const cache = new SkillBundleCache(cacheDirectory)
  try {
    await cache.store(selection, manifest, source)
  } finally {
    cache.close()
  }
  return { root, cwd, source, spec }
}
test('manual pinned Codex skill stages exact real ECC bytes and removes only its registration', async () => {
  const f = await fixture()
  const lease = await prepareManualProfileSkill(f.spec, 'codex', f.cwd)
  for (const name of ['SKILL.md', 'LICENSE'])
    expect(readFileSync(join(f.cwd, lease.relativeDirectory, name))).toEqual(
      readFileSync(join(f.source, name)),
    )
  expect(lease.read().selection).toEqual(f.spec.selection)
  lease.close()
  expect(readdirSync(join(f.cwd, '.agents/skills'))).toEqual([])
})
test('manual delivery refuses unsupported runtime, invalid pin and symlink discovery root', async () => {
  const f = await fixture()
  await expect(
    prepareManualProfileSkill(f.spec, 'claude', f.cwd),
  ).rejects.toThrow('codex only')
  await expect(
    prepareManualProfileSkill(
      {
        ...f.spec,
        selection: { ...f.spec.selection, entryDigest: '0'.repeat(64) },
      },
      'codex',
      f.cwd,
    ),
  ).rejects.toThrow()
  symlinkSync(f.source, join(f.cwd, '.agents'))
  await expect(
    prepareManualProfileSkill(f.spec, 'codex', f.cwd),
  ).rejects.toThrow()
  expect(readFileSync(join(f.source, 'SKILL.md')).length).toBe(3064)
})
test('changed registration is retained rather than deleted on shutdown', async () => {
  const f = await fixture(),
    lease = await prepareManualProfileSkill(f.spec, 'codex', f.cwd)
  const file = join(f.cwd, lease.relativeDirectory, 'SKILL.md')
  writeFileSync(file, 'owner change')
  expect(() => lease.close()).toThrow()
  expect(readFileSync(file, 'utf8')).toBe('owner change')
})
for (const scenario of [
  'delivery',
  'bad-pin',
  'unsupported',
  'detach',
  'non-tty',
])
  test(`production spawn profile skill: ${scenario}`, async () => {
    mkdirSync('.tmp', { recursive: true })
    const f = await fixture(),
      home = mkdtempSync(resolve('.tmp/m')),
      bin = join(f.root, 'bin')
    roots.push(home)
    mkdirSync(join(home, '.gild/agents'), { recursive: true, mode: 0o700 })
    mkdirSync(bin, { mode: 0o700 })
    const fake = join(bin, 'codex')
    writeFileSync(
      fake,
      `#!/usr/bin/env python3\nimport pathlib,hashlib,json\np=list(pathlib.Path('.agents/skills').glob('*/SKILL.md'))\nassert len(p)==1,p\nb=p[0].read_bytes()\nassert hashlib.sha256(b).hexdigest()=='${f.spec.selection.entryDigest}'\nassert p[0].with_name('LICENSE').read_bytes()==pathlib.Path('${join(f.source, 'LICENSE')}').read_bytes()\npathlib.Path('delivery-proof.json').write_text(json.dumps({'digest':hashlib.sha256(b).hexdigest(),'bytes':len(b)}))\nprint('PINNED_SKILL_DELIVERED',flush=True)\n`,
      { mode: 0o700 },
    )
    if (scenario === 'unsupported') {
      // No ambient provider binary is needed or reachable in this child PATH.
      for (const tool of ['python3', 'node']) {
        const executable = Bun.which(tool)
        if (!executable) throw Error(`Fixture requires existing ${tool}`)
        symlinkSync(executable, join(bin, tool))
      }
      writeFileSync(
        join(bin, 'claude'),
        '#!/usr/bin/env python3\nimport pathlib\npathlib.Path("unsupported-child-ran").write_text("unexpected")\n',
        { mode: 0o700 },
      )
    }
    writeFileSync(
      join(home, '.gild/agents/a.json'),
      JSON.stringify({
        name: 'a',
        runtime: scenario === 'unsupported' ? 'claude' : 'codex',
        directory: f.cwd,
        args: [],
        skill:
          scenario === 'bad-pin'
            ? {
                ...f.spec,
                selection: { ...f.spec.selection, entryDigest: '0'.repeat(64) },
              }
            : f.spec,
      }),
      { mode: 0o600 },
    )
    const cli = [
      process.execPath,
      'run',
      resolve('scripts/fixtures/manual-profile-launch.ts'),
      'spawn',
      ...(scenario === 'detach' ? ['--detach'] : []),
      'agent',
      'a',
    ]
    const child = Bun.spawn(
      scenario === 'non-tty'
        ? cli
        : [
            'python3',
            resolve('scripts/fixtures/manual-profile-pty.py'),
            JSON.stringify(cli),
            f.cwd,
          ],
      {
        env: {
          HOME: home,
          PATH: scenario === 'unsupported' ? bin : bin + ':' + process.env.PATH,
          LANG: 'C',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (scenario !== 'non-tty')
      expect({ code, err }).toEqual({ code: 0, err: '' })
    if (scenario === 'non-tty') {
      expect(code).not.toBe(0)
      expect(err).toContain('interactive PTY')
      expect(readdirSync(f.cwd)).not.toContain('delivery-proof.json')
      return
    }
    const result = JSON.parse(out)
    if (scenario !== 'delivery') {
      expect(result.code).not.toBe(0)
      expect(readdirSync(f.cwd)).not.toContain('delivery-proof.json')
      if (scenario === 'unsupported')
        expect(readdirSync(f.cwd)).not.toContain('unsupported-child-ran')
      expect(result.output).toContain(
        scenario === 'detach'
          ? 'attached PTY'
          : scenario === 'unsupported'
            ? 'codex only'
            : 'Skill selection does not match immutable manifest',
      )
      return
    }
    expect(result).toMatchObject({ code: 0 })
    expect(result.output).toContain('PINNED_SKILL_DELIVERED')
    expect(
      JSON.parse(readFileSync(join(f.cwd, 'delivery-proof.json'), 'utf8')),
    ).toEqual({ digest: f.spec.selection.entryDigest, bytes: 3064 })
    expect(readdirSync(join(f.cwd, '.agents/skills'))).toEqual([])
  }, 25000)

test('pinned native worker refuses stdio fallback before invoking its child', async () => {
  const f = await fixture(),
    worker = join(f.root, 'worker.mjs'),
    fake = join(f.root, 'native-child')
  const build = await Bun.build({
    entrypoints: [resolve('src/spawn-worker.ts')],
    target: 'node',
    outdir: f.root,
    naming: 'worker.mjs',
  })
  expect(build.success, JSON.stringify(build.logs)).toBe(true)
  writeFileSync(
    fake,
    '#!/usr/bin/env python3\nimport pathlib\npathlib.Path("fallback-ran").write_text("bad")\n',
    { mode: 0o700 },
  )
  const child = Bun.spawn(
    [
      'node',
      worker,
      JSON.stringify({
        agent: fake,
        args: [],
        id: 'a',
        idleMs: 1,
        ptyModule: 'unused',
        hookCommand: [],
        pinnedSkill: true,
      }),
    ],
    {
      cwd: f.cwd,
      env: { HOME: f.root, PATH: process.env.PATH, LANG: 'C' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code).toBe(1)
  expect(err).toContain('Pinned skill launch failed: PTY unavailable')
  expect(out).toBe('')
  expect(readdirSync(f.cwd)).not.toContain('fallback-ran')
})
