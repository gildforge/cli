// Focused removal proofs only. Every source is restored in prove's finally.
import { mkdirSync, writeFileSync } from 'node:fs'
import { prove } from './review-revert.mjs'
const local = 'src/skills/local-bytes.ts'
const native = 'src/isolation/anchored-fs.ts'
const suite = 'src/skills/local-bytes.test.ts'
const cases = [
  [
    'byte-digest',
    local,
    (s) =>
      s.replace(
        "createHash('sha256').update(bytes).digest('hex') !== spec.sha256",
        'false',
      ),
    'candidate fails without',
  ],
  [
    'traversal',
    local,
    (s) => {
      const a = s.indexOf('export function validateSkillPath('),
        b = s.indexOf('\nfunction validateExpected', a)
      return (
        s.slice(0, a) +
        'export function validateSkillPath(path: string) { return path }\n' +
        s.slice(b)
      )
    },
    'traversal never reads',
  ],
  [
    'directory-no-follow',
    native,
    (s) => {
      const a = s.indexOf('  directory(name:'),
        b = s.indexOf('  parent(rel:', a)
      return (
        s.slice(0, a) +
        s.slice(a, b).replace('constants.O_NOFOLLOW', '0') +
        s.slice(b)
      )
    },
    'symlinked root/ancestor',
  ],
  [
    'collision',
    local,
    (s) => s.replace('        old &&', '        false &&'),
    'case aliases are rejected',
  ],
  [
    'offline-recheck',
    local,
    (s) => {
      const a = s.indexOf('  read(spec:'),
        b = s.indexOf('  store(spec:', a)
      return (
        s.slice(0, a) +
        s
          .slice(a, b)
          .replace(
            'return verifySkillBytes(spec, this.root.readRegular(spec.sha256, spec.size))',
            'return this.root.readRegular(spec.sha256, spec.size)',
          ) +
        s.slice(b)
      )
    },
    'corrupt offline object fails',
  ],
  [
    'license',
    'src/skills/ecc-candidate.ts',
    (s) =>
      s.replace(
        /    Object.freeze\(\{\n      path: 'LICENSE',[\s\S]*?    \}\),\n/,
        '',
      ),
    'candidate fails without',
  ],
  [
    'no-replace',
    native,
    (s) => s.replace("process.platform === 'darwin' ? 4 : 1", '0'),
    'atomic complete-byte publication',
  ],
]
cases.push([
  'private-mode',
  native,
  (s) => s.replace('fchmodSync(fd, 0o600)', 'void fd'),
  'byte publication establishes private permissions',
])
cases.push([
  'interrupted-publication',
  native,
  (s) =>
    s
      .replace(
        "process.platform === 'darwin' ? 'renameatx_np' : 'renameat2'",
        "'linkat'",
      )
      .replace("process.platform === 'darwin' ? 4 : 1", '0'),
  'interruption immediately after publication',
])
cases.push([
  'assertion-diagnostic',
  'scripts/review-revert.mjs',
  (s) =>
    s.replace(
      '!/^error: expect\\((received|function)\\)/m.test(stderr)',
      "!stderr.includes('expect(')",
    ),
  'removal evidence rejects',
])
const evidence = cases.map(([name, file, mutate, pattern]) =>
  prove('skill-bytes-' + name, file, mutate, suite, pattern),
)
mkdirSync('.tmp', { recursive: true })
writeFileSync(
  '.tmp/skill-bytes-revert-evidence.json',
  JSON.stringify(evidence, null, 2) + '\n',
)
console.log(JSON.stringify(evidence))
