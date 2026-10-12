# Physical inventory and private bundle cache — CLI #70

This slice follows cleared CLI checkpoint `505cd504` and consumes only the
delivered canonical website `665af2a` manifest/selection/digest helpers. Generated
artifacts, legacy scopes, package version 0.6.9 and release workflow are unchanged.
It remains content preparation with no profile/run authority, prompt delivery,
API policy routes or runtime enforcement.

`readSkillInventory` enumerates each opened directory through native directory
streams and compares its complete entry set against the declared tree, before
and after reads. It rejects extra files, empty/undeclared directories, special
entries, missing files, byte size/digest failures, root/ancestor/leaf symlinks,
hard links and case/normalized path aliases. Directories are opened relative to
their parents; names and type checks do not rely on a pathname scan or dirent
type hint. Only copied, individually verified buffers are returned. Canonical
file descriptors still pass the existing portable path, 128-file, 10MiB/file
and 64MiB-total limits; physical trees additionally cap 64 directory levels and
4096 nodes. These are explicit local capacity limits, not shared schema changes.

`SkillBundleCache` uses the agreed `sha256/<bundleDigest>` address. Ava confirmed
that internal disk filenames/serialization are not a shared cross-runtime rule.
The private CLI layout is:

```
<private-owned-root>/sha256/<bundleDigest>/
  manifest.json       # exact generated canonicalBytes(manifest), no newline
  files/<declared relative paths>
```

The metadata directory must contain exactly `manifest.json` and `files`; the
files tree must contain exactly the manifest's files and implicit directories.
The original license and assets are included and verified. Locked reads require
the caller's exact immutable selection/manifest, compare stored manifest bytes
with the canonical bytes, and recheck every file/inventory. Missing/corrupt,
extra, aliased or unsafe content fails without fetch, repair or current-content
fallback. Locked refers to the immutable pin, not a live execution grant or an
interoperable advisory-lock protocol.

Store reads and verifies the entire physical source before writing cache data.
It stages copied content under an exclusive private `.gild-bundle-<random>`
directory, with 0700 directories and 0600 files, rechecks the staged tree, and
publishes the directory by atomic exclusive rename. An existing digest object
is reverified and never overwritten, even when incomplete/corrupt. Concurrent
publishers reverify the winner. Unpublished stages, including interrupted or
losing stages, remain private and are never selected based on their name;
there is no automatic pruning or remnant recovery. Owner cleanup is separate.

Native directory enumeration uses the supported 64-bit Darwin INODE64/glibc
dirent layouts, bounded record lengths and a fresh directory stream for each
enumeration. The macOS SDK headers were checked directly; Linux semantics are
documented by [readdir](https://man7.org/linux/man-pages/man3/readdir.3.html) and
[fdopendir](https://man7.org/linux/man-pages/man3/opendir.3.html). Publication
reuses platform exclusive rename; [Linux RENAME_NOREPLACE](https://man7.org/linux/man-pages/man2/renameat2.2.html)
requires filesystem support and has no fallback here. Bun FFI/platform execution
still requires exact-head native CI. No power-loss durability or isolation from
malicious same-OS-user mutation is claimed. Repeated inventory checks and copied
verified buffers do not establish an adversarial filesystem snapshot.

Lightweight Intel evidence: 15 new tests / 65 assertions, including actual native
inventory and directory publication, complete license/nested assets, corrupt
stage injection, retained pre-publication interruption, post-syscall SIGKILL
before parent-directory fsync, root replacement and two owned publishing
processes. Combined byte/native/consumer/client/event checks: 88 pass / 0 fail /
372 assertions across 9 files, 6.91 seconds. Typecheck, format and diff checks pass.

`node scripts/bundle-cache-revert.mjs` produces six actual assertion failures
when complete inventory, file digest, directory no-follow, manifest lock,
staged recheck or exclusive publication is removed. Sources restore after each
proof; positive tests pass afterward. The ten byte-layer and four consumer
removals also pass; the older file-publication mutations are now scoped to that
method so the new directory publisher cannot intercept them. Ledgers and logs
are under `.tmp/`. Existing macOS native gates include the new bundle suite;
Linux already runs all tests. Hosted CI at the new source head is pending and
Ava owns its watcher. Prior 505cd504 clearance does not clear this new source.

This private cache is not a VM/container materialization protocol. Full
profile/control/support/task/claim/continuation/audience schemas/routes,
actual skill delivery and runtime enforcement remain pending. PR71 stays draft
held; no merge, release, deployment, provider call, global install, credential,
scope issuance or authority upgrade. Website retains local heavy-test slots.

-codex
