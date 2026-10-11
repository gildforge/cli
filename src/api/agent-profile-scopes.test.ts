import { expect, test } from 'bun:test'
import {
  AGENT_PROFILE_SCOPES,
  hasAgentProfileScope,
} from './agent-profile-scopes'
import { SCOPES, grantScopes, hasScope, type Principal } from './scopes'

function principal(
  scopes: readonly string[] | null,
  anonymous = false,
): Principal {
  return {
    id: 'fixture',
    name: 'fixture',
    publicKey: 'fixture-key',
    scopes,
    repos: null,
    anonymous,
  }
}
test('generated feature scope check refuses implicit legacy and anonymous authority', () => {
  for (const scope of AGENT_PROFILE_SCOPES) {
    expect(hasAgentProfileScope(principal([scope]), scope)).toBe(true)
    for (const scopes of [
      null,
      [],
      ['*'],
      ['agents'],
      ['admin'],
      ['repo:write'],
    ])
      expect(hasAgentProfileScope(principal(scopes), scope)).toBe(false)
    expect(hasAgentProfileScope(principal([scope], true), scope)).toBe(false)
  }
  expect(
    hasAgentProfileScope(principal(['agent:profile']), 'agent:execute'),
  ).toBe(false)
})
test('minimal feature artifact preserves existing grant and legacy scope semantics', () => {
  expect(grantScopes([])).toEqual(['repo:read'])
  expect(grantScopes(['review'])).toEqual(['repo:read', 'pulls:write'])
  expect(grantScopes(['pr'])).toEqual([
    'repo:read',
    'repo:write',
    'issues:write',
    'pulls:write',
  ])
  expect(hasScope(principal(null), 'repo:read')).toBe(true)
  expect(SCOPES).not.toContain('agent:profile')
  expect(SCOPES).not.toContain('agent:request')
  expect(SCOPES).not.toContain('agent:execute')
  expect(SCOPES).not.toContain('agent:result')
})
