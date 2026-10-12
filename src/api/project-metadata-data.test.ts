import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalBytes, canonicalDigest } from './agent-profile-canonical'
// Temporary-copy removals preserve tracked canonical output byte parity.
const C: typeof import('./agent-profile-contract') = await import(
  process.env.TEST_GILD_PROJECT_METADATA_CONTRACT ??
    resolve('src/api/agent-profile-contract.ts')
)
const resolved = (
  projectId = 'project-1',
  state: 'ready' | 'pending' | 'archived' = 'ready',
) => ({
  projectId,
  resolution: 'resolved' as const,
  repository: { owner: 'owner', name: 'Demo.repo' },
  state,
})
function fault(action: () => unknown) {
  let error: unknown
  try {
    action()
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(C.AgentProfileContractError)
  expect({
    code: (error as InstanceType<typeof C.AgentProfileContractError>).code,
    status: (error as InstanceType<typeof C.AgentProfileContractError>).status,
  }).toEqual({ code: 'VALIDATION_FAILED', status: 422 })
}

test('project listing metadata retains absent null and typed descriptor distinction', () => {
  expect(() => C.parseAgentRepoProjectMetadata({})).not.toThrow()
  expect(() =>
    C.parseAgentRepoProjectMetadata({ agentProject: null }),
  ).not.toThrow()
  expect(C.parseAgentRepoProjectMetadata({})).toEqual({})
  expect(C.parseAgentRepoProjectMetadata({ agentProject: null })).toEqual({
    agentProject: null,
  })
  for (const state of ['ready', 'pending', 'archived'] as const) {
    const r = resolved('project-1', state)
    expect(
      C.parseAgentRepoProjectMetadata({ agentProject: r }).agentProject,
    ).toEqual(r)
  }
  expect(
    C.parseAgentRepoProjectMetadata({
      agentProject: { projectId: 'retired-1', resolution: 'unresolved' },
    }).agentProject,
  ).toEqual({ projectId: 'retired-1', resolution: 'unresolved' })
  fault(() => C.parseAgentRepoProjectMetadata({ agentProject: undefined }))
  fault(() =>
    C.parseAgentRepoProjectMetadata({
      agentProject: resolved(),
      canWrite: true,
    }),
  )
})
test('project profile metadata is optional array with empty allowed but null forbidden', () => {
  expect(() => C.parseAgentProfileProjectMetadata({})).not.toThrow()
  expect(C.parseAgentProfileProjectMetadata({})).toEqual({})
  expect(C.parseAgentProfileProjectMetadata({ projectReferences: [] })).toEqual(
    { projectReferences: [] },
  )
  const refs = [resolved('Project-1'), resolved('project-1', 'pending')]
  expect(
    C.parseAgentProfileProjectMetadata({ projectReferences: refs }),
  ).toEqual({ projectReferences: refs })
  for (const invalid of [null, undefined, {}, 'project-1'])
    fault(() =>
      C.parseAgentProfileProjectMetadata({ projectReferences: invalid }),
    )
})
test('project identifiers are opaque exact sorted unique and bounded references', () => {
  for (const id of [
    'project-1',
    'Project-1',
    '11111111-1111-4111-8111-111111111111',
  ])
    expect(C.parseAgentProjectReference(resolved(id)).projectId).toBe(id)
  for (const id of [
    'owner/repo',
    'owner%2Frepo',
    'reserve:stage',
    'café',
    'cafe\u0301',
    '',
    'x'.repeat(129),
  ])
    fault(() => C.parseAgentProjectReference(resolved(id)))
  fault(() =>
    C.parseAgentProfileProjectMetadata({
      projectReferences: [resolved('b'), resolved('a')],
    }),
  )
  fault(() =>
    C.parseAgentProfileProjectMetadata({
      projectReferences: [resolved('a'), resolved('a')],
    }),
  )
  const ids = Array.from({ length: 65 }, (_, i) => `project-${i}`).sort()
  fault(() =>
    C.parseAgentProfileProjectMetadata({
      projectReferences: ids.map((id) => resolved(id)),
    }),
  )
})
test('project unresolved branch forbids private details credentials and authority fields', () => {
  const base = { projectId: 'retired-1', resolution: 'unresolved' as const }
  expect(C.parseAgentProjectReference(base)).toEqual(base)
  for (const extra of [
    { repository: { owner: 'private', name: 'repo' } },
    { reason: 'private-lookup' },
    { settingsId: 'owner/repo' },
    { directory: '/machine/local' },
    { token: 'synthetic-only' },
    { runnable: true },
    { allowed: true },
  ])
    fault(() => C.parseAgentProjectReference({ ...base, ...extra }))
})
test('project resolved metadata validates display namespace state and strict fields', () => {
  for (const mutate of [
    (r: any) => {
      r.repository.owner = 'Owner'
    },
    (r: any) => {
      r.repository.name = 'path/repo'
    },
    (r: any) => {
      r.repository.name = 'café'
    },
    (r: any) => {
      r.state = 'running'
    },
    (r: any) => {
      r.repository.directory = '/private'
    },
    (r: any) => {
      r.permit = true
    },
  ]) {
    const r = resolved()
    mutate(r)
    fault(() => C.parseAgentProjectReference(r))
  }
  let calls = 0
  const getter = Object.defineProperty(resolved(), 'state', {
    enumerable: true,
    get() {
      calls++
      return 'ready'
    },
  })
  fault(() => C.parseAgentProjectReference(getter))
  expect(calls).toBe(0)
})
test('project selected-ID metadata leaves immutable profile and ECC pin vectors unchanged', async () => {
  const raw = readFileSync(
      'scripts/fixtures/skills/agent-profile-revision-v1.json',
    ),
    p = C.parseProfileRevision(JSON.parse(raw.toString()))
  const refs = p.desiredControls.filesystem.readProjectIds.map((id) =>
    resolved(id),
  )
  const metadata = C.parseAgentProfileProjectMetadata({
    projectReferences: refs,
  })
  expect(metadata.projectReferences!.map((r) => r.projectId)).toEqual(
    p.desiredControls.filesystem.readProjectIds,
  )
  expect(raw.length).toBe(806)
  expect(Buffer.from(canonicalBytes(p))).toEqual(raw)
  expect(await canonicalDigest(p)).toBe(
    '5d305adee182d62eed11d5a68ba41892739ce29c65e7647f49ffa2b62b95e024',
  )
  fault(() => C.parseProfileRevision({ ...p, ...metadata }))
  const manifest = JSON.parse(
      readFileSync(
        'scripts/fixtures/skills/ecc-verification-loop.manifest.json',
        'utf8',
      ),
    ),
    identity = await C.skillManifestIdentity(manifest)
  expect(canonicalBytes(identity.manifest).length).toBe(1069)
  expect(identity.bundleDigest).toBe(
    '8642aec70aefee472151de8b27fc97a08ff9bb85bf927fb69afc53a4ae499d6c',
  )
  expect(
    await C.verifySkillSelection(
      {
        pinId: identity.pinId,
        bundleDigest: identity.bundleDigest,
        entryDigest: identity.entryDigest,
      },
      manifest,
    ),
  ).toEqual({
    pinId: identity.pinId,
    bundleDigest: identity.bundleDigest,
    entryDigest: identity.entryDigest,
  })
  // Selection membership/caller ownership/registry incarnation are producer duties;
  // these standalone metadata parsers validate data only, with no live authority.
})
