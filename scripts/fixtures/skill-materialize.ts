// Owned-process failure/interruption fixtures over actual native materialization.
import { mock } from 'bun:test'
import * as fs from 'node:fs'
const actual = { ...fs }
const mode = process.argv[4]
let publishingFd = -1
mock.module('node:fs', () => ({
  ...actual,
  fsyncSync(fd: number) {
    if (mode === 'after' && fd === publishingFd)
      process.kill(process.pid, 'SIGKILL')
    actual.fsyncSync(fd)
  },
}))
const { AnchoredDirectory } = await import('../../src/isolation/anchored-fs')
const publish = AnchoredDirectory.prototype.publishDirectory,
  put = AnchoredDirectory.prototype.putRegularIfAbsent
AnchoredDirectory.prototype.publishDirectory = function (stage, name) {
  if (name === 'selected-skill') {
    if (mode === 'before') process.kill(process.pid, 'SIGKILL')
    publishingFd = this.fd
  }
  return publish.call(this, stage, name)
}
AnchoredDirectory.prototype.putRegularIfAbsent = function (name, bytes) {
  const result = put.call(this, name, bytes)
  if (mode === 'corrupt' && name === 'SKILL.md') {
    const bad = Buffer.from(bytes)
    bad[0] ^= 1
    this.put(
      name,
      { p: name, k: 'f', m: 0o600, s: bad.length, h: 'owned-fixture' },
      bad,
    )
  }
  return result
}
const { SkillBundleCache } = await import('../../src/skills/bundle-cache')
const { materializeSkillBundle } = await import('../../src/skills/materialize')
const { skillManifestIdentity } =
  await import('../../src/api/agent-profile-contract')
const manifest = JSON.parse(
  actual.readFileSync(
    'scripts/fixtures/skills/ecc-verification-loop.manifest.json',
    'utf8',
  ),
)
const pin = await skillManifestIdentity(manifest),
  cache = new SkillBundleCache(process.argv[2])
try {
  const handle = await materializeSkillBundle(
    cache,
    {
      pinId: pin.pinId,
      bundleDigest: pin.bundleDigest,
      entryDigest: pin.entryDigest,
    },
    manifest,
    process.argv[3],
  )
  try {
    if (mode !== 'normal')
      throw Error('interruption/corruption hook did not refuse selection')
    console.log(handle.read().selection.bundleDigest)
  } finally {
    handle.close()
  }
} finally {
  cache.close()
}
