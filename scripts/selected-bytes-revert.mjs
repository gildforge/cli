// Owned CLI adapter removals; generated canonical artifacts are never mutated.
import { mkdirSync, writeFileSync } from 'node:fs'
import { prove } from './review-revert.mjs'
const file = 'src/skills/selected-bytes.ts'
const suite = 'src/skills/selected-bytes.test.ts'
const cases = [
  [
    'portable-path-boundary',
    (s) =>
      s.replace(
        'const specs = validateSkillFiles(',
        'const specs = Array.from(',
      ),
    'canonical selection still rejects locally unsupported',
  ],
  [
    'immutable-selection',
    (s) =>
      s.replace(
        'const pin = await verifySkillSelection(selection, identity.manifest)',
        'const pin = selection as any',
      ),
    'stale bundle or entry',
  ],
  [
    'exact-byte-set',
    (s) =>
      s
        .replace(
          '  if (\n    provided.size',
          '  if (false && (\n    provided.size',
        )
        .replace(
          "  )\n    throw new SkillByteError('skill byte set",
          "  ))\n    throw new SkillByteError('skill byte set",
        ),
    'undeclared or missing',
  ],
  [
    'verify-before-publish',
    (s) => s.replace('verifySkillBytes(spec, bytes)', 'Buffer.from(bytes)'),
    'all supplied bytes are verified',
  ],
]
const evidence = cases.map(([name, mutate, pattern]) =>
  prove('selected-bytes-' + name, file, mutate, suite, pattern),
)
mkdirSync('.tmp', { recursive: true })
writeFileSync(
  '.tmp/selected-bytes-revert-evidence.json',
  JSON.stringify(evidence, null, 2) + '\n',
)
console.log(JSON.stringify(evidence))
