// Local-input, kernel-only builder for the existing VZ backend. Never pulls images,
// installs packages, creates a rootfs, or downloads a source archive.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const KERNEL_VERSION = '6.12.112'
// https://cdn.kernel.org/pub/linux/kernel/v6.x/sha256sums.asc
export const KERNEL_SHA256 =
  '164dc9d1f6c93c61a15e1f071c48379b467f2b17c469cce7223471968208ed03'
export const FRAGMENT = fileURLToPath(
  new URL('../guest-agent/kernel-x86_64-vz.config', import.meta.url),
)
const sha = (b) => createHash('sha256').update(b).digest('hex')
export function validateConfig(fragment, final) {
  for (const line of fragment.split('\n')) {
    if (!line.startsWith('CONFIG_')) continue
    const [name, value] = line.split('=')
    if (!['y', 'n'].includes(value))
      throw Error('Invalid fragment option: ' + line)
    const expected = value === 'y' ? line : `# ${name} is not set`
    if (!final.split('\n').includes(expected))
      throw Error('Kernel config did not stick: ' + line)
  }
  if (/^CONFIG_\w+=m$/m.test(final))
    throw Error('Kernel must not require modules')
}
export function validateBzImage(bytes) {
  if (
    bytes.length < 0x206 ||
    bytes.readUInt16LE(0x1fe) !== 0xaa55 ||
    bytes.toString('ascii', 0x202, 0x206) !== 'HdrS'
  )
    throw Error('Expected x86 Linux boot-protocol bzImage')
}
export function buildPlan(source, output, image, context, jobs = 2) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image ?? ''))
    throw Error('Builder must be an explicit local immutable sha256 image ID')
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4)
    throw Error('Build jobs must be 1..4')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context ?? ''))
    throw Error('An explicit local Docker context name is required')
  const archive = resolve(source),
    out = resolve(output)
  if ([archive, out, FRAGMENT].some((p) => /[,\n\r]/.test(p)))
    throw Error('Bind mount paths must not contain commas or newlines')
  const scratchVolume = 'gild-vz-kernel-70-' + randomUUID()
  return {
    scratchVolume,
    archive,
    out,
    image,
    context,
    jobs,
    args: [
      '--context',
      context,
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--platform=linux/amd64',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--cpus=' + jobs,
      '--memory=4g',
      '--pids-limit=512',
      '--cidfile=' + resolve(out, 'container.cid'),
      '--tmpfs=/tmp:rw,nosuid,nodev,size=128m',
      '--user=' + process.getuid() + ':' + process.getgid(),
      '--mount',
      `type=bind,source=${archive},target=/inputs/linux.tar.xz,readonly`,
      '--mount',
      `type=bind,source=${resolve(out, 'kernel.fragment')},target=/inputs/fragment,readonly`,
      '--mount',
      `type=bind,source=${out},target=/out`,
      '--mount',
      `type=volume,source=${scratchVolume},target=/build,volume-nocopy`,
      '--entrypoint=sh',
      image,
      '-eu',
      '/out/build.sh',
    ],
  }
}
// Only the fresh empty Linux volume is mounted for ownership initialization.
// The actual compiler keeps the normal unprivileged user and all capabilities dropped.
export function scratchPreparationArgs(plan) {
  return [
    '--context',
    plan.context,
    'run',
    '--rm',
    '--pull=never',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--cap-add=CHOWN',
    '--security-opt=no-new-privileges',
    '--cpus=2',
    '--memory=256m',
    '--pids-limit=64',
    '--user=0:0',
    '--mount',
    `type=volume,source=${plan.scratchVolume},target=/build,volume-nocopy`,
    '--entrypoint=sh',
    plan.image,
    '-eu',
    '-c',
    `chmod 700 /build && chown ${process.getuid()}:${process.getgid()} /build`,
  ]
}
export const CONTAINER_RECIPE = `
[ "$(uname -m)" = x86_64 ] || { echo 'Native x86_64 builder required' >&2; exit 1; }
for tool in gcc make ld as ar nm objcopy objdump readelf flex bison bc perl python3 tar xz sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing builder tool: $tool" >&2; exit 1; }
done
printf '%s  /inputs/linux.tar.xz\\n' '${KERNEL_SHA256}' | sha256sum -c -
mkdir /build/work
tar -xJf /inputs/linux.tar.xz -C /build/work
cd /build/work/linux-${KERNEL_VERSION}
KCONFIG_ALLCONFIG=/inputs/fragment make -s ARCH=x86 allnoconfig
while IFS='=' read -r name value; do
  case "$name" in CONFIG_*) ;; *) continue ;; esac
  case "$value" in
    y) expected="$name=y" ;;
    n) expected="# $name is not set" ;;
    *) exit 1 ;;
  esac
  grep -Fqx "$expected" .config || { echo "Kernel config did not stick: $name=$value" >&2; exit 1; }
done < /inputs/fragment
if grep -Eq '^CONFIG_[A-Z0-9_]+=m$' .config; then echo 'Modules are unsupported' >&2; exit 1; fi
# Caller jobs are bounded in the host plan; this never installs build dependencies.
make -s ARCH=x86 -jJOB_COUNT bzImage
readelf -h vmlinux > /out/vmlinux-header.txt
grep -Eq 'Class: +ELF64' /out/vmlinux-header.txt
grep -Eq 'Machine: +Advanced Micro Devices X86-64' /out/vmlinux-header.txt
cp arch/x86/boot/bzImage /out/bzImage
cp .config /out/bzImage.config
{ gcc --version; ld --version; make --version; } > /out/toolchain.txt
# Retain this OWNED scratch volume and failed attempts; no broad cleanup.
`
export async function buildKernel(plan, run = execFileSync) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(plan.archive)) hash.update(chunk)
  if (hash.digest('hex') !== KERNEL_SHA256)
    throw Error('Kernel archive SHA256 mismatch')
  const endpoint = JSON.parse(
    run(
      'docker',
      [
        '--context',
        plan.context,
        'context',
        'inspect',
        plan.context,
        '--format',
        '{{json .Endpoints.docker.Host}}',
      ],
      { encoding: 'utf8' },
    ).trim(),
  )
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///'))
    throw Error(
      'Kernel build requires a local Unix-socket Docker context, not a remote host',
    )
  const inspected = run(
    'docker',
    [
      '--context',
      plan.context,
      'image',
      'inspect',
      '--format',
      '{{.Os}}/{{.Architecture}} {{.Id}}',
      plan.image,
    ],
    { encoding: 'utf8' },
  ).trim()
  if (inspected !== 'linux/amd64 ' + plan.image)
    throw Error(
      'Builder must already exist locally as linux/amd64 with the exact image ID',
    )
  // Exclusive directory: no stale-output adoption, rootfs overwrite or global cache.
  await mkdir(plan.out, { mode: 0o700 })
  const fragment = await readFile(FRAGMENT, 'utf8')
  await writeFile(resolve(plan.out, 'kernel.fragment'), fragment, {
    mode: 0o400,
    flag: 'wx',
  })
  await writeFile(
    resolve(plan.out, 'build.sh'),
    CONTAINER_RECIPE.replace('JOB_COUNT', String(plan.jobs)),
    { mode: 0o400, flag: 'wx' },
  )
  const createdVolume = run(
    'docker',
    [
      '--context',
      plan.context,
      'volume',
      'create',
      '--driver=local',
      '--label=gild.cli.issue=70',
      plan.scratchVolume,
    ],
    { encoding: 'utf8' },
  ).trim()
  if (createdVolume !== plan.scratchVolume)
    throw Error('Unexpected scratch volume')
  await writeFile(
    resolve(plan.out, 'scratch-volume.json'),
    JSON.stringify(
      {
        name: plan.scratchVolume,
        ownerUid: process.getuid(),
        ownerGid: process.getgid(),
        retain: true,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  )
  run('docker', scratchPreparationArgs(plan), { stdio: 'inherit' })
  run('docker', plan.args, { stdio: 'inherit' })
  const kernel = await readFile(resolve(plan.out, 'bzImage'))
  const config = await readFile(resolve(plan.out, 'bzImage.config'), 'utf8')
  const header = await readFile(resolve(plan.out, 'vmlinux-header.txt'), 'utf8')
  validateBzImage(kernel)
  validateConfig(fragment, config)
  if (
    !/Class:\s+ELF64/.test(header) ||
    !/Machine:\s+Advanced Micro Devices X86-64/.test(header)
  )
    throw Error('Expected ELF64 x86_64 built kernel')
  const toolchain = await readFile(resolve(plan.out, 'toolchain.txt'), 'utf8')
  const evidence = {
    version: KERNEL_VERSION,
    sourceSha256: KERNEL_SHA256,
    architecture: 'x86_64',
    builderImageId: plan.image,
    dockerContext: plan.context,
    dockerEndpoint: endpoint,
    jobs: plan.jobs,
    scratchVolume: plan.scratchVolume,
    workspaceFilesystem:
      'Owned case-sensitive Linux local volume on the existing Docker filesystem',
    scratchRetained: true,
    fragmentSha256: sha(fragment),
    recipeSha256: sha(CONTAINER_RECIPE.replace('JOB_COUNT', String(plan.jobs))),
    kernelSha256: sha(kernel),
    finalConfigSha256: sha(config),
    toolchain,
    network: 'none',
    rootfsBuilt: false,
    scope:
      'Kernel build only; guest protocol, Ubuntu rootfs/tooling, VZ boot and real skill/model execution not verified.',
  }
  await writeFile(
    resolve(plan.out, 'kernel-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx' },
  )
  console.log('Built Intel VZ kernel: ' + resolve(plan.out, 'bzImage'))
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const [source, output, image, context, jobs, ...extra] = process.argv.slice(2)
  if (!source || !output || !image || !context || extra.length) {
    console.error(
      'Usage: scripts/build-vm-guest.sh --kernel-only <local-linux-6.12.112.tar.xz> <NEW-output-directory> <local-sha256:image-id> <local-docker-context> [jobs=2]',
    )
    process.exitCode = 1
  } else {
    try {
      await buildKernel(
        buildPlan(
          source,
          output,
          image,
          context,
          jobs === undefined ? 2 : Number(jobs),
        ),
      )
    } catch (e) {
      console.error(e.message)
      process.exitCode = 1
    }
  }
}
