// Focused owned-source removals; canonical generated artifacts are untouched.
import { mkdirSync, writeFileSync } from 'node:fs'
import { prove } from './review-revert.mjs'
const suite = 'src/skills/bundle-cache.test.ts'
const cases = [
  [
    'complete-inventory',
    'src/skills/bundle-inventory.ts',
    (s) => s.replaceAll('    exactNames(at, tree)', '    void at'),
    'undeclared files directories',
  ],
  [
    'file-digest',
    'src/skills/bundle-inventory.ts',
    (s) =>
      s.replace(
        'verifySkillBytes(entry, at.readRegular(name, entry.size))',
        'at.readRegular(name, entry.size)',
      ),
    'physical inventory rejects missing and corrupt license',
  ],
  [
    'directory-no-follow',
    'src/isolation/anchored-fs.ts',
    (s) => {
      const a = s.indexOf('  directory(name:'),
        b = s.indexOf('  parent(rel:', a)
      return (
        s.slice(0, a) +
        s.slice(a, b).replace('constants.O_NOFOLLOW', '0') +
        s.slice(b)
      )
    },
    'inventory refuses escaping root',
  ],
  [
    'manifest-lock',
    'src/skills/bundle-tree.ts',
    (s) =>
      s.replace(
        '!raw.equals(Buffer.from(canonicalBytes(binding.manifest)))',
        'false',
      ),
    'existing incomplete corrupt',
  ],
  [
    'staged-recheck',
    'src/skills/bundle-cache.ts',
    (s) =>
      s.replace(
        '      readBundleAt(namespace, name, binding)',
        '      void name',
      ),
    'staged bytes are reverified',
  ],
  [
    'atomic-no-replace',
    'src/isolation/anchored-fs.ts',
    (s) => {
      const a = s.indexOf('  publishDirectory('),
        b = s.indexOf('  directory(name:', a)
      return (
        s.slice(0, a) +
        s.slice(a, b).replace("process.platform === 'darwin' ? 4 : 1", '0') +
        s.slice(b)
      )
    },
    'atomic directory publication',
  ],
]
const evidence = cases.map(([name, file, mutate, pattern]) =>
  prove('bundle-' + name, file, mutate, suite, pattern),
)
mkdirSync('.tmp', { recursive: true })
writeFileSync(
  '.tmp/bundle-cache-revert-evidence.json',
  JSON.stringify(evidence, null, 2) + '\n',
)
console.log(JSON.stringify(evidence))
