// Never mutate tracked canonical bytes: removal subjects are owned temporary copies.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { prove } from './review-revert.mjs'
const root = '.tmp/assignment-consumer-removals'
mkdirSync(root, { recursive: true, mode: 0o700 })
const tracked = 'src/api/agent-profile-contract.ts',
  original = readFileSync(tracked),
  file = root + '/agent-profile-contract.ts'
copyFileSync(tracked, file)
copyFileSync(
  'src/api/agent-profile-canonical.ts',
  root + '/agent-profile-canonical.ts',
)
const prior = process.env.TEST_GILD_ASSIGNMENT_CONTRACT
process.env.TEST_GILD_ASSIGNMENT_CONTRACT = resolve(file)
const single = (s, before, after) => {
  if (s.split(before).length !== 2) throw Error('Expected one guard: ' + before)
  return s.replace(before, after)
}
const cases = [
  [
    'requester',
    'task.requesterIdentityId !== policy.coordinatorIdentityId',
    'false',
    'assignment relationship rejects requester',
  ],
  [
    'project',
    '!policy.projectIds.includes(task.projectId)',
    'false',
    'assignment relationship rejects project',
  ],
  [
    'mode',
    'task.deliveryMode !== selected?.deliveryMode || task.deliveryMode !== request.deliveryMode',
    'false',
    'assignment relationship rejects mode',
  ],
  [
    'policy-digest',
    'task.sourcePolicyDigest !== await canonicalDigest(policy)',
    'false',
    'assignment relationship rejects source-digest',
  ],
  [
    'consent',
    'task.ownerConsentRevisionId !== policy.ownerConsentRevisionId',
    'false',
    'assignment relationship rejects consent',
  ],
  [
    'audience',
    'canonicalJSON(task.readerIdentityIds) !== canonicalJSON(selected?.readerIdentityIds)',
    'false',
    'assignment relationship rejects audience',
  ],
  [
    'grant',
    'receipt.grantId !== task.grantId',
    'false',
    'assignment relationship rejects grant$',
  ],
  [
    'grant-revision',
    'receipt.grantRevisionId !== task.grantRevisionId',
    'false',
    'assignment relationship rejects grant-revision',
  ],
  [
    'task-digest',
    'receipt.taskDigest !== await canonicalDigest(task)',
    'false',
    'assignment relationship rejects task-digest',
  ],
  [
    'profile-digest',
    'await canonicalDigest(profile) !== policy.profileDigest',
    'false',
    'assignment profile verifier binds full',
  ],
  [
    'profile-project',
    'policy.projectIds.some(id => ![...profile.desiredControls.filesystem.readProjectIds, ...profile.desiredControls.filesystem.writeProjectIds].includes(id))',
    'false',
    'assignment profile verifier binds full',
  ],
  [
    'bounded-expiry',
    'Date.parse(policy.expiresAt) > Date.parse(value.createdAt) + 86400000',
    'false',
    'assignment policy bounds allowance',
  ],
  [
    'false-launch',
    'launchAuthority: z.literal(false), executionAuthority: z.literal(false)',
    'launchAuthority: z.boolean(), executionAuthority: z.literal(false)',
    'assignment receipt requires explicit false',
  ],
  [
    'false-execution',
    'launchAuthority: z.literal(false), executionAuthority: z.literal(false)',
    'launchAuthority: z.literal(false), executionAuthority: z.boolean()',
    'assignment receipt requires explicit false',
  ],
]
try {
  const evidence = cases.map(([name, before, after, pattern]) =>
    prove(
      'assignment-consumer-' + name,
      file,
      (s) => single(s, before, after),
      'src/api/agent-assignment-data.test.ts',
      pattern,
    ),
  )
  if (
    !readFileSync(tracked).equals(original) ||
    !readFileSync(file).equals(original)
  )
    throw Error('Generated subject changed or temporary subject not restored')
  writeFileSync(
    '.tmp/assignment-consumer-revert-evidence.json',
    JSON.stringify(
      {
        canonicalCommit: '3840f4526a9cf6c133ea1e1cca04befb5645abaa',
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
  if (prior === undefined) delete process.env.TEST_GILD_ASSIGNMENT_CONTRACT
  else process.env.TEST_GILD_ASSIGNMENT_CONTRACT = prior
}
