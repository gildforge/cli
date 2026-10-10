// Disable each published-VM-image safeguard in turn and require its test in
// src/isolation/image.test.ts to fail. Source is always restored; transcripts
// go to .tmp/revert-vm-image-*.log.
//   node scripts/vm-image-revert.mjs [name filter]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const image = 'src/isolation/image.ts'
const index = 'src/isolation/index.ts'
const mutations = [
  [
    'packed sha256',
    image,
    [
      [
        'if (got !== want.sha256 || packed.bytes() !== want.size)',
        'if (false)',
      ],
    ],
    'sha256 is not the manifest one',
  ],
  [
    'unpacked sha256',
    image,
    [['gotUnpacked !== want.unpacked.sha256 ||', 'false &&']],
    'different unpacked bytes',
  ],
  [
    'version',
    image,
    [['if (manifest.version !== version)', 'if (false)']],
    'another gild version',
  ],
  [
    'protocol',
    image,
    [['if (manifest.protocol !== GUEST_PROTOCOL)', 'if (false)']],
    'another guest protocol',
  ],
  [
    'offline cache',
    image,
    [
      [
        "if (releaseImageInstalled(o.configDir, version, platform)) return 'installed'",
        '',
      ],
    ],
    'works offline when cached',
  ],
  [
    'hand-built image',
    image,
    [["if (localImageInstalled(o.configDir)) return 'local'", '']],
    'hand-built image',
  ],
  [
    'fallback',
    index,
    [['      !vmUnavailable ||', '      true ||']],
    'falls to the next tier',
  ],
]
mkdirSync('.tmp', { recursive: true })
let failed = 0
for (const [name, file, replacements, filter] of mutations) {
  if (
    process.argv[2] &&
    !name.toLowerCase().includes(process.argv[2].toLowerCase())
  )
    continue
  const original = readFileSync(file, 'utf8')
  for (const [from] of replacements)
    if (!original.includes(from))
      throw new Error(`Missing mutation anchor: ${name}`)
  try {
    writeFileSync(
      file,
      replacements.reduce(
        (text, [from, to]) => text.replace(from, to),
        original,
      ),
    )
    const result = spawnSync(
      'bun',
      ['test', 'src/isolation/image.test.ts', '-t', filter],
      { encoding: 'utf8', timeout: 60000 },
    )
    writeFileSync(
      `.tmp/revert-vm-image-${name.replace(/[^a-z0-9]+/gi, '-')}.log`,
      result.stdout + result.stderr,
    )
    if (result.error || result.status === 0) {
      failed++
      console.log(`${name}: NOT caught (${result.error ?? 'test passed'})`)
    } else
      console.log(
        `${name}: test failed with the safeguard reverted (exit ${result.status})`,
      )
  } finally {
    writeFileSync(file, original)
  }
}
process.exit(failed ? 1 : 0)
