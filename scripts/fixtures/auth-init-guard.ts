// Real interactive auth action. Generation is blocked before source import;
// PATH supplies an owned fake Git, and every network request is refused.
import { mock } from 'bun:test'
import * as originalCrypto from 'node:crypto'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.AUTH_FIXTURE_ROOT!
let keyGenerationAttempts = 0,
  networkAttempts = 0
const sentinel = new Error('Fixture forbids credential generation')
const generate = () => {
  keyGenerationAttempts++
  throw sentinel
}
mock.module('node:crypto', () => ({
  ...originalCrypto,
  generateKeyPairSync: generate,
}))
const guardedCrypto = await import('node:crypto')
if (guardedCrypto.generateKeyPairSync !== generate)
  throw Error('Generation guard is inactive')
try {
  guardedCrypto.generateKeyPairSync('ed25519')
} catch (error) {
  if (error !== sentinel) throw error
}
if (keyGenerationAttempts !== 1)
  throw Error('Generation guard preflight failed')
keyGenerationAttempts = 0
const gitMarker = join(root, 'git-attempts')
if (
  Bun.spawnSync(['git', '--version']).exitCode !== 73 ||
  !existsSync(gitMarker)
)
  throw Error('Owned Git guard preflight failed')
unlinkSync(gitMarker)
globalThis.fetch = (() => {
  networkAttempts++
  throw Error('Fixture forbids network')
}) as typeof fetch
process.on('exit', () =>
  writeFileSync(
    join(root, 'guard-result.json'),
    JSON.stringify({
      keyGenerationAttempts,
      networkAttempts,
      gitHelperInvoked: existsSync(gitMarker),
      identityWritten: existsSync(join(root, 'config/identity.json')),
      guardsVerified: true,
    }),
  ),
)
const { main } = await import('../../src/gild-main')
await main()
