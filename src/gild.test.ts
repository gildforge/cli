import { expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { signChallenge, verifyChallenge, fingerprint } from './gild'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const identity = {
  schema: 1 as const,
  name: null,
  device: 'test',
  publicKey: `ed25519:${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`,
  secretKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  createdAt: new Date().toISOString(),
}

test('a signed challenge verifies against the public key', () => {
  const signature = signChallenge(identity, 'gild-challenge-123')
  expect(verifyChallenge(identity.publicKey, 'gild-challenge-123', signature)).toBe(true)
})

test('a wrong challenge fails verification', () => {
  const signature = signChallenge(identity, 'gild-challenge-123')
  expect(verifyChallenge(identity.publicKey, 'gild-challenge-456', signature)).toBe(false)
})

test('a different key fails verification', () => {
  const other = generateKeyPairSync('ed25519')
  const otherPub = `ed25519:${other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`
  const signature = signChallenge(identity, 'gild-challenge-123')
  expect(verifyChallenge(otherPub, 'gild-challenge-123', signature)).toBe(false)
})

test('fingerprint is stable and short', () => {
  expect(fingerprint(identity.publicKey)).toBe(fingerprint(identity.publicKey))
  expect(fingerprint(identity.publicKey)).toHaveLength(16)
})
