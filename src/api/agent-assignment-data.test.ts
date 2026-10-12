import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalBytes, canonicalDigest } from './agent-profile-canonical'
import type {
  AgentAssignmentInput,
  AgentAssignmentReceipt,
  AgentTask,
  OwnerAssignmentPolicy,
} from './agent-profile-contract'
// Removal proofs import owned temporary copies; production artifacts stay exact.
const C: typeof import('./agent-profile-contract') = await import(
  process.env.TEST_GILD_ASSIGNMENT_CONTRACT ??
    resolve('src/api/agent-profile-contract.ts')
)
const frozen = readFileSync(
  'scripts/fixtures/skills/agent-profile-revision-v1.json',
)
const coordinator = '33333333-3333-4333-8333-333333333333'
async function fixture(mode: 'interactive' | 'piped' = 'interactive') {
  const profile = C.parseProfileRevision(JSON.parse(frozen.toString()))
  const policy: OwnerAssignmentPolicy = {
    contractVersion: 1,
    policyId: 'policy-1',
    revisionId: 'policy-rev-1',
    ownerConsentRevisionId: 'consent-1',
    ownerIdentityId: profile.ownerIdentityId,
    targetAgentIdentityId: profile.agentIdentityId,
    createdAt: '2026-10-12T12:00:00.000Z',
    profileDigest: await canonicalDigest(profile),
    ancestors: [],
    coordinatorIdentityId: coordinator,
    projectIds: ['project-1'],
    actions: ['task.execute'],
    expiresAt: null,
    requesterIdentityIds: [],
    assignmentPolicy: {
      profileRevisionId: profile.revisionId,
      deliveryMode: mode,
      maxTaskExecutions: 2,
      expiresAt: '2026-10-12T13:00:00.000Z',
      readerIdentityIds: [
        profile.ownerIdentityId,
        profile.agentIdentityId,
      ].sort(),
    },
  }
  const request: AgentAssignmentInput = {
    contractVersion: 1,
    assignmentRequestId: 'R',
    expectedCoordinationRevisionId: policy.revisionId,
    targetAgentIdentityId: profile.agentIdentityId,
    projectId: 'project-1',
    action: 'task.execute',
    profileRevisionId: profile.revisionId,
    deliveryMode: mode,
    instruction: 'Inspect the pinned input.',
    context: [],
  }
  const task: AgentTask = {
    contractVersion: 1,
    taskId: 'task-1',
    taskRevisionId: 'task-rev-1',
    requesterIdentityId: coordinator,
    ownerIdentityId: profile.ownerIdentityId,
    targetAgentIdentityId: profile.agentIdentityId,
    projectId: request.projectId,
    action: 'task.execute',
    profileRevisionId: profile.revisionId,
    deliveryMode: mode,
    instruction: request.instruction,
    context: [],
    createdAt: '2026-10-12T12:05:00.000Z',
    expiresAt: policy.assignmentPolicy!.expiresAt,
    readerIdentityIds: [...policy.assignmentPolicy!.readerIdentityIds],
    grantId: 'grant-1',
    grantRevisionId: 'grant-rev-1',
    authorizationSource: 'own-coordinator',
    sourcePolicyId: policy.policyId,
    sourcePolicyRevisionId: policy.revisionId,
    sourcePolicyDigest: await canonicalDigest(policy),
    ownerConsentRevisionId: policy.ownerConsentRevisionId,
  }
  const receipt: AgentAssignmentReceipt = {
    contractVersion: 1,
    assignmentRequestId: request.assignmentRequestId,
    taskId: task.taskId,
    taskRevisionId: task.taskRevisionId,
    taskDigest: await canonicalDigest(task),
    decision: 'assigned',
    grantId: task.grantId,
    grantRevisionId: task.grantRevisionId,
    sourcePolicyId: task.sourcePolicyId,
    sourcePolicyRevisionId: task.sourcePolicyRevisionId,
    sourcePolicyDigest: task.sourcePolicyDigest,
    launchAuthority: false,
    executionAuthority: false,
  }
  return { profile, policy, request, task, receipt }
}
function checkError(error: unknown, code = 'VALIDATION_FAILED', status = 422) {
  expect(error).toBeInstanceOf(C.AgentProfileContractError)
  expect({
    code: (error as InstanceType<typeof C.AgentProfileContractError>).code,
    status: (error as InstanceType<typeof C.AgentProfileContractError>).status,
  }).toEqual({ code, status })
}
function fault(action: () => unknown, code?: string, status?: number) {
  let error: unknown
  try {
    action()
  } catch (e) {
    error = e
  }
  checkError(error, code, status)
}
async function rejected(action: () => Promise<unknown>) {
  let error: unknown
  try {
    await action()
  } catch (e) {
    error = e
  }
  checkError(error)
}

