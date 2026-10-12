import { expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const {
  KERNEL_SHA256,
  KERNEL_VERSION,
  FRAGMENT,
  buildPlan,
  buildKernel,
  scratchPreparationArgs,
  validateConfig,
  validateBzImage,
  CONTAINER_RECIPE,
} = await import(
  process.env.TEST_GILD_VZ_KERNEL_RECIPE
    ? pathToFileURL(resolve(process.env.TEST_GILD_VZ_KERNEL_RECIPE)).href
    : './build-vz-kernel.mjs'
)
const image = 'sha256:' + 'a'.repeat(64)
const context = 'owned-local-context'
// Fresh checkouts need no global .tmp setup. Each test owns and cleans its root.
async function withTestRoot(run) {
  const root = await mkdtemp(resolve('.gild-vz-kernel-test-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  return root
}
const fragment = await readFile(FRAGMENT, 'utf8')
const finalConfig = fragment
  .split('\n')
  .map((line) =>
    line.endsWith('=n') ? '# ' + line.slice(0, -2) + ' is not set' : line,
  )
  .join('\n')

test('kernel-only plan binds local immutable amd64 image and denies downloads/network/rootfs', () => {
  const plan = buildPlan('local.tar.xz', 'new-output', image, context)
  expect(plan.jobs).toBe(2)
  for (const flag of [
    '--pull=never',
    '--network=none',
    '--platform=linux/amd64',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--cpus=2',
    '--memory=4g',
    '--pids-limit=512',
  ])
    expect(plan.args).toContain(flag)
  expect(plan.args).toContain(image)
  expect(plan.args.slice(0, 2)).toEqual(['--context', context])
  expect(() =>
    buildPlan('local.tar.xz', 'out', image, 'ssh://other-host'),
  ).toThrow('context')
  expect(
    plan.args
      .filter((a) => a.startsWith('type=bind,'))
      .filter((a) => a.endsWith(',readonly')).length,
  ).toBe(2)
  expect(plan.args).not.toContain('--privileged')
  expect(CONTAINER_RECIPE).toContain('make -s ARCH=x86 -jJOB_COUNT bzImage')
  expect(CONTAINER_RECIPE).toContain('sha256sum -c -')
  expect(CONTAINER_RECIPE).toContain(KERNEL_SHA256)
  expect(CONTAINER_RECIPE).not.toMatch(
    /apt-get|apk add|docker build|curl |wget |rootfs\.ext4/,
  )
})
test('kernel plan rejects mutable tags invalid job limits and ambiguous mount paths', () => {
  for (const bad of [
    'debian:trixie-slim',
    'sha256:short',
    'SHA256:' + 'a'.repeat(64),
  ])
    expect(() => buildPlan('local.tar.xz', 'new-output', bad, context)).toThrow(
      'immutable',
    )
  for (const jobs of [0, 5, 1.5, NaN])
    expect(() =>
      buildPlan('local.tar.xz', 'new-output', image, context, jobs),
    ).toThrow('1..4')
  for (const source of ['a,b.tar.xz', 'a\nb.tar.xz'])
    expect(() => buildPlan(source, 'new-output', image, context)).toThrow(
      'Bind mount',
    )
})
test('actual archive rejection makes zero Docker calls and creates no output', async () => {
  const root = await withTestRoot(async (root) => {
    const archive = resolve(root, 'fixture-not-kernel.tar.xz'),
      out = resolve(root, 'out')
    await writeFile(archive, 'Explicit synthetic NON-kernel bytes')
    const calls = []
    await expect(
      buildKernel(buildPlan(archive, out, image, context), (...args) => {
        calls.push(args)
        return ''
      }),
    ).rejects.toThrow('SHA256 mismatch')
    expect(calls).toEqual([])
    await expect(access(out)).rejects.toThrow()
  })
  await expect(access(root)).rejects.toThrow()
})
test('existing guest recipe kernel-only branch really dispatches without all-in-one work', async () => {
  const root = await withTestRoot(async (root) => {
    const archive = resolve(root, 'synthetic.tar.xz'),
      out = resolve(root, 'out')
    await writeFile(archive, 'NOT a kernel archive')
    const result = spawnSync(
      'sh',
      [
        'scripts/build-vm-guest.sh',
        '--kernel-only',
        archive,
        out,
        image,
        context,
      ],
      { encoding: 'utf8', timeout: 5000 },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Kernel archive SHA256 mismatch')
    await expect(access(out)).rejects.toThrow()
  })
  await expect(access(root)).rejects.toThrow()
})
test('x86 config requires built-in PCI devices filesystems vsock PTY and x86 boot support', () => {
  expect(() => validateConfig(fragment, finalConfig)).not.toThrow()
  for (const option of [
    '64BIT',
    'X86_64',
    'GENERIC_CPU',
    'SMP',
    'ACPI',
    'X86_LOCAL_APIC',
    'PCI',
    'PCI_MSI',
    'PCI_DIRECT',
    'VIRTIO_PCI',
    'VIRTIO_BLK',
    'VIRTIO_CONSOLE',
    'VIRTIO_FS',
    'VIRTIO_VSOCKETS',
    'VIRTIO_NET',
    'DEVTMPFS',
    'EXT4_FS',
    'UNIX98_PTYS',
    'BINFMT_ELF',
    'BINFMT_SCRIPT',
  ]) {
    expect(fragment).toContain(`CONFIG_${option}=y`)
    expect(() =>
      validateConfig(
        fragment,
        finalConfig.replace(
          `CONFIG_${option}=y`,
          `# CONFIG_${option} is not set`,
        ),
      ),
    ).toThrow('did not stick')
  }
  for (const option of ['MODULES', 'BLK_DEV_INITRD'])
    expect(() =>
      validateConfig(
        fragment,
        finalConfig.replace(
          `# CONFIG_${option} is not set`,
          `CONFIG_${option}=y`,
        ),
      ),
    ).toThrow('did not stick')
  expect(() =>
    validateConfig(fragment, finalConfig + '\nCONFIG_TEST_ONLY=m'),
  ).toThrow('modules')
  expect(fragment).not.toMatch(/PCI_HOST_GENERIC|RTC_DRV_PL031/)
})
test('kernel header validator rejects ELF ARM short and corrupted boot headers', () => {
  const header = Buffer.alloc(0x206)
  header.writeUInt16LE(0xaa55, 0x1fe)
  header.write('HdrS', 0x202)
  expect(() => validateBzImage(header)).not.toThrow()
  for (const bad of [
    Buffer.from('ELF fixture'),
    Buffer.alloc(0x206),
    header.subarray(0, 0x205),
  ])
    expect(() => validateBzImage(bad)).toThrow('bzImage')
  const corrupted = Buffer.from(header)
  corrupted[0x202] = 0
  expect(() => validateBzImage(corrupted)).toThrow('bzImage')
  // Synthetic header acceptance is format-validator evidence, never boot proof.
  expect(KERNEL_VERSION).toBe('6.12.112')
})

test('container recipe parses as shell without executing any command', () => {
  const r = spawnSync('sh', ['-n'], {
    input: CONTAINER_RECIPE.replace('JOB_COUNT', '2'),
    encoding: 'utf8',
  })
  expect(r.status).toBe(0)
  expect(r.stderr).toBe('')
})

test('kernel source and objects use an owned Linux scratch while only artifacts use host bind', () => {
  const plan = buildPlan('local.tar.xz', 'new-output', image, context)
  expect(plan.scratchVolume).toMatch(/^gild-vz-kernel-70-[a-f0-9-]{36}$/)
  expect(plan.args).toContain(
    `type=volume,source=${plan.scratchVolume},target=/build,volume-nocopy`,
  )
  expect(CONTAINER_RECIPE).toContain(
    'tar -xJf /inputs/linux.tar.xz -C /build/work',
  )
  expect(CONTAINER_RECIPE).not.toContain('/out/work')
  expect(CONTAINER_RECIPE).not.toContain('rm -rf')
  expect(CONTAINER_RECIPE).not.toContain('--absolute-names')
  expect(plan.args).not.toContain('--user=0:0')
  expect(plan.args.some((a) => a.startsWith('--cap-add'))).toBe(false)
})
test('scratch initialization mounts only the fresh volume and grants only ownership capability', () => {
  const plan = buildPlan('local.tar.xz', 'new-output', image, context),
    args = scratchPreparationArgs(plan)
  expect(args).toContain('--cap-drop=ALL')
  expect(args).toContain('--cap-add=CHOWN')
  expect(args).toContain('--network=none')
  expect(args).toContain('--pull=never')
  expect(args.filter((a) => a.startsWith('type=')).length).toBe(1)
  expect(args).toContain(
    `type=volume,source=${plan.scratchVolume},target=/build,volume-nocopy`,
  )
  expect(args.some((a) => a.startsWith('type=bind'))).toBe(false)
  expect(args.at(-1)).toBe(
    `chmod 700 /build && chown ${process.getuid()}:${process.getgid()} /build`,
  )
})
