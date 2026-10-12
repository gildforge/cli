// Exact canonical source remains untouched; proofs use owned temporary copies.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { prove } from './review-revert.mjs'
const root = '.tmp/runtime-support-consumer-removals'
mkdirSync(root, { recursive: true, mode: 0o700 })
const tracked = 'src/api/agent-profile-contract.ts',
  original = readFileSync(tracked),
  file = root + '/agent-profile-contract.ts'
copyFileSync(tracked, file)
copyFileSync(
  'src/api/agent-profile-canonical.ts',
  root + '/agent-profile-canonical.ts',
)
const prior = process.env.TEST_GILD_RUNTIME_SUPPORT_CONTRACT
process.env.TEST_GILD_RUNTIME_SUPPORT_CONTRACT = resolve(file)
const single = (s, before, after) => {
  if (s.split(before).length !== 2)
    throw Error('Expected one source guard: ' + before)
  return s.replace(before, after)
}
const cases = [
  [
    'unresolved-positive',
    (s) =>
      single(
        s,
        "value.status === 'verified' && (value.runtime.model === null || value.runtime.effort === null)",
        'false',
      ),
    'catalog rejects duplicate identities',
  ],
  [
    'report-digest',
    (s) => single(s, 'ref.digest !== await canonicalDigest(report)', 'false'),
    'catalog rejects mismatched report',
  ],
  [
    'evidence-reference',
    (s) => single(s, 'known.reference !== bound.reference', 'false'),
    'catalog rejects mismatched report',
  ],
  [
    'selection-digest',
    (s) => single(s, 'digest !== await canonicalDigest(selection)', 'false'),
    'catalog response validates digests',
  ],
  [
    'model-coverage',
    (s) =>
      single(
        s,
        'if (!selection.evidence.some(e => e.coverage.modelSelection === selection.coverage.modelSelection))',
        'if (false)',
      ),
    'catalog rejects mismatched report',
  ],
  [
    'runtime-tuple',
    (s) =>
      single(
        single(
          s,
          'canonicalJSON([selection.runtime, selection.harnessVersion])',
          'canonicalJSON(selection.harnessVersion)',
        ),
        'canonicalJSON([requested, requestedHarnessVersion])',
        'canonicalJSON(requestedHarnessVersion)',
      ),
    'catalog lookup refuses',
  ],
  [
    'harness-version',
    (s) =>
      single(
        single(
          s,
          'canonicalJSON([selection.runtime, selection.harnessVersion])',
          'canonicalJSON(selection.runtime)',
        ),
        'canonicalJSON([requested, requestedHarnessVersion])',
        'canonicalJSON(requested)',
      ),
    'catalog lookup refuses',
  ],
  [
    'owner-local-control',
    (s) => single(s, "control.trust !== 'owner-local-report'", 'true'),
    'catalog each positive control',
  ],
  [
    'delivery-coverage',
    (s) =>
      single(
        s,
        "boundReports.get(e.reportId)?.delivery.status === 'verified' && boundReports.get(e.reportId)!.delivery.modes.includes(mode)",
        'true',
      ),
    'catalog discovery cannot',
  ],
  [
    'response-report-identity',
    (s) =>
      single(
        s,
        'new Set(value.reports.map(row => row.report.reportId)).size !== value.reports.length',
        'false',
      ),
    'catalog response rejects identical',
  ],
  [
    'control-evidence-identity',
    (s) => single(s, 'control.evidenceIds.includes(e.evidenceId)', 'true'),
    'catalog each positive control',
  ],
  [
    'retained-data-freeze',
    (s) => single(s, 'Object.freeze(value)', 'void value'),
    'catalog prepared serving',
  ],
]
try {
  const evidence = cases.map(([name, mutate, pattern]) =>
    prove(
      'runtime-support-consumer-' + name,
      file,
      mutate,
      'src/api/runtime-support-data.test.ts',
      pattern,
    ),
  )
  if (
    !readFileSync(tracked).equals(original) ||
    !readFileSync(file).equals(original)
  )
    throw Error('Generated subject changed or temporary subject not restored')
  writeFileSync(
    '.tmp/runtime-support-consumer-revert-evidence.json',
    JSON.stringify(
      {
        canonicalCommit: 'e5502cddf259121263f2d6b11e6845e75c226c6c',
        outputSha256: createHash('sha256').update(original).digest('hex'),
        trackedUnchanged: true,
        temporaryRestored: true,
        evidence,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(JSON.stringify(evidence))
} finally {
  writeFileSync(file, original)
  if (prior === undefined) delete process.env.TEST_GILD_RUNTIME_SUPPORT_CONTRACT
  else process.env.TEST_GILD_RUNTIME_SUPPORT_CONTRACT = prior
}