test('assignment full chain uses both canonical verifiers for interactive and piped data', async () => {
  for (const mode of ['interactive', 'piped'] as const) {
    const f = await fixture(mode)
    expect(
      await C.verifyOwnerAssignmentPolicyProfile(f.policy, f.profile),
    ).toEqual(f.policy)
    expect(
      await C.verifyAgentAssignmentArtifacts(
        f.task,
        f.policy,
        f.request,
        f.receipt,
      ),
    ).toEqual(f.receipt)
    expect(C.parseAgentTask(f.task).grantRevisionId).toBe('grant-rev-1')
    expect(C.parseAgentAssignmentReceipt(f.receipt)).toMatchObject({
      launchAuthority: false,
      executionAuthority: false,
    })
  }
})
test('assignment request own precondition precedes body and never invokes accessors', async () => {
  const f = await fixture(),
    { expectedCoordinationRevisionId: _, ...omitted } = f.request
  fault(
    () => C.parseAgentAssignmentInput(omitted, f.policy.revisionId),
    'PRECONDITION_REQUIRED',
    428,
  )
  fault(
    () =>
      C.parseAgentAssignmentInput(
        Object.assign(
          Object.create({
            expectedCoordinationRevisionId: f.policy.revisionId,
          }),
          omitted,
        ),
        f.policy.revisionId,
      ),
    'PRECONDITION_REQUIRED',
    428,
  )
  fault(
    () =>
      C.parseAgentAssignmentInput(
        {
          ...f.request,
          expectedCoordinationRevisionId: 'old',
          instruction: '\ud800',
          extra: true,
        },
        f.policy.revisionId,
      ),
    'REVISION_STALE',
    412,
  )
  for (const bad of [null, undefined, -1, '', 'bad/revision'])
    fault(() =>
      C.parseAgentAssignmentInput(
        { ...f.request, expectedCoordinationRevisionId: bad },
        f.policy.revisionId,
      ),
    )
  let calls = 0
  const accessor = Object.defineProperty(
    { ...omitted },
    'expectedCoordinationRevisionId',
    {
      enumerable: true,
      get() {
        calls++
        return f.policy.revisionId
      },
    },
  )
  fault(() => C.parseAgentAssignmentInput(accessor, f.policy.revisionId))
  expect(calls).toBe(0)
  fault(() =>
    C.parseAgentAssignmentInput(
      { ...f.request, extra: true },
      f.policy.revisionId,
    ),
  )
})
test('assignment replacement requires explicit revision and closed policy stays closed', async () => {
  const closed = {
    contractVersion: 1,
    expectedRevisionId: null,
    coordinatorIdentityId: null,
    projectIds: [],
    actions: ['task.execute'],
    expiresAt: null,
    requesterIdentityIds: [],
    assignmentPolicy: null,
  }
  expect(
    C.parseReplaceAgentCoordination(closed, null).assignmentPolicy,
  ).toBeNull()
  const { expectedRevisionId: _, ...omitted } = closed
  fault(
    () => C.parseReplaceAgentCoordination(omitted, null),
    'PRECONDITION_REQUIRED',
    428,
  )
  fault(
    () =>
      C.parseReplaceAgentCoordination(
        { ...closed, expectedRevisionId: 'old', extra: true },
        'current',
      ),
    'REVISION_STALE',
    412,
  )
  const f = await fixture()
  expect(
    C.parseOwnerAssignmentPolicy({
      ...f.policy,
      assignmentPolicy: null,
      profileDigest: null,
    }).assignmentPolicy,
  ).toBeNull()
  fault(() =>
    C.parseOwnerAssignmentPolicy({ ...f.policy, assignmentPolicy: null }),
  )
  await rejected(() =>
    C.verifyOwnerAssignmentPolicyProfile(
      { ...f.policy, assignmentPolicy: null, profileDigest: null },
      f.profile,
    ),
  )
})
test('assignment receipt requires explicit false authority and rejects permits credentials extras', async () => {
  const f = await fixture()
  for (const field of ['launchAuthority', 'executionAuthority']) {
    const omitted: Record<string, unknown> = { ...f.receipt }
    delete omitted[field]
    fault(() => C.parseAgentAssignmentReceipt(omitted))
    fault(() => C.parseAgentAssignmentReceipt({ ...f.receipt, [field]: true }))
  }
  for (const extra of [
    { deliveryAuthority: true },
    { kind: 'fresh_launch' },
    { token: 'synthetic-only' },
  ])
    fault(() => C.parseAgentAssignmentReceipt({ ...f.receipt, ...extra }))
})
test('assignment policy bounds allowance expiry explicit audience ancestors and mode', async () => {
  const f = await fixture(),
    selected = f.policy.assignmentPolicy!
  for (const extra of [
    { maxTaskExecutions: 0 },
    { maxTaskExecutions: 33 },
    { maxTaskExecutions: 1.5 },
    { expiresAt: '2026-10-14T13:00:00.000Z' },
    { expiresAt: f.policy.createdAt },
    { readerIdentityIds: [f.profile.ownerIdentityId, coordinator].sort() },
    { readerIdentityIds: [...selected.readerIdentityIds].reverse() },
    {
      readerIdentityIds: [f.profile.ownerIdentityId, f.profile.ownerIdentityId],
    },
    { deliveryMode: 'host' },
    { deliveryMode: 'vm' },
    { deliveryMode: 'resume' },
  ])
    fault(() =>
      C.parseOwnerAssignmentPolicy({
        ...f.policy,
        assignmentPolicy: { ...selected, ...extra },
      }),
    )
  fault(() =>
    C.parseOwnerAssignmentPolicy({
      ...f.policy,
      expiresAt: '2026-10-12T12:30:00.000Z',
    }),
  )
  fault(() =>
    C.parseOwnerAssignmentPolicy({ ...f.policy, coordinatorIdentityId: null }),
  )
  fault(() => C.parseOwnerAssignmentPolicy({ ...f.policy, projectIds: [] }))
  fault(() =>
    C.parseOwnerAssignmentPolicy({
      ...f.policy,
      ancestors: [
        {
          policyId: f.policy.policyId,
          revisionId: 'old',
          digest: 'a'.repeat(64),
        },
      ],
    }),
  )
})
test('assignment request denies supplied context env caller authority and invalid instruction bytes', async () => {
  const f = await fixture()
  for (const extra of [
    { context: ['issue-input'] },
    { context: null },
    { env: {} },
    { launchAuthority: true },
    { instruction: '\ud800' },
    { instruction: '😀'.repeat(4097) },
    { deliveryMode: 'vm' },
  ])
    fault(() =>
      C.parseAgentAssignmentInput(
        { ...f.request, ...extra },
        f.policy.revisionId,
      ),
    )
  const { context: _, ...omitted } = f.request
  fault(() => C.parseAgentAssignmentInput(omitted, f.policy.revisionId))
})
const relationships: [
  string,
  (f: Awaited<ReturnType<typeof fixture>>) => void,
][] = [
  [
    'requester',
    (f) => {
      f.task.requesterIdentityId = f.profile.ownerIdentityId
    },
  ],
  [
    'owner',
    (f) => {
      f.task.ownerIdentityId = coordinator
      f.task.readerIdentityIds = [coordinator, f.profile.agentIdentityId].sort()
    },
  ],
  [
    'target',
    (f) => {
      f.request.targetAgentIdentityId = coordinator
    },
  ],
  [
    'project',
    (f) => {
      f.task.projectId = 'other'
      f.request.projectId = 'other'
    },
  ],
  [
    'mode',
    (f) => {
      f.request.deliveryMode = 'piped'
      f.task.deliveryMode = 'piped'
    },
  ],
  [
    'instruction',
    (f) => {
      f.task.instruction = 'Different actual bytes.'
    },
  ],
  [
    'profile',
    (f) => {
      f.request.profileRevisionId = 'other'
      f.task.profileRevisionId = 'other'
    },
  ],
  [
    'source-id',
    (f) => {
      f.task.sourcePolicyId = 'other'
      f.receipt.sourcePolicyId = 'other'
    },
  ],
  [
    'source-revision',
    (f) => {
      f.task.sourcePolicyRevisionId = 'other'
      f.receipt.sourcePolicyRevisionId = 'other'
    },
  ],
  [
    'source-digest',
    (f) => {
      f.task.sourcePolicyDigest = 'b'.repeat(64)
      f.receipt.sourcePolicyDigest = 'b'.repeat(64)
    },
  ],
  [
    'consent',
    (f) => {
      f.task.ownerConsentRevisionId = 'other'
    },
  ],
  [
    'creation',
    (f) => {
      f.task.createdAt = '2026-10-12T11:59:00.000Z'
    },
  ],
  [
    'expiry',
    (f) => {
      f.task.expiresAt = '2026-10-12T14:00:00.000Z'
    },
  ],
  [
    'audience',
    (f) => {
      f.task.readerIdentityIds = [
        ...f.task.readerIdentityIds,
        coordinator,
      ].sort()
    },
  ],
  [
    'grant',
    (f) => {
      f.receipt.grantId = 'other'
    },
  ],
  [
    'grant-revision',
    (f) => {
      f.receipt.grantRevisionId = 'other'
    },
  ],
  [
    'task-digest',
    (f) => {
      f.receipt.taskDigest = 'b'.repeat(64)
    },
  ],
  [
    'task-id',
    (f) => {
      f.receipt.taskId = 'other'
    },
  ],
  [
    'task-revision',
    (f) => {
      f.receipt.taskRevisionId = 'other'
    },
  ],
  [
    'request-id',
    (f) => {
      f.receipt.assignmentRequestId = 'other'
    },
  ],
]
for (const [name, mutate] of relationships)
  test('assignment relationship rejects ' + name, async () => {
    const f = await fixture()
    mutate(f)
    // Preserve unrelated task hash so each negative checks its selected binding.
    if (name !== 'task-digest')
      f.receipt.taskDigest = await canonicalDigest(f.task)
    await rejected(() =>
      C.verifyAgentAssignmentArtifacts(f.task, f.policy, f.request, f.receipt),
    )
  })
