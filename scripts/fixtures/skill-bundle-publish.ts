// Owned-process fault injection around the actual native directory publication.
import { mock } from 'bun:test'
import * as fs from 'node:fs'
const actual = { ...fs }
let publishingFd = -1
const mode = process.argv[4]
mock.module('node:fs', () => ({
  ...actual,
  fsyncSync(fd: number) {
    if (mode === 'after' && fd === publishingFd)
      process.kill(process.pid, 'SIGKILL')
    actual.fsyncSync(fd)
  },
}))
const { AnchoredDirectory } = await import('../../src/isolation/anchored-fs')
const publish = AnchoredDirectory.prototype.publishDirectory
const put = AnchoredDirectory.prototype.putRegularIfAbsent
AnchoredDirectory.prototype.putRegularIfAbsent = function (name, data) {
  const result = put.call(this, name, data)
  if (mode === 'corrupt' && name === 'SKILL.md') {
    const bad = Buffer.from(data)
    bad[0] ^= 1
    this.put(
      name,
      { p: name, k: 'f', m: 0o600, s: bad.length, h: 'owned-fixture' },
      bad,
    )
  }
  return result
}
AnchoredDirectory.prototype.publishDirectory = function (stage, name) {
  if (mode === 'before') process.kill(process.pid, 'SIGKILL')
  publishingFd = this.fd
  return publish.call(this, stage, name)
}
const { SkillBundleCache } = await import('../../src/skills/bundle-cache')
const { skillManifestIdentity } =
  await import('../../src/api/agent-profile-contract')
const manifest = JSON.parse(
  actual.readFileSync(
    'scripts/fixtures/skills/ecc-verification-loop.manifest.json',
    'utf8',
  ),
)
const pin = await skillManifestIdentity(manifest)
const cache = new SkillBundleCache(process.argv[2])
try {
  await cache.store(
    {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    },
    manifest,
    process.argv[3],
  )
  if (mode !== 'normal') throw new Error('interruption hook did not run')
  console.log(pin.bundleDigest)
} finally {
  cache.close()
}
