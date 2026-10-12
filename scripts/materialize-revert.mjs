// Owned local materialization checks only; generated canonical files untouched.
import { mkdirSync, writeFileSync } from 'node:fs'
import { prove } from './review-revert.mjs'
const file = 'src/skills/materialize.ts',
  suite = 'src/skills/materialize.test.ts'
const cases = [
  [
    'cache-separation',
    (s) => s.replace('    cache.assertSeparateDirectory(run)', '    void run'),
    'materialization cannot write into',
  ],
  [
    'preflight-before-write',
    (s) =>
      s.replace(
        'prepareSelectedSkillBytes(binding.specs, contents.files)',
        'contents.files',
      ),
    'complete copied byte preflight',
  ],
  [
    'private-readonly-files',
    (s) =>
      s.replace(
        'writeBundleDirectory(stage, binding, files, true)',
        'writeBundleDirectory(stage, binding, files, false)',
      ),
    'private materialization retains',
  ],
  [
    'staged-recheck',
    (s) => s.replace('    readBundleAt(run, name, binding)', '    void name'),
    'corrupt staged materialization',
  ],
  [
    'collision-no-adoption',
    (s) =>
      s.replace(
        'if (!run.publishDirectory(name, SELECTED))',
        'if (run.publishDirectory(name, SELECTED) && false)',
      ),
    'a publication collision never adopts',
  ],
]
const evidence = cases.map(([name, mutate, pattern]) =>
  prove('materialize-' + name, file, mutate, suite, pattern),
)
mkdirSync('.tmp', { recursive: true })
writeFileSync(
  '.tmp/materialize-revert-evidence.json',
  JSON.stringify(evidence, null, 2) + '\n',
)
console.log(JSON.stringify(evidence))
