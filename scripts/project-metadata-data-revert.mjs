// Canonical generated output is immutable; use an owned temporary subject only.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { prove } from './review-revert.mjs'
const root = '.tmp/project-metadata-consumer-removals'
mkdirSync(root, { recursive: true, mode: 0o700 })
const tracked = 'src/api/agent-profile-contract.ts',
  original = readFileSync(tracked),
  file = root + '/agent-profile-contract.ts'
copyFileSync(tracked, file)
copyFileSync(
  'src/api/agent-profile-canonical.ts',
  root + '/agent-profile-canonical.ts',
)
const prior = process.env.TEST_GILD_PROJECT_METADATA_CONTRACT
process.env.TEST_GILD_PROJECT_METADATA_CONTRACT = resolve(file)
const single = (s, before, after) => {
  if (s.split(before).length !== 2) throw Error('Expected one guard: ' + before)
  return s.replace(before, after)
}
const cases = [
  [
    'opaque-id',
    (s) =>
      single(
        s,
        'const agentProjectId = identifier',
        'const agentProjectId = z.string()',
      ),
    'project identifiers are opaque',
  ],
  [
    'unresolved-private-details',
    (s) =>
      single(
        s,
        "const unresolvedAgentProject = z.object({ projectId: agentProjectId, resolution: z.literal('unresolved') }).strict()",
        "const unresolvedAgentProject = z.object({ projectId: agentProjectId, resolution: z.literal('unresolved') })",
      ),
    'project unresolved branch forbids',
  ],
  [
    'ordered-unique-refs',
    (s) => single(s, 'sortedUnique(refs.map(ref => ref.projectId))', 'true'),
    'project identifiers are opaque',
  ],
  [
    'state-validation',
    (s) =>
      single(
        s,
        "state: z.enum(['ready', 'pending', 'archived'])",
        'state: z.string()',
      ),
    'project resolved metadata validates',
  ],
  [
    'listing-null-support',
    (s) =>
      single(
        s,
        'agentProject: agentProjectReferenceSchema.nullable().optional()',
        'agentProject: agentProjectReferenceSchema.optional()',
      ),
    'project listing metadata retains',
  ],
  [
    'profile-null-denial',
    (s) =>
      single(
        s,
        "'Project references must be unique and sorted by exact ID').optional()",
        "'Project references must be unique and sorted by exact ID').nullable().optional()",
      ),
    'project profile metadata is optional',
  ],
]
try {
  const evidence = cases.map(([name, mutate, pattern]) =>
    prove(
      'project-metadata-consumer-' + name,
      file,
      mutate,
      'src/api/project-metadata-data.test.ts',
      pattern,
    ),
  )
  if (
    !readFileSync(tracked).equals(original) ||
    !readFileSync(file).equals(original)
  )
    throw Error('Generated subject changed or temporary subject not restored')
  writeFileSync(
    '.tmp/project-metadata-consumer-revert-evidence.json',
    JSON.stringify(
      {
        canonicalCommit: '96926393d91bb61f302a788ba369c1144a00bf47',
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
  if (prior === undefined)
    delete process.env.TEST_GILD_PROJECT_METADATA_CONTRACT
  else process.env.TEST_GILD_PROJECT_METADATA_CONTRACT = prior
}