test('assignment profile verifier binds full persona identity revision digest and project', async () => {
  const f = await fixture()
  for (const mutate of [
    (p: typeof f.profile) => {
      p.persona.instructions += 'changed'
    },
    (p: typeof f.profile) => {
      p.agentIdentityId = coordinator
    },
    (p: typeof f.profile) => {
      p.ownerIdentityId = coordinator
    },
    (p: typeof f.profile) => {
      p.revisionId = 'other'
    },
    (p: typeof f.profile) => {
      p.desiredControls.filesystem.readProjectIds = []
    },
  ]) {
    const profile = structuredClone(f.profile)
    mutate(profile)
    const policy = structuredClone(f.policy)
    // Re-hash changes except persona to isolate identity/revision/project guards.
    if (profile.persona.instructions === f.profile.persona.instructions)
      policy.profileDigest = await canonicalDigest(profile)
    await rejected(() => C.verifyOwnerAssignmentPolicyProfile(policy, profile))
  }
})
test('assignment preserves raw806 profile canonical1069 ECC and old v1 rejects2', async () => {
  expect(frozen.byteLength).toBe(806)
  const profile = C.parseProfileRevision(JSON.parse(frozen.toString()))
  expect(Buffer.from(canonicalBytes(profile))).toEqual(frozen)
  expect(await canonicalDigest(profile)).toBe(
    '5d305adee182d62eed11d5a68ba41892739ce29c65e7647f49ffa2b62b95e024',
  )
  const manifest = C.parseSkillManifest(
    JSON.parse(
      readFileSync(
        'scripts/fixtures/skills/ecc-verification-loop.manifest.json',
        'utf8',
      ),
    ),
  )
  expect(canonicalBytes(manifest).byteLength).toBe(1069)
  expect(await canonicalDigest(manifest)).toBe(
    '8642aec70aefee472151de8b27fc97a08ff9bb85bf927fb69afc53a4ae499d6c',
  )
  for (const parse of [
    C.parseProfileRevision,
    C.parseRunSnapshot,
    C.parseRuntimeSupportReport,
  ])
    fault(() => parse({ contractVersion: 2 }), 'CONTRACT_UNSUPPORTED', 422)
})
